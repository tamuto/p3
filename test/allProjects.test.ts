import { spawnSync } from "node:child_process";
import { cp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import type { P3Context } from "../src/core/context.ts";
import { fixedSettings, resolveMachineSettings } from "../src/core/machineSettings.ts";
import type { EngineOutcome, PreflightEngine } from "../src/core/preflight/engine.ts";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import { ProjectRegistry, RegistryError } from "../src/core/projectRegistry.ts";
import type { Summarizer } from "../src/core/releaseNotes/generate.ts";
import { checkDataDir } from "../src/core/store/locate.ts";
import { GENERATION_HEADER, projectsRoutes } from "../src/server/api/projectsRoutes.ts";
import { singleProjectApp, startServer } from "../src/server/server.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { makeRepo, newRequest, newTask, openTestProject, tempDir, writeTestProject } from "./helpers.ts";

/** 外から開け閉めできる Preflight のエンジン（開くまで待つ。取り消せる） */
class GateEngine implements PreflightEngine {
  readonly name = "mock" as const;
  private gates: (() => void)[] = [];
  started = 0;
  async status() {
    return { name: "mock" as const, ok: true, detail: "gate" };
  }
  async run(job: Parameters<PreflightEngine["run"]>[0], log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    this.started++;
    await new Promise<void>((res, rej) => {
      this.gates.push(res);
      signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
    return new MockEngine({ delay: 0 }).run(job, log, signal);
  }
  release() {
    for (const g of this.gates.splice(0)) g();
  }
}

/** 外から開け閉めできる要約（リリースノートの生成） */
class GateSummarizer implements Summarizer {
  private gates: (() => void)[] = [];
  async ask(_: unknown, __: unknown, signal: AbortSignal) {
    await new Promise<void>((res, rej) => {
      this.gates.push(res);
      signal.addEventListener("abort", () => rej(new Error("cancelled")), { once: true });
    });
    return { text: JSON.stringify({ items: [] }) } as never;
  }
  release() {
    for (const g of this.gates.splice(0)) g();
  }
}

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** 一時の個人設定と、そこに登録したプロジェクト。open は待ち時間を外から決められるエンジンで開く */
async function setup(names: string[], opts: { engines?: Record<string, GateEngine>; summarizers?: Record<string, GateSummarizer> } = {}) {
  const root = tempDir("p3-all-");
  const config = join(root, "config.yaml");
  const dirs: Record<string, string> = {};
  for (const n of names) dirs[n] = (await makeRepo({ name: n })).dataDir;
  const write = async (projects: Record<string, string>, extra = "") =>
    writeFile(config, `projects:\n${Object.entries(projects).map(([n, d]) => `  ${n}:\n    dir: ${d}\n`).join("")}${extra}`);
  await write(dirs);
  const opened: string[] = [];
  const chatgpt = chatgptAccount(join(root, "chatgpt.json"));
  const registry = new ProjectRegistry({
    settings: fixedSettings(resolveMachineSettings({ settings: {} }, {})),
    chatgpt,
    configPath: config,
    open: async (dir, o) => {
      opened.push(o!.projectName!);
      await checkDataDir(dir, o?.projectName);
      const name = o!.projectName!;
      const ctx = await openTestProject(dir, { mock: opts.engines?.[name] ?? new MockEngine({ delay: 0 }) }, { repos: o?.repos, summarizer: opts.summarizers?.[name] });
      return { ...ctx, projectName: name, chatgpt: o?.chatgpt };
    },
  });
  closers.push(() => registry.close({ timeoutMs: 2000 }));
  await registry.refresh();
  const app = projectsRoutes(registry);
  const gen = (name: string) => registry.list().projects.find((p) => p.name === name)!.generation;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  /** そのプロジェクトの API を、今の登録世代を添えて呼ぶ */
  const at = (name: string) => (method: string, path: string, body?: unknown) => call(method, `/projects/${name}${path}`, body, { [GENERATION_HEADER]: gen(name) });
  return { root, config, dirs, write, registry, app, call, at, gen, opened, chatgpt };
}

describe("ProjectRegistry: 個人設定の一覧", () => {
  it("登録0件・1件・複数件を一覧にし、0件でも動く。形の違う登録は理由を付けて外し、ほかは使える", async () => {
    const none = await setup([]);
    expect(none.registry.list()).toEqual({ projects: [], invalid: [] });
    const { registry, write, dirs } = await setup(["alpha", "beta"]);
    expect(registry.list().projects.map((p) => [p.name, p.state, p.open])).toEqual([
      ["alpha", "ok", false],
      ["beta", "ok", false],
    ]);
    await write(dirs, "  'bad name':\n    dir: /x\n  nodir:\n    repos: {}\n");
    const l = await registry.refresh();
    expect(l.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(l.invalid.map((i) => i.name).sort()).toEqual(["bad name", "nodir"]);
  });

  it("壊れた個人設定は登録0件と区別し、今の一覧を残す。直して読み直せば戻る", async () => {
    const { registry, config, write, dirs } = await setup(["alpha"]);
    await writeFile(config, "projects: [\n");
    const broken = await registry.refresh();
    expect(broken.configError).toContain("YAML が壊れています");
    expect(broken.projects.map((p) => p.name)).toEqual(["alpha"]);
    await write(dirs);
    expect((await registry.refresh()).configError).toBeUndefined();
  });

  it("データのフォルダが無い登録はそのプロジェクトだけ開けず、ほかは使える。戻せば次の open で開ける", async () => {
    const { registry, dirs } = await setup(["alpha", "beta"]);
    await rename(dirs.alpha, `${dirs.alpha}.moved`);
    await expect(registry.open("alpha")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("データのフォルダがありません") });
    expect(registry.list().projects.find((p) => p.name === "alpha")).toMatchObject({ state: "error", error: expect.stringContaining("データのフォルダがありません") });
    expect((await registry.open("beta")).projectName).toBe("beta");
    await rename(`${dirs.alpha}.moved`, dirs.alpha);
    expect((await registry.open("alpha")).projectName).toBe("alpha");
    expect(registry.list().projects.find((p) => p.name === "alpha")).toMatchObject({ state: "ok", open: true });
  });

  it("同時に開こうとしたら1回にまとめ、失敗したら覚えずにやり直す", async () => {
    const { registry, opened, dirs } = await setup(["alpha"]);
    const [a, b] = await Promise.all([registry.open("alpha"), registry.open("alpha")]);
    expect(a).toBe(b);
    expect(opened).toEqual(["alpha"]);

    const s2 = await setup(["gamma"]);
    await rename(s2.dirs.gamma, `${s2.dirs.gamma}.x`);
    const fails = await Promise.allSettled([s2.registry.open("gamma"), s2.registry.open("gamma")]);
    expect(fails.map((f) => f.status)).toEqual(["rejected", "rejected"]);
    expect(s2.opened).toEqual(["gamma"]);
    await rename(`${s2.dirs.gamma}.x`, s2.dirs.gamma);
    await expect(s2.registry.open("gamma")).resolves.toBeTruthy();
    expect(s2.opened).toEqual(["gamma", "gamma"]);
    expect(dirs.alpha).toBeTruthy();
  });

  it("同じデータのフォルダ（実体）を複数の名前で登録したら、どれも開かない。1つにすれば別の世代で開ける", async () => {
    const { registry, write, dirs, root } = await setup(["alpha"]);
    const link = join(root, "alias");
    await symlink(dirs.alpha, link);
    await write({ alpha: dirs.alpha, alias: link });
    const l = await registry.refresh();
    expect(l.projects.map((p) => [p.name, p.state])).toEqual([
      ["alias", "error"],
      ["alpha", "error"],
    ]);
    await expect(registry.open("alpha")).rejects.toMatchObject({ code: "duplicate" });
    const before = registry.list().projects.find((p) => p.name === "alpha")!.generation;
    await write({ alpha: dirs.alpha });
    const after = (await registry.refresh()).projects.find((p) => p.name === "alpha")!;
    expect(after.state).toBe("ok");
    expect(after.generation).not.toBe(before);
    await expect(registry.open("alpha", after.generation)).resolves.toBeTruthy();
  });

  it("登録を外す・付け直す・データのフォルダを変えたら世代が変わり、古い世代は断る。参照先のパスだけなら世代は変えずに反映する", async () => {
    const { registry, write, dirs, gen, config } = await setup(["alpha"]);
    const g1 = gen("alpha");
    const ctx = await registry.open("alpha", g1);
    // 参照先のパスだけを変える（次の Preflight から使う）
    await writeFile(config, `projects:\n  alpha:\n    dir: ${dirs.alpha}\n    repos:\n      main: /elsewhere\n`);
    await registry.refresh();
    expect(gen("alpha")).toBe(g1);
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.ws.refs().find((r) => r.name === "main")).toMatchObject({ local: "/elsewhere" });
    // 外して付け直す
    await write({});
    await registry.refresh();
    await expect(registry.open("alpha", g1)).rejects.toMatchObject({ code: "unknown" });
    await write({ alpha: dirs.alpha });
    await registry.refresh();
    expect(gen("alpha")).not.toBe(g1);
    await expect(registry.open("alpha", g1)).rejects.toMatchObject({ code: "changed" });
    // データのフォルダを変える
    const other = (await makeRepo({ name: "other" })).dataDir;
    const g2 = gen("alpha");
    await write({ alpha: other });
    await registry.refresh();
    expect(gen("alpha")).not.toBe(g2);
    expect((await registry.open("alpha", gen("alpha"))).ws.dataDir).toBe(other);
  });

  it("登録から外れても、始めていた Preflight は元のプロジェクトで終わり、そのあとで閉じる", async () => {
    const engine = new GateEngine();
    const { registry, write } = await setup(["alpha"], { engines: { alpha: engine } });
    const ctx = await registry.open("alpha");
    const req = await newRequest(ctx, { title: "長い評価", status: "draft", body: "- 一つ目\n" });
    const started = await ctx.preflight.start(req.id);
    await write({});
    await registry.refresh();
    await expect(registry.open("alpha")).rejects.toBeInstanceOf(RegistryError);
    expect(ctx.preflight.running()).toBe(1);
    engine.release();
    const run = await ctx.preflight.wait(req.id, started.id);
    expect(run?.status).toBe("completed");
  });
});

describe("プロジェクトを跨ぐ API", () => {
  it("一覧・モード。プロジェクトを書かないデータの API は断り、変える操作は登録世代が要る", async () => {
    const { call, at, gen } = await setup(["alpha", "beta"]);
    expect((await call("GET", "/mode")).body).toEqual({ mode: "all-projects" });
    expect((await call("GET", "/projects")).body.projects.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"]);
    expect(await call("GET", "/requests")).toMatchObject({ status: 404, body: { code: "project_required" } });
    expect(await call("POST", "/projects/alpha/requests", { title: "x" })).toMatchObject({ status: 428, body: { code: "generation_required" } });
    expect(await call("POST", "/projects/alpha/requests", { title: "x" }, { [GENERATION_HEADER]: gen("beta") })).toMatchObject({ status: 409, body: { code: "changed" } });
    expect(await call("GET", "/projects/nope/requests")).toMatchObject({ status: 404, body: { code: "unknown" } });
    expect(await call("GET", "/projects/..%2Fetc/requests")).toMatchObject({ status: 404, body: { code: "unknown" } });
    expect(await at("alpha")("GET", "/no-such-api")).toMatchObject({ status: 404, body: { error: expect.stringContaining("API がありません") } });
    expect((await at("alpha")("POST", "/requests", { title: "画面から" })).status).toBe(201);
  });

  it("同じ ID の要望・タスクを持つ2つのプロジェクトでも、詳細・更新・競合・添付・通知が混ざらない", async () => {
    const s = await setup(["alpha"]);
    const a = await s.registry.open("alpha");
    const req = await newRequest(a, { title: "共通の要望" });
    await newTask(a, req.id, { title: "共通のタスク" });
    // 同じ中身を別のフォルダへ写して、別の名前で登録する（ID がそろう）
    const betaDir = join(s.root, "beta-data");
    await cp(s.dirs.alpha, betaDir, { recursive: true });
    await s.write({ alpha: s.dirs.alpha, beta: betaDir });
    await s.registry.refresh();
    const b = await s.registry.open("beta");
    const events = { alpha: [] as ServerEvent[], beta: [] as ServerEvent[] };
    a.ws.on((e) => events.alpha.push(e));
    b.ws.on((e) => events.beta.push(e));

    const patched = await s.at("alpha")("PATCH", `/requests/${req.id}/tasks/T001`, { title: "alpha で直した", rev: 1 });
    expect(patched.status).toBe(200);
    expect((await s.at("beta")("GET", `/requests/${req.id}/tasks/T001`)).body.task.title).toBe("共通のタスク");
    // beta の古い rev は beta の中で競合になり、alpha の内容は返さない
    const conflict = await s.at("beta")("PATCH", `/requests/${req.id}/tasks/T001`, { title: "beta", rev: 9 });
    expect(conflict).toMatchObject({ status: 409, body: { current: { title: "共通のタスク" } } });
    expect(events.alpha.some((e) => e.type === "changed" && e.kind === "task")).toBe(true);
    expect(events.beta.some((e) => e.type === "changed" && e.kind === "task")).toBe(false);
    expect((await s.at("alpha")("GET", `/requests/${req.id}`)).body.request.title).toBe("共通の要望");
  });

  it("2つのプロジェクトで同時に Preflight・生成を動かし、片方の取消は他方に効かない", async () => {
    const engines = { alpha: new GateEngine(), beta: new GateEngine() };
    const summarizers = { alpha: new GateSummarizer(), beta: new GateSummarizer() };
    const s = await setup(["alpha", "beta"], { engines, summarizers });
    const ids: Record<string, { rid: string; run: string }> = {};
    for (const n of ["alpha", "beta"] as const) {
      const ctx = await s.registry.open(n);
      const rid = (await newRequest(ctx, { title: "評価する", status: "draft", body: "- 一つ目\n" })).id;
      const r = await s.at(n)("POST", `/requests/${rid}/preflight`, { engine: "mock" });
      expect(r.status).toBe(202);
      ids[n] = { rid, run: r.body.id };
    }
    expect(engines.alpha.started + engines.beta.started).toBe(2);
    expect((await s.at("alpha")("POST", `/requests/${ids.alpha.rid}/preflight/${ids.alpha.run}/cancel`)).status).toBe(200);
    engines.beta.release();
    const a = await s.registry.open("alpha");
    const b = await s.registry.open("beta");
    expect((await a.preflight.wait(ids.alpha.rid, ids.alpha.run))?.status).toBe("failed");
    expect((await b.preflight.wait(ids.beta.rid, ids.beta.run))?.status).toBe("completed");
  });

  it("ChatGPT の接続は全プロジェクトで1つを使い、テーマ・接続の変更は開いている全プロジェクトへ知らせる", async () => {
    const s = await setup(["alpha", "beta"]);
    const a = await s.registry.open("alpha");
    const b = await s.registry.open("beta");
    expect(a.chatgpt).toBe(s.chatgpt);
    expect(b.chatgpt).toBe(s.chatgpt);
    const got: string[] = [];
    a.ws.on((e) => e.type === "changed" && got.push(`alpha:${e.kind}`));
    b.ws.on((e) => e.type === "changed" && got.push(`beta:${e.kind}`));
    s.registry.notify("user");
    await new Promise((r) => setTimeout(r, 10));
    expect(got.sort()).toEqual(["alpha:user", "beta:user"]);
  });

  it("止めると、実行中の Preflight を取り消して記録し、待ちきれなかった数を返す", async () => {
    const engine = new GateEngine();
    const s = await setup(["alpha"], { engines: { alpha: engine } });
    const ctx = await s.registry.open("alpha");
    const rid = (await newRequest(ctx, { title: "止める", status: "draft", body: "- x\n" })).id;
    const run = await ctx.preflight.start(rid);
    expect(await s.registry.close({ timeoutMs: 2000 })).toEqual({ pending: 0 });
    expect(await ctx.ws.preflight.get(rid, run.id)).toMatchObject({ status: "failed", error: "中止しました" });
    await expect(s.registry.open("alpha")).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("通常の serve の API", () => {
  it("モードを返し、無い API は画面ではなく 404 の JSON", async () => {
    const { dataDir } = await makeRepo();
    const ctx: P3Context = { ...(await openTestProject(dataDir)), projectName: "app" };
    const app = singleProjectApp(ctx);
    expect(await (await app.request("/mode")).json()).toEqual({ mode: "single", project: "app" });
    const res = await app.request("/no-such-api");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("API がありません") });
  });
});

describe("本物の待ち受け（--all-projects）", () => {
  it("ローカルからの ChatGPT の状態は、プロジェクトの下でもプロジェクトを選ばない入口でも読める。止めると待ち受けを閉じる", async () => {
    const root = tempDir("p3-all-serve-");
    const dataDir = join(root, "data");
    await mkdir(join(dataDir, "requests"), { recursive: true });
    await writeTestProject(dataDir, { repos: [] });
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    await mkdir(join(root, "cfg", "infodb-p3"), { recursive: true });
    await writeFile(join(root, "cfg", "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${dataDir}\n`);
    try {
      const port = 4300 + Math.floor(Math.random() * 500);
      const server = await startServer({ allProjects: true, port, host: "127.0.0.1", static: false, settings: resolveMachineSettings({ settings: {} }, {}) });
      const base = `http://127.0.0.1:${port}/api`;
      const top = await (await fetch(`${base}/chatgpt`)).json();
      expect(top).toMatchObject({ connected: false, engine: null });
      const inProject = await (await fetch(`${base}/projects/alpha/chatgpt`)).json();
      expect(inProject.engine).toMatchObject({ name: "codex" });
      expect(await server.close({ timeoutMs: 1000 })).toEqual({ pending: 0 });
      await expect(fetch(`${base}/mode`)).rejects.toThrow("fetch failed");
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });
});

describe("p3 serve --all-projects の引数", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: tempDir("p3-cfg-") } });
  it("serve 以外・--project / --dir と一緒には使えない", () => {
    expect(run(["ls", "--all-projects"])).toMatchObject({ status: 1, stderr: expect.stringContaining("p3 serve でだけ") });
    expect(run(["serve", "--all-projects", "--project", "a"])).toMatchObject({ status: 1, stderr: expect.stringContaining("一緒に使えません") });
    expect(run(["serve", "--all-projects", "--dir", "x"])).toMatchObject({ status: 1, stderr: expect.stringContaining("一緒に使えません") });
  });
});
