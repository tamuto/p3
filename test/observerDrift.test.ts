import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionStore, PreparationStore } from "../packages/observer/src/core/definitionStore.ts";
import { fileChecker, fileHasher } from "../packages/observer/src/core/files.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { tempDir } from "./helpers.ts";

/**
 * 期待の見直しの注意（docs/architecture.md「p3-observer」の仕様変更を要望の評価で捉える）: 期待を確定したときの現行の参照ファイル（手順と使う準備の
 * 今の実行方法のファイル）の比較基準と、開くたびの今の内容を比べる。内容の変化・削除・差し替えは注意、比較基準が無い・読めないものは未確認、閲覧で定義は変わらない
 */
function setup() {
  const repo = tempDir("p3-drift-repo-");
  const dataDir = tempDir("p3-drift-data-");
  mkdirSync(join(repo, "test"));
  for (const f of ["a.test.ts", "b.test.ts", "seed.mjs", "other.ts"]) writeFileSync(join(repo, "test", f), `// ${f}\n`);
  const repoPath = (n: string) => (n === "app" ? repo : undefined);
  const defs = new DefinitionStore(dataDir, fileChecker(repoPath), fileHasher(repoPath));
  return { repo, dataDir, defs, preps: new PreparationStore(dataDir, fileChecker(repoPath)) };
}
const proc = (path: string) => ({ title: "テスト", run: { kind: "test", repo: "app", path }, replacement: { kind: "test", repo: "app", path: "test/b.test.ts", operation: "o", output: "o", compare: "c", switchWhen: "s", invoke: "pnpm vitest run test/b.test.ts" } });
const obs = (extra: Record<string, unknown> = {}) => ({ title: "一覧", description: "一覧が出る", expected: "出る", procedures: [proc("test/a.test.ts")], ...extra });

describe("期待の見直しの注意", () => {
  it("期待を確定したときの手順と使う準備のファイルを比較基準にし、同じ内容の再保存やほかのファイルの変更では注意を出さない", async () => {
    const { repo, defs, preps } = setup();
    const p = await preps.create({ name: "種のデータ", setup: { run: { kind: "script", repo: "app", path: "test/seed.mjs" } } }, "a");
    const d = await defs.create(obs({ preparations: [p.id] }), "a");
    expect(d.baseline?.files.map((f) => [f.path, f.hash?.length])).toEqual([["test/a.test.ts", 64], ["test/seed.mjs", 64]]);
    expect(await defs.drift(d)).toEqual({ state: "none", files: [], baselineAt: d.baseline?.at });
    const same = await defs.update(d.id, 1, obs({ preparations: [p.id] }), "a");
    expect(same.baseline).toEqual(d.baseline);
    writeFileSync(join(repo, "test", "other.ts"), "// changed\n");
    expect((await defs.drift(same)).state).toBe("none");
    // 準備のファイルが変わっても注意。期待を直すと、そのときの内容が新しい比較基準になる
    writeFileSync(join(repo, "test", "seed.mjs"), "// changed\n");
    expect(await defs.drift(same)).toMatchObject({ state: "changed", files: [{ path: "test/seed.mjs", change: "changed" }] });
    const fixed = await defs.update(d.id, 2, obs({ preparations: [p.id], expected: "速く出る" }), "a");
    expect((await defs.drift(fixed)).state).toBe("none");
  });

  it("内容の変化・削除・期待を直さない差し替えは注意、比較基準の無い古いもの・読めない参照先は未確認。閲覧で定義は変わらない", async () => {
    const { repo, dataDir, defs } = setup();
    const d = await defs.create(obs(), "a");
    const file = join(dataDir, "observer", "definitions", `${d.id}.json`);
    const before = readFileSync(file, "utf8");
    writeFileSync(join(repo, "test", "a.test.ts"), "// changed\n");
    expect(await defs.drift(d)).toMatchObject({ state: "changed", files: [{ change: "changed" }] });
    rmSync(join(repo, "test", "a.test.ts"));
    expect(await defs.drift(d)).toMatchObject({ state: "changed", files: [{ change: "deleted" }] });
    writeFileSync(join(repo, "test", "a.test.ts"), "// a.test.ts\n");
    expect((await defs.drift(d)).state).toBe("none");
    expect(readFileSync(file, "utf8")).toBe(before);
    // 期待を直さないまま、手順をほかのファイルに切り替えた
    const s = await defs.switchProcedure(d.id, 1, "P1", { evidence: "同じ結果" }, "a");
    expect(await defs.drift(s)).toMatchObject({ state: "changed", files: [{ path: "test/a.test.ts", change: "replaced" }, { path: "test/b.test.ts", change: "added" }] });
    // 期待の無い観測・比較基準の無い古いもの・参照先を読めないもの
    expect(await defs.drift(await defs.create(obs({ expected: undefined }), "a"))).toEqual({ state: "unverified", files: [] });
    expect((await new DefinitionStore(dataDir).drift(d)).files).toEqual([{ repo: "app", path: "test/a.test.ts", change: "unreadable" }]);
    expect((await new DefinitionStore(dataDir).drift(d)).state).toBe("unverified");
  });

  it("API の詳細は開くたびに計算した注意を返す（一覧は返さない）", async () => {
    const { repo, dataDir } = setup();
    const api = observerRoutes({ target: { project: "app", dataDir, repoPath: (n) => (n === "app" ? repo : undefined) } });
    const res = await api.request("/definitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obs()) });
    const id = ((await res.json()) as { id: string }).id;
    const get = async () => ((await (await api.request(`/definitions/${id}`)).json()) as { drift: { state: string } }).drift;
    expect((await get()).state).toBe("none");
    writeFileSync(join(repo, "test", "a.test.ts"), "// changed\n");
    expect((await get()).state).toBe("changed");
    expect(Object.keys(((await (await api.request("/definitions")).json()) as { definitions: object[] }).definitions[0])).not.toContain("drift");
  });
});
