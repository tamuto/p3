import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionStore } from "../packages/observer/src/core/definitionStore.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測の期待の履歴と終了（docs/architecture.md「p3-observer」の期待の履歴と作業の帰属）: 作成・期待の変更・終了が履歴に残り、手順だけの編集では
 * 残らない・古い形を履歴なしで読む・同時の更新で履歴が重ならない・終了の決まり・CLI の作業の文脈と API の作業の文脈のヘッダー
 */
const obs = (extra: Record<string, unknown> = {}) => ({ title: "一覧の表示", description: "一覧が出るか", ...extra });
const run = { kind: "ai-instruction", target: "一覧", steps: ["開く"], judge: "出る", record: "なし" };

describe("期待の履歴", () => {
  it("作成・期待の変更を履歴に残し、手順だけの編集では残さない。古い形（形の版 3）は履歴なしで読む", async () => {
    const dataDir = tempDir("p3-obs-hist-");
    const store = new DefinitionStore(dataDir);
    const bare = await store.create(obs(), "a");
    expect(bare.history).toEqual([{ kind: "created", at: expect.any(String), by: "a" }]);
    const d = await store.create(obs({ expected: "1秒以内に出る" }), "ai:x", { work: { request: "261121-aaaaa", task: "T001" } });
    expect(d.history).toEqual([{ kind: "created", at: expect.any(String), by: "ai:x", expected: "1秒以内に出る", work: { request: "261121-aaaaa", task: "T001" } }]);
    const p = await store.update(d.id, 1, obs({ expected: "1秒以内に出る", procedures: [{ title: "開く", run }] }), "b", { reason: "手順だけ" });
    expect(p.history).toHaveLength(1);
    const e = await store.update(d.id, 2, obs({ expected: "0.5秒以内に出る", procedures: p.procedures }), "c", { reason: "速さの要求が上がった" });
    expect(e.history?.[1]).toEqual({ kind: "expected", at: expect.any(String), by: "c", reason: "速さの要求が上がった", expected: "0.5秒以内に出る", before: "1秒以内に出る" });
    const cleared = await store.update(d.id, 3, obs({ procedures: p.procedures }), "c");
    expect(cleared.history?.[2]).toMatchObject({ kind: "expected", before: "0.5秒以内に出る" });
    expect(cleared.history?.[2]).not.toHaveProperty("expected");
    // 入力から履歴は書けない
    await expect(store.update(d.id, 4, { ...obs(), history: [] }, "c")).rejects.toMatchObject({ code: "invalid", problems: [{ path: "history" }] });

    const file = join(dataDir, "observer", "definitions", `${bare.id}.json`);
    const { history: _h, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...old, format: 3 }));
    expect(await store.get(bare.id)).not.toHaveProperty("history");
    const u = await store.update(bare.id, 1, obs({ expected: "出る" }), "a");
    expect([JSON.parse(readFileSync(file, "utf8")).format, u.history?.map((h) => h.kind)]).toEqual([4, ["expected"]]);
  });

  it("同じ版を添えた2つの更新は片方だけ通り、履歴は1件だけ増える（再送も古い版で断る）", async () => {
    const store = new DefinitionStore(tempDir("p3-obs-hist-race-"));
    const d = await store.create(obs({ expected: "A" }), "a");
    const rs = await Promise.allSettled([store.update(d.id, 1, obs({ expected: "B" }), "a"), store.update(d.id, 1, obs({ expected: "C" }), "b")]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(store.update(d.id, 1, obs({ expected: "B" }), "a")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get(d.id)).history?.map((h) => h.kind)).toEqual(["created", "expected"]);
  });

  it("終了: 理由が要り、前提として使われていれば参照元を示して断る。終えた観測は読めるが直せず、新しく前提にできない", async () => {
    const store = new DefinitionStore(tempDir("p3-obs-end-"));
    const d = await store.create(obs({ expected: "出る", procedures: [{ title: "開く", run }] }), "a");
    const user = await store.create(obs({ title: "使う側", prerequisites: [d.id] }), "a");
    await expect(store.end(d.id, 1, {}, "a")).rejects.toMatchObject({ code: "invalid", problems: [{ path: "reason" }] });
    await expect(store.end(d.id, 1, { reason: "CI に移した" }, "a")).rejects.toMatchObject({ code: "in_use", message: expect.stringContaining(user.id) });
    await store.update(user.id, 1, obs({ title: "使う側" }), "a");
    const e = await store.end(d.id, 1, { reason: "機械的に判定できるようになった", movedTo: "GitHub Actions: ui-list" }, "b", { work: { request: "261121-aaaaa", task: "T002" } });
    expect(e.ended).toEqual({ at: expect.any(String), by: "b", reason: "機械的に判定できるようになった", movedTo: "GitHub Actions: ui-list" });
    expect(e.history?.at(-1)).toEqual({ kind: "ended", at: expect.any(String), by: "b", reason: "機械的に判定できるようになった", movedTo: "GitHub Actions: ui-list", work: { request: "261121-aaaaa", task: "T002" } });
    await expect(store.update(d.id, 2, obs(), "a")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("終了") });
    await expect(store.switchProcedure(d.id, 2, "P1", { evidence: "x" }, "a")).rejects.toMatchObject({ message: expect.stringContaining("終了") });
    await expect(store.end(d.id, 2, { reason: "もう一度" }, "a")).rejects.toMatchObject({ code: "invalid" });
    await expect(store.update(user.id, 2, obs({ title: "使う側", prerequisites: [d.id] }), "a")).rejects.toMatchObject({ problems: [{ path: "prerequisites[0]", message: expect.stringContaining("終了") }] });
    expect((await store.get(d.id)).history?.map((h) => h.kind)).toEqual(["created", "ended"]);
  });
});

describe("作業の帰属", () => {
  it("CLI: p3 move <T> doing で残した作業の文脈のときだけ、観測の操作に要望とタスクが残る。完了で消え、作業中でない・別のプロジェクトの文脈は付けない", async () => {
    const { root, rid } = await initialized();
    const j = (args: string[], env: Record<string, string> = {}) => {
      const r = p3(root, [...args, "--json"], env);
      expect(r.code, r.err).toBe(0);
      return r;
    };
    const plain = j(["observer", "add", "--title", "文脈なし", "--body", "x"]).json();
    expect(plain.history[0]).not.toHaveProperty("work");
    j(["new", "観測を足す", "--req", rid]);
    j(["move", "T001", "doing", "--req", rid]);
    const session = join(root, ".git", "p3-work.json");
    expect(JSON.parse(readFileSync(session, "utf8"))).toMatchObject({ ref: `${rid}/T001` });
    const d = j(["observer", "add", "--title", "作業で作る", "--body", "x", "--expected", "出る"]).json();
    expect(d.history[0].work).toEqual({ request: rid, task: "T001" });
    const u = j(["observer", "update", d.id, "--rev", "1", "--expected", "速く出る", "--reason", "要望で変えた"]).json();
    expect(u.history[1]).toMatchObject({ kind: "expected", reason: "要望で変えた", work: { request: rid, task: "T001" } });
    expect(p3(root, ["observer", "show", d.id]).out).toContain(`（${rid}/T001 の作業）: 要望で変えた  出る → 速く出る`);
    // 作業中でなくなった文脈（手で残っていても）は付けず、知らせる
    j(["move", "T001", "todo", "--req", rid]);
    expect(existsSync(session)).toBe(false);
    writeFileSync(session, JSON.stringify({ project: "app", dataDir: join(root, ".p3"), ref: `${rid}/T001`, at: "" }));
    const stale = j(["observer", "update", d.id, "--rev", "2", "--expected", "もっと速く"]);
    expect(stale.err).toContain("作業中ではありません");
    expect(stale.json().history[2]).not.toHaveProperty("work");
    writeFileSync(session, JSON.stringify({ project: "other", dataDir: tempDir("p3-other-"), ref: `${rid}/T001`, at: "" }));
    expect(j(["observer", "update", d.id, "--rev", "3", "--expected", "a"]).json().history[3]).not.toHaveProperty("work");
    // 終了にも残り、終えた観測の show に出る
    j(["move", "T001", "doing", "--req", rid]);
    const ended = j(["observer", "end", d.id, "--rev", "4", "--reason", "CI に移した", "--moved-to", "ci: list"]).json();
    expect(ended.history.at(-1)).toMatchObject({ kind: "ended", work: { request: rid, task: "T001" }, movedTo: "ci: list" });
    expect(p3(root, ["observer", "show", d.id]).out).toContain("終了");
    expect(p3(root, ["observer", "end", d.id, "--rev", "5", "--reason", "x"]).code).toBe(1);
  });

  it("API: 作業の文脈のヘッダーはアプリが確かめたときだけ残り、確かめられなければ断って何も変えない", async () => {
    const dataDir = tempDir("p3-obs-api-work-");
    const resolveWork = (ref: string) => (ref === "261121-aaaaa/T001" ? { ok: true as const, work: { request: "261121-aaaaa", task: "T001" } } : { ok: false as const, reason: `作業中ではありません: ${ref}` });
    const call = async (api: ReturnType<typeof observerRoutes>, method: string, path: string, body: unknown, work?: string) => {
      const res = await api.request(path, { method, headers: { "content-type": "application/json", ...(work ? { "x-p3-work": work } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const api = observerRoutes({ target: { project: "app", dataDir }, resolveWork });
    const made = await call(api, "POST", "/definitions", obs({ expected: "出る" }), "261121-aaaaa/T001");
    expect(made.body.history[0].work).toEqual({ request: "261121-aaaaa", task: "T001" });
    const bad = await call(api, "PUT", `/definitions/${made.body.id}`, { rev: 1, definition: obs({ expected: "変える" }), reason: "r" }, "261121-aaaaa/T009");
    expect([bad.status, bad.body.problems]).toEqual([400, [{ path: "work", message: expect.stringContaining("T009") }]]);
    const noResolver = await call(observerRoutes({ target: { project: "app", dataDir } }), "PUT", `/definitions/${made.body.id}`, { rev: 1, definition: obs() }, "261121-aaaaa/T001");
    expect(noResolver.status).toBe(400);
    const ok = await call(api, "PUT", `/definitions/${made.body.id}`, { rev: 1, definition: obs({ expected: "変える" }), reason: "r" });
    expect(ok.body.history.map((h: { kind: string; work?: unknown }) => [h.kind, !!h.work])).toEqual([["created", true], ["expected", false]]);
    const end = await call(api, "POST", `/definitions/${made.body.id}/end`, { rev: 2, reason: "移した", movedTo: "ci" }, "261121-aaaaa/T001");
    expect(end.body.ended).toMatchObject({ reason: "移した", movedTo: "ci" });
  });
});
