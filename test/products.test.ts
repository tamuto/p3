import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMachineSettings } from "../packages/tasks/src/core/machineSettings.ts";
import { startServer, type RunningServer } from "../packages/p3/src/server/server.ts";
import { PRODUCTS } from "../packages/p3/src/shared/products.ts";
import { tempDir, writeTestProject } from "./helpers.ts";
import { p3 } from "./cliHelpers.ts";

/**
 * serve の製品（docs/architecture.md「p3-observer」）の API。serve は常に tasks と observer の両方を起動し、製品の選択（以前の --products）は無い。
 * /api/mode の products は実際に取り付けた製品と一致すること。
 * 画面（導線・直リンク）は test/ui/products.ui.test.ts、配布物は scripts/verify-pack.mjs・verify-docker.mjs
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

async function serve(opts: Omit<Parameters<typeof startServer>[0], "port" | "host" | "static">) {
  const port = await freePort();
  servers.push(await startServer({ ...opts, port, host: "127.0.0.1", static: false }));
  const base = `http://127.0.0.1:${port}/api`;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: (await res.json()) as Record<string, unknown> };
  };
  return { get };
}

async function project() {
  const root = tempDir("p3-products-");
  const dataDir = join(root, ".p3");
  await mkdir(join(dataDir, "requests"), { recursive: true });
  await writeTestProject(dataDir, { repos: [] });
  return { root, dataDir };
}

describe("製品の選択は無い（以前の --products）", () => {
  it("--products はどのコマンドでも使い方の誤り（1）で、外せば両方を起動することを案内する", () => {
    const cwd = tempDir("p3-products-cli-");
    for (const args of [["serve", "--products", "tasks"], ["serve", "--products", "observer"], ["serve", "--all-projects", "--products", "tasks,observer"], ["whoami", "--products", "observer"], ["observer", "status", "--products", "observer"]]) {
      const r = p3(cwd, args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("--products は使えなくなりました");
      expect(r.err).toContain("常に tasks と observer の両方を起動します");
    }
  });

  it("help には --products が無く、両方を起動することが載っている", () => {
    const help = p3(tempDir("p3-products-help-"), ["help"]);
    expect(help.code).toBe(0);
    expect(help.out).not.toContain("--products");
    expect(help.out).toContain("常にタスク管理（tasks）と観測基盤（observer。/observer）の両方を起動");
  });
});

describe("serve は常に tasks と observer の両方", () => {
  it("通常の serve: /api/mode の products の製品が全部応答する（tasks の API と observer の status API）", async () => {
    const { dataDir } = await project();
    const s = await serve({ dataDir, projectName: "app" });
    expect((await s.get("/mode")).body).toEqual({ mode: "single", project: "app", products: [...PRODUCTS] });
    expect(PRODUCTS).toEqual(["tasks", "observer"]);
    expect((await s.get("/requests")).status).toBe(200);
    expect((await s.get("/observer/status")).body).toMatchObject({ product: "observer", state: "ready", products: ["tasks", "observer"], version: expect.any(String) });
    const missing = await s.get("/observer/nothing");
    expect([missing.status, missing.type]).toEqual([404, expect.stringContaining("application/json")]);
  });

  it("プロジェクトを跨ぐ serve: 一覧・プロジェクトの API と observer の API が並ぶ", async () => {
    const { dataDir } = await project();
    const root = tempDir("p3-products-all-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    await mkdir(join(root, "cfg", "infodb-p3"), { recursive: true });
    await writeFile(join(root, "cfg", "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${dataDir}\n`);
    try {
      const settings = resolveMachineSettings({ settings: {} }, {});
      const s = await serve({ allProjects: true, settings });
      expect((await s.get("/mode")).body).toEqual({ mode: "all-projects", products: ["tasks", "observer"] });
      expect((await s.get("/projects")).body).toMatchObject({ projects: [expect.objectContaining({ name: "alpha" })] });
      expect((await s.get("/projects/alpha/requests")).status).toBe(200);
      expect((await s.get("/observer/status")).body).toMatchObject({ product: "observer", products: ["tasks", "observer"] });
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it("部品だけを使うとき（observer を付けない）は、/api/mode の products も tasks だけ（取り付けたルートと一致する）", async () => {
    const { Hono } = await import("hono");
    const { singleProjectApp } = await import("../packages/p3/src/server/server.ts");
    const { projectsRoutes } = await import("../packages/p3/src/server/api/projectsRoutes.ts");
    const { openProject } = await import("../packages/tasks/src/core/context.ts");
    const { ProjectRegistry } = await import("../packages/p3/src/core/projectRegistry.ts");
    const { chatgptAccount } = await import("../packages/tasks/src/core/chatgpt.ts");
    const { dataDir } = await project();
    const ctx = await openProject(dataDir, {});
    const single = new Hono().route("/api", singleProjectApp(ctx));
    expect(await (await single.request("/api/mode")).json()).toMatchObject({ products: ["tasks"] });
    expect((await single.request("/api/observer/status")).status).toBe(404);
    ctx.ws.close();
    const registry = new ProjectRegistry({
      settings: { path: "", get: async () => resolveMachineSettings({ settings: {} }, {}) },
      chatgpt: chatgptAccount(join(tempDir("p3-products-chatgpt-"), "chatgpt.json")),
      configPath: join(tempDir("p3-products-cfg-"), "config.yaml"),
    });
    const all = new Hono().route("/api", projectsRoutes(registry));
    expect(await (await all.request("/api/mode")).json()).toEqual({ mode: "all-projects", products: ["tasks"] });
    await registry.close({ timeoutMs: 100 });
  });
});
