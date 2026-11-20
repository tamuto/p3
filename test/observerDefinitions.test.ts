import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDefinitionInput, type DefinitionInput } from "../packages/observer/src/shared/definition.ts";
import { DefinitionError, DefinitionStore } from "../packages/observer/src/core/definitionStore.ts";
import { startServer, type RunningServer } from "../packages/app/src/server/server.ts";
import { resolveMachineSettings } from "../packages/tasks/src/core/machineSettings.ts";
import { tempDir } from "./helpers.ts";
import { CONFIG_HOME, initialized, p3, repo, snapshot } from "./cliHelpers.ts";

/**
 * 観測の定義の登録（docs/architecture.md「p3-observer」の観測の定義）。
 *   検証（CLI・API・画面で共通の shared/definition.ts）・保存（core/definitionStore.ts。版の照合・読めないファイルを上書きしない）・
 *   CLI（p3 observer list / show / add / update）と API（/api/observer/definitions・/api/projects/<名前>/observer/definitions）の往復。
 * 画面は test/ui/observerDefinitions.ui.test.ts
 */
const SAMPLE: DefinitionInput = {
  title: "一覧 API の応答時間",
  category: "性能",
  description: "要望の一覧 API が 200ms 以内に返るかを見る",
  measures: [
    { name: "elapsed", type: "number", unit: "ms", description: "応答までの時間" },
    { name: "ok", type: "boolean" },
    { name: "note", type: "string" },
  ],
  procedures: [
    { id: "P1", title: "curl で測る", measures: ["elapsed"], run: { kind: "command", command: "curl", args: ["-s", "-o", "/dev/null", "-w", "%{time_total}", "http://localhost:4310/api/requests"], repo: "app", cwd: "." } },
    { id: "P2", title: "Vitest の性能テスト", measures: ["elapsed", "ok"], run: { kind: "test", repo: "app", path: "test/perf.test.ts", invoke: "pnpm vitest run test/perf.test.ts" } },
    {
      id: "P3",
      title: "一覧を開く",
      measures: ["ok"],
      run: { kind: "ai-instruction", premise: "p3 serve を起動しておく", target: "http://localhost:4310/", steps: ["一覧を開く", "読み込み中の表示が消えるのを待つ"], judge: "要望の一覧が出る", record: "ok に出たかを書く" },
      replacement: { kind: "ui-script", repo: "app", path: "scripts/open-list.mjs", operation: "一覧を開いて表示を待つ", output: "{ ok: boolean } を JSON で出す", compare: "同じデータで2回とも同じ値", switchWhen: "スクリプトで同じ判定が出たとき", invoke: "node scripts/open-list.mjs" },
    },
    { id: "P4", title: "見た目の確認", measures: ["note"], run: { kind: "ai-instruction", target: "一覧の画面", steps: ["読み込み中の表示が残らないかを確かめる"], judge: "残らない", record: "note に気づいたことを書く" } },
  ],
};

describe("観測の定義の検証（共通）", () => {
  it("タイトル・分類・観測内容・測定項目と、手順（今の実行方法・置き換え候補）を受け付け、前後の空白を落とす", () => {
    const r = validateDefinitionInput({ ...SAMPLE, title: "  一覧 API の応答時間 " });
    expect(r).toEqual({ ok: true, value: SAMPLE });
  });

  it("誤りは該当する項目の場所ごとに全部返す", () => {
    const r = validateDefinitionInput({
      title: "",
      category: 3,
      measures: [
        { name: "1 bad", type: "number" },
        { name: "flag", type: "boolean", unit: "回" },
        { name: "flag", type: "date" },
      ],
      procedures: [
        { title: "x", measures: ["missing"], run: { kind: "command", command: "", cwd: "/etc" } },
        { title: "t", run: { kind: "test", repo: "app", path: "../outside.ts", body: "x" } },
        { title: "s", run: { kind: "shell" } },
        { title: "a", run: { kind: "ai-instruction", target: "画面", steps: [] }, replacement: { kind: "test", repo: "app", path: "x.ts" } },
      ],
      extra: 1,
    });
    expect(r.ok).toBe(false);
    const paths = r.ok ? [] : r.problems.map((p) => p.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "extra",
        "title",
        "category",
        "description",
        "measures[0].name",
        "measures[1].unit",
        "measures[2].name",
        "measures[2].type",
        "procedures[0].run.command",
        "procedures[0].run.cwd",
        "procedures[0].run.repo",
        "procedures[0].measures[0]",
        "procedures[1].run.path",
        "procedures[1].run.body",
        "procedures[2].run.kind",
        "procedures[3].run.steps",
        "procedures[3].run.judge",
        "procedures[3].run.record",
        "procedures[3].replacement.operation",
        "procedures[3].replacement.switchWhen",
      ]),
    );
  });
});

describe("観測の定義の保存", () => {
  it("作成で ID と版 1、更新で版が上がる。古い版の更新は今の記録を上書きせずに断る", async () => {
    const dataDir = tempDir("p3-obs-store-");
    const store = new DefinitionStore(dataDir);
    const d = await store.create(SAMPLE, "ai:test");
    expect(d).toMatchObject({ format: 3, rev: 1, id: expect.stringMatching(/^obs-\d{6}-[0-9a-z]{5}$/), createdBy: "ai:test", ...SAMPLE });
    expect(existsSync(join(dataDir, "observer", "definitions", `${d.id}.json`))).toBe(true);
    const u = await store.update(d.id, 1, { ...SAMPLE, title: "変えた" }, "human:a");
    expect(u).toMatchObject({ rev: 2, title: "変えた", createdBy: "ai:test", updatedBy: "human:a" });
    const before = readFileSync(join(store.dir, `${d.id}.json`), "utf8");
    await expect(store.update(d.id, 1, SAMPLE, "human:b")).rejects.toMatchObject({ code: "conflict", current: expect.objectContaining({ rev: 2 }) });
    expect(readFileSync(join(store.dir, `${d.id}.json`), "utf8")).toBe(before);
    expect((await store.list()).definitions.map((x) => [x.id, x.rev])).toEqual([[d.id, 2]]);
  });

  it("同時の更新は1つだけが通る（同じ版を添えた2つ）", async () => {
    const store = new DefinitionStore(tempDir("p3-obs-race-"));
    const d = await store.create(SAMPLE, "a");
    const rs = await Promise.allSettled([store.update(d.id, 1, { ...SAMPLE, title: "A" }, "a"), store.update(d.id, 1, { ...SAMPLE, title: "B" }, "b")]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => (r.reason as DefinitionError).code)).toEqual(["conflict"]);
    expect((await store.get(d.id)).rev).toBe(2);
  });

  it("壊れた・知らない形の版のファイルは一覧に理由を出し、更新しない", async () => {
    const store = new DefinitionStore(tempDir("p3-obs-broken-"));
    const d = await store.create(SAMPLE, "a");
    const future = { ...(await store.get(d.id)), format: 4 };
    writeFileSync(join(store.dir, `${d.id}.json`), JSON.stringify(future));
    await writeFile(join(store.dir, "obs-261120-zzzzz.json"), "{ 壊れた");
    const l = await store.list();
    expect(l.definitions).toEqual([]);
    expect(l.unreadable.map((u) => u.file).sort()).toEqual([`${d.id}.json`, "obs-261120-zzzzz.json"].sort());
    expect(l.unreadable.find((u) => u.file === `${d.id}.json`)?.reason).toContain("知らない形の版");
    await expect(store.update(d.id, 1, SAMPLE, "a")).rejects.toMatchObject({ code: "unreadable" });
    expect(JSON.parse(readFileSync(join(store.dir, `${d.id}.json`), "utf8")).format).toBe(4);
  });
});

describe("CLI: p3 observer list / show / add / update", () => {
  it("--input の JSON で作り、show・list で同じ ID・版・項目を読む。show --json をそのまま更新に使える", async () => {
    const { root } = await initialized();
    // 今の実行方法のテストのファイルは参照先の中に有る（新規予定のファイルは今の実行方法に使えない）
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "perf.test.ts"), "");
    const tasksBefore = snapshot(join(root, ".p3", "requests"));
    writeFileSync(join(root, "def.json"), JSON.stringify(SAMPLE));
    const add = p3(root, ["observer", "add", "--input", "def.json", "--json"], { P3_ACTOR: "ai:test" });
    expect(add.code, add.err).toBe(0);
    const created = add.json();
    expect(created).toMatchObject({ rev: 1, createdBy: "ai:test", ...SAMPLE });
    // 定義はプロジェクトのデータのフォルダの observer/ だけに置く（tasks のデータは変えない）
    expect(readdirSync(join(root, ".p3", "observer", "definitions"))).toEqual([`${created.id}.json`]);
    expect(snapshot(join(root, ".p3", "requests"))).toEqual(tasksBefore);

    const shown = p3(root, ["observer", "show", created.id, "--json"]);
    expect(shown.json()).toEqual(created);
    const text = p3(root, ["observer", "show", created.id]).out;
    expect(text).toContain("一覧 API の応答時間");
    expect(text).toContain("elapsed  数値（ms）");
    expect(text).toContain("P2 Vitest の性能テスト（ユニットテスト）  測る: elapsed・ok");
    expect(text).toContain("app:test/perf.test.ts ［既にある］");
    expect(text).toContain("置き換え候補: 画面操作スクリプト app:scripts/open-list.mjs ［新規予定（まだ無い）］");
    expect(text).toContain("    2. 読み込み中の表示が消えるのを待つ");
    const list = p3(root, ["observer", "list", "--json"]).json();
    expect(list).toEqual({ definitions: [created], unreadable: [] });
    expect(p3(root, ["observer", "list"]).out).toContain(`${created.id}  v1  [性能]  一覧 API の応答時間`);

    // show --json を編集して --input で戻す（版は中の rev を使う）
    writeFileSync(join(root, "edit.json"), JSON.stringify({ ...created, title: "編集した" }));
    const upd = p3(root, ["observer", "update", created.id, "--input", "edit.json", "--json"]);
    expect(upd.code, upd.err).toBe(0);
    expect(upd.json()).toMatchObject({ rev: 2, title: "編集した", measures: SAMPLE.measures });
    // --input を省くと今の定義に重ねる
    const flags = p3(root, ["observer", "update", created.id, "--rev", "2", "--category", "速度", "--json"]);
    expect(flags.json()).toMatchObject({ rev: 3, category: "速度", title: "編集した" });
  });

  it("フラグだけで作れる。誤りは項目の場所を出して 1、無い ID は 2、古い版は 3（記録は変えない）", async () => {
    const { root } = await initialized();
    const ok = p3(root, ["observer", "add", "--title", "起動", "--category", "可用性", "--body", "起動できるか", "--expected", "1秒以内に画面が出る", "--json"]);
    expect(ok.code, ok.err).toBe(0);
    const id = ok.json().id as string;
    expect(ok.json().expected).toBe("1秒以内に画面が出る");
    expect(p3(root, ["observer", "show", id]).out).toContain("期待する結果: 1秒以内に画面が出る");
    const bad = p3(root, ["observer", "add", "--title", "x", "--json"]);
    expect(bad.code).toBe(1);
    // カテゴリは後から決めてよい（タイトルと観測内容だけで作れる）
    expect(bad.err).not.toContain("category");
    expect(bad.err).toContain("description: 入力してください");
    writeFileSync(join(root, "bad.json"), JSON.stringify({ ...SAMPLE, measures: [{ name: "n", type: "string", unit: "ms" }], procedures: [] }));
    expect(p3(root, ["observer", "add", "--input", "bad.json"]).err).toContain("measures[0].unit: 単位は数値の測定項目だけに付けられます");
    expect(p3(root, ["observer", "show", "obs-261120-zzzzz"]).code).toBe(2);
    expect(p3(root, ["observer", "update", id, "--rev", "1", "--title", "新", "--expected", ""]).code).toBe(0);
    expect(p3(root, ["observer", "show", id, "--json"]).json().expected).toBeUndefined();
    const stale = p3(root, ["observer", "update", id, "--rev", "1", "--title", "古い画面から"]);
    expect(stale.code).toBe(3);
    expect(stale.err).toContain("今の版 2");
    expect(p3(root, ["observer", "show", id, "--json"]).json()).toMatchObject({ rev: 2, title: "新" });
    expect(p3(root, ["observer", "update", id, "--title", "版なし"]).code).toBe(1);
    expect(p3(root, ["observer", "nope"]).code).toBe(1);
  });

  it("外部のデータのフォルダでも対象だけに保存する。登録が1つだけで決まったときは書き込みを止める", async () => {
    const root = await repo();
    const external = join(tempDir("p3-obs-ext-"), "data");
    expect(p3(root, ["init", "--yes", "--description", "外部", "--dir", external, "--project", "ext", "--repo-name", "app"]).code).toBe(0);
    const add = p3(root, ["observer", "add", "--title", "a", "--category", "b", "--body", "c", "--json"]);
    expect(add.code, add.err).toBe(0);
    expect(readdirSync(join(external, "observer", "definitions"))).toEqual([`${add.json().id}.json`]);
    expect(existsSync(join(root, ".p3"))).toBe(false);
    expect(p3(root, ["observer", "list", "--json"]).json().definitions).toEqual([add.json()]);
    // 登録の外の場所（登録は1つだけ）: 読むのは警告つきで通し、書くのは止める
    const elsewhere = tempDir("p3-obs-else-");
    const read = p3(elsewhere, ["observer", "list", "--json"]);
    expect(read.code, read.err).toBe(0);
    const write = p3(elsewhere, ["observer", "add", "--title", "a", "--category", "b", "--body", "c"]);
    expect(write.code).toBe(1);
    expect(readdirSync(join(external, "observer", "definitions"))).toHaveLength(1);
    expect(CONFIG_HOME).toBeTruthy();
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
async function serve(opts: Omit<Parameters<typeof startServer>[0], "port" | "host">) {
  const port = await freePort();
  const server = await startServer({ ...opts, port, host: "127.0.0.1" });
  servers.push(server);
  const base = `http://127.0.0.1:${port}/api`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, server };
}

describe("API と CLI の往復", () => {
  it("通常の serve: 画面の API で作った定義を CLI で読み、CLI で直した定義を API で読む。再起動のあとも同じ", async () => {
    const { root } = await initialized();
    // 今の実行方法のテストのファイルは参照先の中に有る（新規予定のファイルは今の実行方法に使えない）
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "perf.test.ts"), "");
    const dataDir = join(root, ".p3");
    const s = await serve({ dataDir, projectName: "app" });
    const invalid = await s.call("POST", "/observer/definitions", { ...SAMPLE, title: "" });
    expect([invalid.status, invalid.body.code, invalid.body.problems]).toEqual([400, "invalid", [{ path: "title", message: "入力してください" }]]);
    const created = await s.call("POST", "/observer/definitions", SAMPLE, { "x-p3-actor": "human:web-test" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(p3(root, ["observer", "show", id, "--json"]).json()).toEqual(created.body);
    expect(p3(root, ["observer", "update", id, "--rev", "1", "--title", "CLI で直した"]).code).toBe(0);
    const got = await s.call("GET", `/observer/definitions/${id}`);
    expect(got.body).toMatchObject({ definition: { rev: 2, title: "CLI で直した", measures: SAMPLE.measures } });
    const stale = await s.call("PUT", `/observer/definitions/${id}`, { rev: 1, definition: SAMPLE });
    expect([stale.status, stale.body.code, stale.body.current?.rev]).toEqual([409, "conflict", 2]);
    expect((await s.call("GET", "/observer/definitions/obs-261120-zzzzz")).status).toBe(404);
    await s.server.close({ timeoutMs: 1000 });
    servers.splice(0);
    const again = await serve({ dataDir, projectName: "app" });
    expect((await again.call("GET", "/observer/definitions")).body.definitions).toEqual([expect.objectContaining({ id, rev: 2, title: "CLI で直した" })]);
  });

  it("プロジェクトを跨ぐ serve: プロジェクトごとの API に保存し、登録世代の無い・古い更新は断る", async () => {
    const a = await initialized();
    const b = await initialized();
    const cfg = tempDir("p3-obs-all-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfg;
    await mkdir(join(cfg, "infodb-p3"), { recursive: true });
    await writeFile(join(cfg, "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${join(a.root, ".p3")}\n  beta:\n    dir: ${join(b.root, ".p3")}\n`);
    try {
      const s = await serve({ allProjects: true, settings: resolveMachineSettings({ settings: {} }, {}) });
      const list = await s.call("GET", "/projects");
      const gen = (name: string) => (list.body.projects as { name: string; generation: string }[]).find((p) => p.name === name)!.generation;
      expect((await s.call("GET", "/observer/definitions")).status).toBe(404);
      expect((await s.call("POST", "/projects/alpha/observer/definitions", SAMPLE)).status).toBe(428);
      expect((await s.call("POST", "/projects/alpha/observer/definitions", SAMPLE, { "x-p3-project-generation": "old" })).status).toBe(409);
      const created = await s.call("POST", "/projects/alpha/observer/definitions", SAMPLE, { "x-p3-project-generation": gen("alpha") });
      expect(created.status).toBe(201);
      expect((await s.call("GET", "/projects/alpha/observer/definitions")).body).toMatchObject({ definitions: [expect.objectContaining({ id: created.body.id })] });
      expect((await s.call("GET", "/projects/beta/observer/definitions")).body.definitions).toEqual([]);
      expect(existsSync(join(b.root, ".p3", "observer"))).toBe(false);
      expect((await s.call("GET", "/observer/status")).body.state).toBe("ready");
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });
});
