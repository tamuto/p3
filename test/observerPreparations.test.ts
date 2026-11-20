import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePreparationInput } from "../packages/observer/src/shared/preparation.ts";
import { PreparationStore } from "../packages/observer/src/core/definitionStore.ts";
import { fileChecker } from "../packages/observer/src/core/files.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 準備（docs/architecture.md「p3-observer」の準備）: 検証・1件1ファイルの保存（名前の重複・古い版・壊れたファイル）・
 * 確かめ・前処理・後処理の AI への指示からスクリプトへの切り替えと履歴・CLI（p3 observer prep）と API（/preparations）の往復。
 * 観測からの参照・削除は test/observerReferences.test.ts、画面は test/ui/observerPreparations.ui.test.ts
 */
const AI = (target: string) => ({ kind: "ai-instruction", target, steps: ["操作する"], judge: "期待どおり", record: "記録しない" });
const REP = (path: string) => ({ kind: "script", repo: "app", path, operation: "同じ操作", output: "終了コード", compare: "2回とも 0", switchWhen: "スクリプトで同じ結果", invoke: `node ${path}` });
const PREP = {
  name: "サインイン済みの利用者",
  description: "業務画面を開ける利用者を用意する",
  check: { run: AI("http://localhost:4310/health"), replacement: REP("scripts/check.mjs") },
  setup: { run: AI("利用者の画面"), replacement: REP("scripts/setup.mjs") },
  teardown: { run: AI("利用者の画面"), replacement: REP("scripts/teardown.mjs") },
  exclusive: ["account:demo"],
};

function store() {
  const repo = tempDir("p3-prep-repo-");
  const dataDir = tempDir("p3-prep-data-");
  return { repo, dataDir, store: new PreparationStore(dataDir, fileChecker((n) => (n === "app" ? repo : undefined))) };
}

describe("準備の検証と保存", () => {
  it("項目ごとの誤りを全部返す（名前・ID と同じ形の名前・占有の重複・実行方法・知らない項目）", () => {
    const r = validatePreparationInput({ name: " ", exclusive: ["a", "a"], setup: { run: { kind: "command" } }, check: "x", extra: 1 });
    expect(r.ok ? [] : r.problems.map((p) => p.path)).toEqual(expect.arrayContaining(["extra", "name", "exclusive[1]", "setup.run.command", "check"]));
    const idLike = validatePreparationInput({ name: "prep-261121-abcde" });
    expect(idLike.ok ? [] : idLike.problems).toEqual([{ path: "name", message: expect.stringContaining("ID と区別できない") }]);
    expect(validatePreparationInput({ name: " 名前 " })).toEqual({ ok: true, value: { name: "名前", exclusive: [] } });
  });

  it("1件1ファイル（ID・形の版・定義の版）で保存し、名前の重複・古い版・壊れたファイルの上書きを断る", async () => {
    const { dataDir, store: s } = store();
    const p = await s.create(PREP, "ai:test");
    expect(p).toMatchObject({ format: 1, rev: 1, id: expect.stringMatching(/^prep-\d{6}-[0-9a-z]{5}$/), createdBy: "ai:test", ...PREP });
    const file = join(dataDir, "observer", "preparations", `${p.id}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(p);
    await expect(s.create({ name: " サインイン済みの利用者 " }, "a")).rejects.toMatchObject({ code: "invalid", problems: [{ path: "name", message: expect.stringContaining(p.id) }] });
    const other = await s.create({ name: "別の準備" }, "a");
    await expect(s.update(other.id, 1, { name: PREP.name }, "a")).rejects.toMatchObject({ problems: [{ path: "name" }] });
    const u = await s.update(p.id, 1, { ...PREP, name: "改名した", exclusive: [] }, "human:b");
    expect(u).toMatchObject({ rev: 2, name: "改名した", exclusive: [], createdBy: "ai:test", updatedBy: "human:b" });
    await expect(s.update(p.id, 1, PREP, "a")).rejects.toMatchObject({ code: "conflict", current: expect.objectContaining({ rev: 2 }) });
    writeFileSync(file, JSON.stringify({ ...u, format: 9 }));
    expect((await s.list()).unreadable).toEqual([{ file: `${p.id}.json`, reason: expect.stringContaining("知らない形の版") }]);
    await expect(s.update(p.id, 2, PREP, "a")).rejects.toMatchObject({ code: "unreadable" });
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(9);
  });

  it("確かめ・前処理・後処理のそれぞれを、確かめたスクリプトに切り替え、呼び出し方・結果・前の実行方法を履歴に残す", async () => {
    const { repo, store: s } = store();
    let p = await s.create(PREP, "a");
    await expect(s.switchSlot(p.id, 1, "setup", { evidence: "0 で終わる" }, "b")).rejects.toMatchObject({ code: "invalid", problems: [{ path: "setup.replacement.path" }] });
    mkdirSync(join(repo, "scripts"));
    for (const slot of ["check", "setup", "teardown"] as const) {
      writeFileSync(join(repo, "scripts", `${slot}.mjs`), "");
      await expect(s.switchSlot(p.id, p.rev, slot, {}, "b")).rejects.toMatchObject({ problems: [{ path: "evidence" }] });
      p = await s.switchSlot(p.id, p.rev, slot, { evidence: `${slot} は 2回とも 0` }, "b");
      expect(p[slot]).toEqual({ run: { kind: "script", repo: "app", path: `scripts/${slot}.mjs`, invoke: `node scripts/${slot}.mjs` }, history: [{ at: expect.any(String), by: "b", from: PREP[slot].run, invoke: `node scripts/${slot}.mjs`, evidence: `${slot} は 2回とも 0` }] });
    }
    // 一般の更新から履歴は差し替えられない（入力の履歴は使わず、今の履歴を残す）
    const kept = await s.update(p.id, p.rev, { ...PREP, check: { ...p.check, history: [] } }, "c");
    expect(kept.check?.history).toEqual(p.check?.history);
    await expect(s.switchSlot(p.id, kept.rev, "nope" as never, { evidence: "x" }, "b")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("CLI と API の往復", () => {
  it("p3 observer prep add / show / update / switch / list と /preparations が同じ準備を読み書きする", async () => {
    const { root } = await initialized();
    writeFileSync(join(root, "prep.json"), JSON.stringify(PREP));
    const add = p3(root, ["observer", "prep", "add", "--input", "prep.json", "--json"], { P3_ACTOR: "ai:test" });
    expect(add.code, add.err).toBe(0);
    const id = add.json().id as string;
    const text = p3(root, ["observer", "prep", "show", id]).out;
    expect(text).toContain("サインイン済みの利用者");
    expect(text).toContain("占有: account:demo");
    expect(text).toContain("前処理: AI への指示");
    expect(text).toContain("置き換え候補: スクリプト app:scripts/setup.mjs ［新規予定（まだ無い）］");
    expect(p3(root, ["observer", "prep", "update", id, "--rev", "1", "--title", "名前を変えた", "--body", "説明も"]).code).toBe(0);
    expect(p3(root, ["observer", "prep", "update", id, "--rev", "1", "--title", "古い"]).code).toBe(3);
    expect(p3(root, ["observer", "prep", "list"]).out).toContain(`${id}  v2  名前を変えた  （確かめ・前処理・後処理・占有 account:demo）`);
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "setup.mjs"), "");
    const sw = p3(root, ["observer", "prep", "switch", id, "setup", "--rev", "2", "--command", "node scripts/setup.mjs --seed", "--body", "0 で終わる", "--json"]);
    expect(sw.code, sw.err).toBe(0);
    expect(sw.json().setup.run).toEqual({ kind: "script", repo: "app", path: "scripts/setup.mjs", invoke: "node scripts/setup.mjs --seed" });

    const api = observerRoutes({ target: { project: "app", dataDir: join(root, ".p3") } });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await api.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    expect((await call("GET", `/preparations/${id}`)).body).toEqual({ preparation: p3(root, ["observer", "prep", "show", id, "--json"]).json().preparation, usedBy: { definitions: [], unreadable: [] } });
    const dup = await call("POST", "/preparations", { name: "名前を変えた" });
    expect([dup.status, dup.body.problems]).toEqual([400, [{ path: "name", message: expect.stringContaining("同じ名前") }]]);
    const made = await call("POST", "/preparations", { name: "画面で作った", exclusive: ["db:orders"] });
    expect(made.status).toBe(201);
    const put = await call("PUT", `/preparations/${made.body.id}`, { rev: 1, preparation: { name: "画面で直した", teardown: { run: AI("注文の画面") } } });
    expect(put.body).toMatchObject({ rev: 2, name: "画面で直した", exclusive: [], teardown: { run: AI("注文の画面") } });
    expect((await call("PUT", `/preparations/${made.body.id}`, { rev: 1, preparation: { name: "x" } })).status).toBe(409);
    expect(p3(root, ["observer", "prep", "list", "--json"]).json().items.map((p: { name: string }) => p.name).sort()).toEqual(["名前を変えた", "画面で直した"]);
  });
});
