import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMachineSettings } from "../packages/tasks/src/core/machineSettings.ts";
import { startServer, type RunningServer } from "../packages/p3/src/server/server.ts";
import { DEFAULT_PRODUCTS, parseProducts } from "../packages/p3/src/shared/products.ts";
import { tempDir, writeTestProject } from "./helpers.ts";
import { p3 } from "./cliHelpers.ts";

/**
 * serve の製品の選び方（p3 serve --products。docs/architecture.md「p3-observer」）の API。
 * 3つの起動の構成（tasks だけ・observer だけ・両方）と、プロジェクトを跨ぐ serve との組み合わせを区別できること。
 * 画面（導線・直リンク・ブラウザが要求するもの）は test/ui/products.ui.test.ts、配布物は scripts/verify-pack.mjs・verify-docker.mjs
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

describe("--products の解釈", () => {
  it("省くと tasks だけ。並びは製品の順にそろえ、重複はまとめる。知らない名前・空は理由を返す", () => {
    expect(parseProducts(undefined)).toEqual({ products: [...DEFAULT_PRODUCTS] });
    expect(DEFAULT_PRODUCTS).toEqual(["tasks"]);
    expect(parseProducts("observer,tasks,observer")).toEqual({ products: ["tasks", "observer"] });
    expect(parseProducts(" observer ")).toEqual({ products: ["observer"] });
    expect(parseProducts("")).toMatchObject({ error: expect.stringContaining("製品を指定") });
    expect(parseProducts("tasks,metrics")).toMatchObject({ error: expect.stringContaining("metrics") });
  });

  it("CLI: serve 以外の --products と、tasks を含まない --products に tasks の指定を足したものは使い方の誤り（1）", () => {
    const cwd = tempDir("p3-products-cli-");
    expect(p3(cwd, ["whoami", "--products", "observer"]).code).toBe(1);
    expect(p3(cwd, ["observer", "status", "--products", "observer"]).code).toBe(1);
    for (const extra of [["--all-projects"], ["--project", "x"], ["--dir", "."]]) {
      const r = p3(cwd, ["serve", "--products", "observer", ...extra]);
      expect(r.code, extra.join(" ")).toBe(1);
      expect(r.err).toContain("--products に tasks を含めて");
    }
    const unknown = p3(cwd, ["serve", "--products", "tasks,foo"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("知らない製品です: foo");
  });
});

describe("serve の3つの起動の構成", () => {
  it("tasks だけ（既定）: 今までの API が動き、/api/mode の products は tasks だけ。observer の API は 404 の JSON（画面に流さない）", async () => {
    const { dataDir } = await project();
    const s = await serve({ dataDir, projectName: "app" });
    expect((await s.get("/mode")).body).toEqual({ mode: "single", project: "app", products: ["tasks"] });
    expect((await s.get("/requests")).status).toBe(200);
    const obs = await s.get("/observer/status");
    expect([obs.status, obs.type]).toEqual([404, expect.stringContaining("application/json")]);
  });

  it("observer だけ: tasks の登録が無くても起動し、共通の版と起動状態を返す。tasks の API は 404 の JSON で、何も作らない", async () => {
    const cfg = tempDir("p3-products-cfg-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = cfg;
    try {
      const s = await serve({ products: ["observer"] });
      expect((await s.get("/mode")).body).toEqual({ mode: "none", products: ["observer"] });
      expect((await s.get("/observer/status")).body).toMatchObject({ product: "observer", state: "ready", products: ["observer"], version: expect.any(String) });
      for (const path of ["/requests", "/project", "/settings", "/events", "/projects"]) {
        const r = await s.get(path);
        expect([r.status, r.body.code], path).toEqual([404, "product_disabled"]);
      }
      expect(await readdir(cfg)).toEqual([]);
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it("両方: 同じ serve で tasks の API と observer の API が動く", async () => {
    const { dataDir } = await project();
    const s = await serve({ dataDir, projectName: "app", products: ["tasks", "observer"] });
    expect((await s.get("/mode")).body).toEqual({ mode: "single", project: "app", products: ["tasks", "observer"] });
    expect((await s.get("/requests")).status).toBe(200);
    expect((await s.get("/observer/status")).body).toMatchObject({ product: "observer", products: ["tasks", "observer"] });
    expect((await s.get("/observer/nothing")).status).toBe(404);
  });

  it("プロジェクトを跨ぐ serve と両方: 一覧・プロジェクトの API と observer の API が並ぶ。observer を選ばなければ observer は 404", async () => {
    const { dataDir } = await project();
    const root = tempDir("p3-products-all-");
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    await mkdir(join(root, "cfg", "infodb-p3"), { recursive: true });
    await writeFile(join(root, "cfg", "infodb-p3", "config.yaml"), `projects:\n  alpha:\n    dir: ${dataDir}\n`);
    try {
      const settings = resolveMachineSettings({ settings: {} }, {});
      const both = await serve({ allProjects: true, settings, products: ["tasks", "observer"] });
      expect((await both.get("/mode")).body).toEqual({ mode: "all-projects", products: ["tasks", "observer"] });
      expect((await both.get("/projects")).body).toMatchObject({ projects: [expect.objectContaining({ name: "alpha" })] });
      expect((await both.get("/projects/alpha/requests")).status).toBe(200);
      expect((await both.get("/observer/status")).status).toBe(200);
      const tasksOnly = await serve({ allProjects: true, settings });
      expect((await tasksOnly.get("/mode")).body).toEqual({ mode: "all-projects", products: ["tasks"] });
      expect((await tasksOnly.get("/observer/status")).status).toBe(404);
    } finally {
      process.env.XDG_CONFIG_HOME = prev;
    }
  });
});
