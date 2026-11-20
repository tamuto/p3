import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefinitionStore } from "../packages/observer/src/core/definitionStore.ts";
import { WorkStore } from "../packages/observer/src/core/workStore.ts";
import { fileChecker } from "../packages/observer/src/core/files.ts";
import { startServer, type RunningServer } from "../packages/app/src/server/server.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 実行できる確認手順と、スクリプトへの置き換え（docs/architecture.md「p3-observer」の確認の手順）。
 * ファイルの有無の照合・新規予定のファイルを今の実行方法に使わないこと・切り替えと履歴・切り替えの拒否・形の版 1 の移行を確かめる
 */
const AI_RUN = { kind: "ai-instruction", premise: "p3 serve を起動しておく", target: "http://localhost:4310/", steps: ["一覧を開く", "表示を待つ"], judge: "一覧が出る", record: "ok に出たかを書く" };
const REPLACEMENT = { kind: "ui-script", repo: "app", path: "scripts/open-list.mjs", operation: "一覧を開いて表示を待つ", output: '{"ok":true} を出す', compare: "2回とも同じ値", switchWhen: "スクリプトで同じ判定が出たとき", invoke: "node scripts/open-list.mjs" };
const input = (extra: Record<string, unknown> = {}) => ({
  title: "一覧の表示",
  description: "一覧が出るか",
  measures: [{ name: "ok", type: "boolean" }],
  procedures: [{ title: "一覧を開く", measures: ["ok"], run: AI_RUN, replacement: REPLACEMENT, ...extra }],
});

function repoStore() {
  const repo = tempDir("p3-obs-proc-repo-");
  const dataDir = tempDir("p3-obs-proc-data-");
  const files = fileChecker((name) => (name === "app" ? repo : undefined));
  return { repo, dataDir, files, store: new DefinitionStore(dataDir, files) };
}

describe("確認の手順とスクリプトへの置き換え", () => {
  it("ファイルの有無は参照先の中で照らし（既にある・新規予定・未確認）、新規予定のファイルは今の実行方法に使えない", async () => {
    const { repo, files, store } = repoStore();
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "have.mjs"), "");
    expect([files("app", "scripts/have.mjs"), files("app", "scripts/open-list.mjs"), files("docs", "x.md"), files("app", "../outside")]).toEqual(["exists", "planned", "unverified", "planned"]);
    // スクリプトが無いあいだは AI への指示で確かめ、置き換え候補には新規予定のファイルを書ける。手順には P1 が付く
    const d = await store.create(input(), "a");
    expect(d.procedures[0]).toMatchObject({ id: "P1", run: AI_RUN, replacement: REPLACEMENT });
    // 新規予定のファイルを今の実行方法にすると断る
    const planned = { kind: "ui-script", repo: "app", path: "scripts/open-list.mjs" };
    await expect(store.create(input({ run: planned }), "a")).rejects.toMatchObject({ code: "invalid", problems: [{ path: "procedures[0].run.path", message: expect.stringContaining("新規予定") }] });
    expect((await store.create(input({ run: { ...planned, path: "scripts/have.mjs" } }), "a")).procedures[0].run).toMatchObject({ path: "scripts/have.mjs" });
  });

  it("確かめたスクリプトに切り替えると、今の実行方法と呼び出し方が同じ更新で変わり、置き換える前の手順は履歴に残る", async () => {
    const { repo, store } = repoStore();
    const d = await store.create(input(), "a");
    // まだ無い・古い版・確かめた結果が無いときは断り、今の手順を保つ
    await expect(store.switchProcedure(d.id, 1, "P1", { invoke: "node scripts/open-list.mjs", evidence: "2回とも ok" }, "b")).rejects.toMatchObject({ code: "invalid", problems: [expect.objectContaining({ path: "procedures[0].replacement.path" })] });
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "open-list.mjs"), "");
    await expect(store.switchProcedure(d.id, 1, "P1", { invoke: "node scripts/open-list.mjs" }, "b")).rejects.toMatchObject({ problems: [expect.objectContaining({ path: "evidence" })] });
    const u = await store.update(d.id, 1, { ...input(), title: "直した" }, "a");
    await expect(store.switchProcedure(d.id, 1, "P1", { evidence: "x" }, "b")).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get(d.id)).procedures[0].run).toEqual(AI_RUN);
    const s = await store.switchProcedure(d.id, u.rev, "P1", { evidence: "2回とも {\"ok\":true}" }, "b");
    expect(s.procedures[0]).toMatchObject({ id: "P1", run: { kind: "ui-script", repo: "app", path: "scripts/open-list.mjs", invoke: "node scripts/open-list.mjs" }, history: [{ by: "b", from: AI_RUN, invoke: "node scripts/open-list.mjs", evidence: "2回とも {\"ok\":true}" }] });
    expect(s.procedures[0].replacement).toBeUndefined();
    // 読み直しても履歴が残り、手順を直す更新でも履歴は消えない（入力の履歴は使わない）
    const again = await store.get(d.id);
    expect(again.procedures[0].history).toHaveLength(1);
    const edited = await store.update(d.id, again.rev, { ...input({ id: "P1", run: again.procedures[0].run, replacement: undefined, history: [] }), title: "t" }, "a");
    expect(edited.procedures[0].history).toEqual(again.procedures[0].history);
  });

  it("形の版 1 の定義と、そのときに保存した提案を今の形で読み、更新で今の形の版（3）にする", async () => {
    const dataDir = tempDir("p3-obs-proc-v1-");
    const id = "obs-261120-abcde";
    const v1 = {
      format: 1,
      id,
      rev: 1,
      title: "t",
      category: "c",
      description: "d",
      measures: [{ name: "ok", type: "boolean" }],
      procedures: [
        { kind: "command", title: "テスト", command: "pnpm", args: ["test"], measures: ["ok"] },
        { kind: "ai-instruction", title: "見た目", body: "一覧を見る", measures: [] },
      ],
      createdAt: "2026-11-20T00:00:00.000Z",
      createdBy: "a",
      updatedAt: "2026-11-20T00:00:00.000Z",
      updatedBy: "a",
    };
    mkdirSync(join(dataDir, "observer", "definitions"), { recursive: true });
    const file = join(dataDir, "observer", "definitions", `${id}.json`);
    writeFileSync(file, JSON.stringify(v1));
    const store = new DefinitionStore(dataDir);
    const d = await store.get(id);
    expect(d.procedures).toEqual([
      { id: "P1", title: "テスト", measures: ["ok"], run: { kind: "command", command: "pnpm", args: ["test"] } },
      { id: "P2", title: "見た目", measures: [], run: { kind: "ai-instruction", target: "（未記入）", steps: ["一覧を見る"], judge: "（未記入）", record: "（未記入）" } },
    ]);
    const { format: _f, id: _i, rev: _r, createdAt: _a, createdBy: _b, updatedAt: _c, updatedBy: _d, ...content } = d;
    await store.update(id, 1, content, "a");
    expect(JSON.parse(readFileSync(file, "utf8")).format).toBe(3);
    // 形の版 1 のときに保存した提案
    mkdirSync(join(dataDir, "observer", "work", id, "suggestions"), { recursive: true });
    writeFileSync(
      join(dataDir, "observer", "work", id, "suggestions", "sg-000000000009.json"),
      JSON.stringify({ id: "sg-000000000009", status: "completed", engine: "codex", startedAt: "2026-11-20T00:00:00.000Z", definition: id, basedOnRev: 1, request: { definition: { ...v1, procedures: v1.procedures } }, result: { surface: "cli", rationale: "r", procedures: [{ procedure: { kind: "test", title: "t", repo: "app", path: "a.ts", measures: [] }, evidence: "e" }], missing: [], warnings: [] } }),
    );
    const old = await new WorkStore(dataDir).getSuggestion(id, "sg-000000000009");
    expect(old?.result).toMatchObject({ measures: [], procedures: [{ procedure: { id: "", run: { kind: "test", repo: "app", path: "a.ts" } } }] });
    expect(old?.request?.definition.procedures[1]).toMatchObject({ run: { kind: "ai-instruction", steps: ["一覧を見る"] } });
  });
});

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close({ timeoutMs: 1000 });
});
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("ポートを選べません"))));
    });
  });

describe("API と CLI の置き換え", () => {
  it("API がファイルの有無を返し、切り替えを受ける。CLI の switch と show も同じ", async () => {
    const { root } = await initialized();
    const port = await freePort();
    servers.push(await startServer({ dataDir: join(root, ".p3"), projectName: "app", repos: { app: root }, port, host: "127.0.0.1" }));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/observer${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const d = (await call("POST", "/definitions", input())).body;
    const f = (await call("GET", "/files?ref=app:scripts/open-list.mjs&ref=app:README.md&ref=nope:x")).body.files;
    expect(f).toMatchObject({ "app:scripts/open-list.mjs": { state: "planned" }, "app:README.md": { state: "exists" }, "nope:x": { state: "unverified" } });
    expect(f["app:README.md"].checkedAt).toMatch(/^\d{4}-/);
    expect((await call("POST", `/definitions/${d.id}/procedures/P1/switch`, { rev: 1, evidence: "ok" })).status).toBe(400);
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "open-list.mjs"), "");
    const sw = await call("POST", `/definitions/${d.id}/procedures/P1/switch`, { rev: 1, invoke: "node scripts/open-list.mjs --json", evidence: "2回とも同じ" });
    expect(sw.status).toBe(200);
    expect(sw.body.procedures[0]).toMatchObject({ run: { kind: "ui-script", invoke: "node scripts/open-list.mjs --json" }, history: [{ invoke: "node scripts/open-list.mjs --json" }] });
    const shown = p3(root, ["observer", "show", d.id]).out;
    expect(shown).toContain("app:scripts/open-list.mjs ［既にある］  呼び出し方: node scripts/open-list.mjs --json");
    expect(shown).toContain("切り替え ");
    // CLI の switch（置き換え候補を書いた別の観測）
    const d2 = JSON.parse(p3(root, ["observer", "add", "--input", "-", "--json"], {}, undefined, JSON.stringify(input())).out);
    const cli = p3(root, ["observer", "switch", d2.id, "P1", "--rev", "1", "--body", "2回とも同じ", "--json"]);
    expect(cli.code, cli.err).toBe(0);
    expect(cli.json().procedures[0].history).toHaveLength(1);
    expect(p3(root, ["observer", "switch", d2.id, "P1", "--rev", "1", "--body", "x"]).code).toBe(3);
  });
});
