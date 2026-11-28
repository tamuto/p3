import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetricStore } from "../packages/observer/src/core/metricStore.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { SYSTEM_KEYS } from "../packages/observer/src/shared/metric.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3, snapshot } from "./cliHelpers.ts";

/**
 * 観測の項目キーと値（docs/architecture.md「p3-observer」）: 項目キーを先に登録し、4 つの形の値を足す・消す。何を実行して得たかは受け取らず、
 * 目安は並べて見せるだけ（判定しない）。システムの項目（p3.）は人が作る・変える・値を足す・消すことはできない。CLI・API が同じ検証を通る
 */
const store = () => new MetricStore(tempDir("p3-obs-"));

describe("項目キー", () => {
  it("登録・変更・削除。重複・不正な文字・予約の接頭辞は理由付きで断り、システムの項目は値が無くても一覧に出る", async () => {
    const s = store();
    const k = await s.createKey({ key: "cost.ai", name: "AI の費用", type: "number", unit: "円", guide: { max: "50000" } }, "human:a");
    expect(k).toMatchObject({ key: "cost.ai", rev: 1, guide: { max: 50000 }, createdBy: "human:a" });
    for (const [input, path] of [
      [{ key: "cost.ai", name: "x", type: "number" }, "key"],
      [{ key: "Cost", name: "x", type: "number" }, "key"],
      [{ key: ".hidden", name: "x", type: "number" }, "key"],
      [{ key: "p3.mine", name: "x", type: "number" }, "key"],
      [{ key: "new", name: "x", type: "number" }, "key"],
      [{ key: "ok", name: "", type: "number" }, "name"],
      [{ key: "ok", name: "x", type: "date" }, "type"],
      [{ key: "ok", name: "x", type: "json", guide: { expected: "a" } }, "guide"],
      [{ key: "ok", name: "x", type: "number", guide: { min: 5, max: 1 } }, "guide"],
      [{ key: "ok", name: "x", type: "boolean", guide: { expected: "maybe" } }, "guide.expected"],
    ] as const) {
      await expect(s.createKey(input, "h"), JSON.stringify(input)).rejects.toMatchObject({ code: "invalid", problems: [expect.objectContaining({ path })] });
    }
    const list = await s.list();
    expect(list.keys.map((x) => x.key)).toEqual([...SYSTEM_KEYS.map((x) => x.key), "cost.ai"]);
    expect(list.keys[0]).toMatchObject({ system: true, count: 0 });

    const changed = await s.updateKey("cost.ai", 1, { name: "AI の利用料", type: "number", guide: { min: 0 } }, "human:b");
    expect(changed).toMatchObject({ rev: 2, name: "AI の利用料", guide: { min: 0 }, createdBy: "human:a", updatedBy: "human:b" });
    expect(changed.unit).toBeUndefined();
    await expect(s.updateKey("cost.ai", 1, { name: "古い版", type: "number" }, "h")).rejects.toMatchObject({ code: "conflict", current: expect.objectContaining({ rev: 2 }) });
    await s.deleteKey("cost.ai", 2);
    await expect(s.get("cost.ai")).rejects.toMatchObject({ code: "not_found" });
  });

  it("カードに出す数（合計・平均・最後の値）を項目キーに持ち、一覧のカードの数と推移を絞った値で出す。数値以外は最後の値だけ", async () => {
    const s = store();
    await s.createKey({ key: "cost.ai", name: "費用", type: "number", aggregate: "sum" }, "h");
    await s.createKey({ key: "build.ms", name: "ビルド", type: "number", aggregate: "avg" }, "h");
    await s.createKey({ key: "note", name: "メモ", type: "string" }, "h");
    await expect(s.createKey({ key: "bad", name: "x", type: "string", aggregate: "sum" }, "h")).rejects.toMatchObject({ problems: [expect.objectContaining({ path: "aggregate" })] });
    await expect(s.createKey({ key: "bad", name: "x", type: "number", aggregate: "max" }, "h")).rejects.toMatchObject({ problems: [expect.objectContaining({ path: "aggregate" })] });
    for (const [v, at, m] of [[100, "2026-11-01", "v1"], [200, "2026-11-02", "v1"], [50, "2026-11-03", "v2"]] as const) {
      await s.addValue("cost.ai", { value: v, at, milestone: m }, "h");
      await s.addValue("build.ms", { value: v, at, milestone: m }, "h");
    }
    await s.addValue("note", { value: "最初" }, "h");
    const card = async (m?: string) => Object.fromEntries((await s.list(m)).keys.filter((k) => !k.system).map((k) => [k.key, [k.card, k.series?.map((p) => p.value)]]));
    // 合計の推移は累計、平均・最後の値の推移は値そのもの
    expect(await card()).toEqual({ "cost.ai": [350, [100, 300, 350]], "build.ms": [116.67, [100, 200, 50]], note: ["最初", undefined] });
    expect(await card("v1")).toEqual({ "cost.ai": [300, [100, 300]], "build.ms": [150, [100, 200]], note: [undefined, undefined] });
    // last は保存しない（既定）。システムの項目は既定を持つ
    const k = await s.updateKey("cost.ai", 1, { name: "費用", type: "number", aggregate: "last" }, "h");
    expect(k.aggregate).toBeUndefined();
    expect((await card())["cost.ai"][0]).toBe(50);
    expect(SYSTEM_KEYS.map((x) => [x.key, x.aggregate])).toContainEqual(["p3.request.lead_time_done", "avg"]);
    expect(SYSTEM_KEYS.filter((x) => x.key.startsWith("p3.task.")).every((x) => x.aggregate === "sum")).toBe(true);
  });

  it("値があるあいだは値の形を変えられず、キーを消せない（先に値を消す）", async () => {
    const s = store();
    await s.createKey({ key: "ok", name: "x", type: "number" }, "h");
    const v = await s.addValue("ok", { value: 1 }, "h");
    await expect(s.updateKey("ok", 1, { name: "x", type: "string" }, "h")).rejects.toMatchObject({ code: "in_use" });
    await expect(s.deleteKey("ok", 1)).rejects.toMatchObject({ code: "in_use" });
    // 形を変えない変更はできる
    await s.updateKey("ok", 1, { name: "y", type: "number" }, "h");
    await s.deleteValue("ok", v.id);
    await s.deleteKey("ok", 2);
  });

  it("システムの項目は作る・変える・消す・値を足す・消すのどれもできない", async () => {
    const s = store();
    const key = "p3.task.rework";
    await expect(s.updateKey(key, 0, { name: "x", type: "number" }, "h")).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.deleteKey(key, 0)).rejects.toMatchObject({ code: "forbidden" });
    await expect(s.addValue(key, { value: 1 }, "h")).rejects.toMatchObject({ code: "forbidden" });
    await s.recordSystem(key, { value: 1, target: "r/T001" });
    await expect(s.deleteValue(key, "V1")).rejects.toMatchObject({ code: "forbidden" });
    expect((await s.get(key)).values).toEqual([expect.objectContaining({ id: "V1", value: 1, target: "r/T001", by: "p3" })]);
  });
});

describe("値", () => {
  it("4 つの形を受け付け、形の違う値・未登録のキーは理由付きで断る。付けられるのは時点・対象・マイルストーン・メモだけ", async () => {
    const s = store();
    for (const [key, type, ok, bad] of [
      ["n", "number", 3.5, "3.5"],
      ["s", "string", "緑", 1],
      ["b", "boolean", true, "true"],
      ["j", "json", { p95: 820, ok: [1] }, "{}"],
    ] as const) {
      await s.createKey({ key, name: key, type }, "h");
      expect((await s.addValue(key, { value: ok, command: "pnpm test" }, "ci")).value).toEqual(ok);
      await expect(s.addValue(key, { value: bad }, "h")).rejects.toMatchObject({ code: "invalid", problems: [expect.objectContaining({ path: "value" })] });
    }
    await expect(s.addValue("none", { value: 1 }, "h")).rejects.toMatchObject({ code: "not_found" });
    // 何を実行したか（command など）は保存しない
    const v = await s.addValue("n", { value: 9, at: "2026-11-30", target: "261128-c7z79", milestone: "0.18.0", note: "月末" }, "human:a");
    expect(v).toEqual({ id: "V2", at: "2026-11-30T00:00:00.000Z", value: 9, target: "261128-c7z79", milestone: "0.18.0", note: "月末", by: "human:a", recordedAt: expect.any(String) });
    expect(JSON.stringify((await s.get("n")).values)).not.toContain("pnpm test");
    await expect(s.addValue("n", { value: 1, at: "来月" }, "h")).rejects.toMatchObject({ problems: [expect.objectContaining({ path: "at" })] });
  });

  it("新しい順に返し、マイルストーンで絞る。消した番号は使い直さない", async () => {
    const s = store();
    await s.createKey({ key: "n", name: "n", type: "number" }, "h");
    await s.addValue("n", { value: 1, at: "2026-11-01", milestone: "a" }, "h");
    await s.addValue("n", { value: 2, at: "2026-11-03", milestone: "b" }, "h");
    await s.addValue("n", { value: 3, at: "2026-11-02", milestone: "a" }, "h");
    expect((await s.get("n")).values.map((v) => v.value)).toEqual([2, 3, 1]);
    expect((await s.get("n", "a")).values.map((v) => v.value)).toEqual([3, 1]);
    const l = await s.list("a");
    expect(l.milestones).toEqual(["a", "b"]);
    expect(l.keys.find((k) => k.key === "n")).toMatchObject({ count: 2, latest: expect.objectContaining({ value: 3 }) });
    await s.deleteValue("n", "V3");
    expect((await s.addValue("n", { value: 4 }, "h")).id).toBe("V4");
  });

  it("システムの値は once のとき同じ対象で1回だけ。読めない値のファイルは上書きしない", async () => {
    const s = store();
    expect(await s.recordSystem("p3.request.lead_time_done", { value: 5, target: "r1" }, { once: true })).toBeDefined();
    expect(await s.recordSystem("p3.request.lead_time_done", { value: 9, target: "r1" }, { once: true })).toBeUndefined();
    expect((await s.get("p3.request.lead_time_done")).values).toHaveLength(1);
    const file = join(s.dir, "values", "p3.task.rework.json");
    mkdirSync(join(s.dir, "values"), { recursive: true });
    writeFileSync(file, "{ 壊れた");
    await expect(s.recordSystem("p3.task.rework", { value: 1, target: "r/T1" })).rejects.toMatchObject({ code: "unreadable" });
    expect(readFileSync(file, "utf8")).toBe("{ 壊れた");
    const l = await s.list();
    expect(l.unreadable).toEqual([expect.objectContaining({ file: "values/p3.task.rework.json" })]);
  });
});

describe("API と CLI", () => {
  it("API は同じ検証で、入力の誤りは 400 の problems、システムの項目は 403、版の競合は 409", async () => {
    const app = observerRoutes({ target: { dataDir: tempDir("p3-obs-api-") } });
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await send("POST", "/keys", { key: "x", name: "", type: "number" })).status).toBe(400);
    expect((await send("POST", "/keys", { key: "x", name: "X", type: "number" })).status).toBe(201);
    expect((await send("POST", "/keys/x/values", { value: "1" })).status).toBe(400);
    expect((await send("POST", "/keys/x/values", { value: 1 })).status).toBe(201);
    expect((await send("POST", "/keys/p3.task.rework/values", { value: 1 })).status).toBe(403);
    expect((await send("PUT", "/keys/x", { rev: 9, name: "Y", type: "number" })).status).toBe(409);
    expect((await send("DELETE", "/keys/x?rev=1")).status).toBe(409);
    const got = (await (await send("GET", "/keys/x")).json()) as { values: unknown[] };
    expect(got.values).toHaveLength(1);
    expect((await send("DELETE", "/keys/x/values/V1")).status).toBe(200);
    expect((await send("DELETE", "/keys/x?rev=1")).status).toBe(200);
  });

  it("CLI で項目キーを登録して値を足し、show・list で見え、observer/metrics/ だけを書く", async () => {
    const { root } = await initialized();
    const before = snapshot(`${root}/.p3`);
    const add = p3(root, ["observer", "key", "add", "cost.ai", "--name", "AI の費用", "--type", "number", "--unit", "円", "--max", "50000", "--json"]);
    expect(add.code, add.err).toBe(0);
    expect(p3(root, ["observer", "value", "add", "cost.ai", "12000", "--at", "2026-11-30", "--milestone", "0.18.0", "--json"]).code).toBe(0);
    expect(p3(root, ["observer", "value", "add", "cost.ai", "高い"]).code).toBe(1);
    expect(p3(root, ["observer", "key", "set", "cost.ai", "--rev", "9", "--name", "x"]).code).toBe(3);
    expect(p3(root, ["observer", "value", "add", "p3.task.rework", "1"]).code).toBe(1);
    const shown = p3(root, ["observer", "show", "cost.ai", "--json"]).json();
    expect(shown.values).toEqual([expect.objectContaining({ value: 12000, milestone: "0.18.0" })]);
    const text = p3(root, ["observer", "show", "cost.ai"]).out;
    expect(text).toContain("目安    50000 円 以下（並べて見せるだけで、判定はしません）");
    expect(p3(root, ["observer", "list", "--milestone", "0.18.0", "--json"]).json().keys.find((k: { key: string }) => k.key === "cost.ai").count).toBe(1);
    expect(p3(root, ["observer", "key", "set", "cost.ai", "--rev", "1", "--aggregate", "sum"]).code).toBe(0);
    expect(p3(root, ["observer", "key", "set", "cost.ai", "--rev", "2", "--aggregate", "max"]).code).toBe(1);
    expect(p3(root, ["observer", "list"]).out).toContain("AI の費用  合計 12000 円");
    // tasks のデータは変えない（増えたのは observer/metrics/ だけ）
    const after = snapshot(`${root}/.p3`);
    expect(Object.keys(after).filter((f) => !(f in before)).every((f) => f.startsWith("/observer/metrics/"))).toBe(true);
    for (const f of Object.keys(before)) expect(after[f]).toBe(before[f]);
  });
});
