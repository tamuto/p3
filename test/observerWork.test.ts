import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkStore } from "../packages/observer/src/core/workStore.ts";
import { DefinitionStore } from "../packages/observer/src/core/definitionStore.ts";
import { startServer, type RunningServer } from "../packages/app/src/server/server.ts";
import { resolveMachineSettings } from "../packages/tasks/src/core/machineSettings.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測の ID を先に発行し、編集途中の入力と提案の依頼・結果を観測に残す（docs/architecture.md「p3-observer」の観測の作業の記録）。
 * 再起動・強制終了（実行していたプロセスが終わった記録）・競合・プロジェクトの分離と、CLI の ID を起点にした提案を確かめる
 */
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
const mock = () => resolveMachineSettings({ settings: {} }, { P3_PREFLIGHT_ENGINE: "mock" });
async function serve(opts: Omit<Parameters<typeof startServer>[0], "port" | "host">) {
  const port = await freePort();
  const server = await startServer({ ...opts, port, host: "127.0.0.1" });
  servers.push(server);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, server };
}
async function waitDone(call: Awaited<ReturnType<typeof serve>>["call"], path: string) {
  for (let i = 0; i < 100; i++) {
    const r = await call("GET", path);
    if (r.body.status !== "running") return r.body;
    await new Promise((x) => setTimeout(x, 20));
  }
  throw new Error("終わりません");
}

describe("観測の作業の記録（API）", () => {
  it("タイトルと観測内容だけで作ると ID が付き、編集途中の入力と提案の依頼・結果が再起動のあとも残る", async () => {
    const { root } = await initialized();
    const dataDir = join(root, ".p3");
    let s = await serve({ dataDir, projectName: "app", repos: { app: root }, settings: mock() });
    const created = await s.call("POST", "/observer/definitions", { title: "一覧の応答時間", description: "p3 ls コマンドが速く返るか" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ rev: 1, category: "", measures: [], procedures: [] });
    // 検証の前の不完全な入力もそのまま残る。古い版からの上書きは断る
    const raw = { title: "一覧", measures: [{ name: "1 bad", type: "number", unit: "" }], procedures: [{ kind: "command", title: "" }] };
    const d1 = await s.call("PUT", `/observer/definitions/${id}/draft`, { version: null, basedOnRev: 1, input: raw });
    expect(d1.body).toMatchObject({ version: 1, basedOnRev: 1, input: raw });
    expect((await s.call("PUT", `/observer/definitions/${id}/draft`, { version: null, basedOnRev: 1, input: {} })).status).toBe(409);
    const sg = await s.call("POST", `/observer/definitions/${id}/suggestions`, { definition: { title: "一覧の応答時間", description: "p3 ls コマンドが速く返るか" }, note: "pnpm で", basedOnRev: 1 });
    expect(sg.status).toBe(202);
    const done = await waitDone(s.call, `/observer/definitions/${id}/suggestions/${sg.body.id}`);
    expect(done).toMatchObject({ status: "completed", definition: id, basedOnRev: 1, request: { note: "pnpm で" }, result: { surface: "cli" } });
    await s.server.close({ timeoutMs: 1000 });
    servers.splice(0);
    s = await serve({ dataDir, projectName: "app", repos: { app: root }, settings: mock() });
    expect((await s.call("GET", `/observer/definitions/${id}/draft`)).body.draft).toMatchObject({ version: 1, input: raw });
    const list = (await s.call("GET", `/observer/definitions/${id}/suggestions`)).body.suggestions;
    expect(list).toEqual([expect.objectContaining({ id: sg.body.id, status: "completed", result: expect.objectContaining({ surface: "cli" }) })]);
    expect(readdirSync(join(dataDir, "observer", "work", id, "suggestions"))).toEqual([`${sg.body.id}.json`]);
    // 無い観測には頼めない・残せない
    expect((await s.call("PUT", "/observer/definitions/obs-261120-zzzzz/draft", { version: null, basedOnRev: 1, input: {} })).status).toBe(404);
  });

  it("実行していたプロセスが終わった提案は中断と読め、同じ入力で頼み直せる。終わった記録は上書きしない", async () => {
    const dataDir = tempDir("p3-obs-work-");
    const def = await new DefinitionStore(dataDir).create({ title: "t", description: "画面を見る" }, "a");
    const work = new WorkStore(dataDir);
    const dead = { id: "sg-000000000001", status: "running" as const, engine: "codex", startedAt: "2026-11-20T00:00:00.000Z", definition: def.id, basedOnRev: 1, request: { definition: { title: "t", category: "", description: "画面を見る", measures: [], procedures: [] }, note: "補足" } };
    await work.createSuggestion(dead);
    // 強制終了を、記録の持ち主を終わったプロセスにして再現する
    const file = join(dataDir, "observer", "work", def.id, "suggestions", `${dead.id}.json`);
    writeFileSync(file, JSON.stringify({ ...dead, owner: { host: hostname(), pid: 2 ** 22 + 12345 } }));
    expect(await work.getSuggestion(def.id, dead.id)).toMatchObject({ status: "interrupted", request: { note: "補足" }, error: expect.stringContaining("中断") });
    // 取り消し済みの記録に、遅れて届いた結果を上書きしない
    writeFileSync(file, JSON.stringify({ ...dead, status: "cancelled" }));
    expect(await work.finishSuggestion({ ...dead, status: "completed" })).toMatchObject({ status: "cancelled" });
  });

  it("プロジェクトを跨ぐ serve: 提案と入力はプロジェクトごとで、登録世代が要る", async () => {
    const a = await initialized();
    const b = await initialized();
    const cfg = tempDir("p3-obs-work-all-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfg;
    await mkdir(join(cfg, "infodb-p3"), { recursive: true });
    await writeFile(join(cfg, "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${join(a.root, ".p3")}\n  beta:\n    dir: ${join(b.root, ".p3")}\n`);
    try {
      const { call } = await serve({ allProjects: true, settings: mock() });
      const gen = ((await call("GET", "/projects")).body.projects as { name: string; generation: string }[]).find((p) => p.name === "alpha")!.generation;
      const h = { "x-p3-project-generation": gen };
      const id = (await call("POST", "/projects/alpha/observer/definitions", { title: "t", description: "d" }, h)).body.id as string;
      expect((await call("PUT", `/projects/alpha/observer/definitions/${id}/draft`, { version: null, basedOnRev: 1, input: {} })).status).toBe(428);
      expect((await call("PUT", `/projects/alpha/observer/definitions/${id}/draft`, { version: null, basedOnRev: 1, input: {} }, { "x-p3-project-generation": "old" })).status).toBe(409);
      expect((await call("PUT", `/projects/alpha/observer/definitions/${id}/draft`, { version: null, basedOnRev: 1, input: { title: "x" } }, h)).status).toBe(200);
      const sg = await call("POST", `/projects/alpha/observer/definitions/${id}/suggestions`, { definition: { title: "t", description: "d" }, basedOnRev: 1 }, h);
      expect(sg.status).toBe(202);
      expect((await call("GET", `/projects/beta/observer/definitions/${id}/draft`)).status).toBe(404);
      expect((await call("GET", `/projects/beta/observer/definitions/${id}/suggestions/${sg.body.id}`)).status).toBe(404);
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("観測の作業の記録（CLI）", () => {
  it("p3 observer suggest <ID> は保存した観測に頼み、依頼と結果を残す。suggestions で履歴・1件を読む", async () => {
    const { root } = await initialized();
    const add = p3(root, ["observer", "add", "--title", "一覧", "--body", "p3 ls コマンドの速さ", "--json"]);
    expect(add.code, add.err).toBe(0);
    const id = add.json().id as string;
    const r = p3(root, ["observer", "suggest", id, "--note", "pnpm を使う", "--json"], { P3_PREFLIGHT_ENGINE: "mock" });
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ status: "completed", definition: id, basedOnRev: 1, request: { note: "pnpm を使う" } });
    const list = p3(root, ["observer", "suggestions", id, "--json"]).json().suggestions;
    expect(list).toHaveLength(1);
    expect(p3(root, ["observer", "suggestions", id, list[0].id]).out).toContain("操作面: CLI・コマンド");
    expect(p3(root, ["observer", "suggestions", id, "sg-000000000000"]).code).toBe(2);
    expect(p3(root, ["observer", "suggest", id, "--input", "x.json"]).code).toBe(1);
    // ID の無い互換の経路は保存しない
    const compat = p3(root, ["observer", "suggest", "--title", "t", "--body", "p3 ls コマンド"], { P3_PREFLIGHT_ENGINE: "mock" });
    expect(compat.out).toContain("保存はしていません");
    expect(p3(root, ["observer", "suggestions", id, "--json"]).json().suggestions).toHaveLength(1);
    // 書き込みとして扱う（登録が1つだけで決まった場所からは止める）
    const elsewhere = tempDir("p3-obs-work-else-");
    expect(p3(elsewhere, ["observer", "suggest", id], { P3_PREFLIGHT_ENGINE: "mock" }).code).toBe(1);
  });
});
