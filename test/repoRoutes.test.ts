import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeRepo, openTestProject, tempDir } from "./helpers.ts";
import { loadUserConfig, saveUserConfig } from "../src/server/userConfig.ts";

const savedHome = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedHome;
});

describe("/api/repos（設定画面の参照先）", () => {
  async function setup() {
    const repo = await makeRepo();
    const config = join(tempDir("p3-config-"), "config.yaml");
    process.env.XDG_CONFIG_HOME = join(config, "..", "..");
    const ctx = await openTestProject(repo.dataDir);
    ctx.projectName = "t";
    await saveUserConfig({ projects: { t: { dir: repo.dataDir, repos: { main: repo.root } } }, ui: { theme: "system" }, settings: {} });
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown, opt: { addr?: string; origin?: string } = {}) => {
      const res = await app.request(
        path,
        { method, headers: { "content-type": "application/json", ...(opt.origin !== undefined ? { origin: opt.origin } : { origin: "http://localhost:4310" }) }, body: body === undefined ? undefined : JSON.stringify(body) },
        { incoming: { socket: { remoteAddress: opt.addr ?? "127.0.0.1" } } },
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    return { repo, ctx, call };
  }

  it("共有の定義を足す・変える（主なフォルダも）・消す。このマシンのパスはローカルの画面からだけ", async () => {
    const { repo, ctx, call } = await setup();
    const docs = tempDir("docs-");
    const list = await call("GET", "/repos");
    expect(list.body).toMatchObject({ local: true, registered: true, repos: [{ name: "main", status: "ok", local: repo.root }] });
    // 無いパスで足そうとしたら、共有の定義も書かない
    expect((await call("POST", "/repos", { name: "docs", path: "/nonexistent/x" })).status).toBe(400);
    expect(ctx.ws.project.repos.map((r) => r.name)).toEqual(["main"]);
    const added = await call("POST", "/repos", { name: "docs", role: "ドキュメント", writable: true, path: docs });
    expect(added.status).toBe(201);
    expect((await loadUserConfig()).projects.t.repos.docs).toBe(docs);
    const patched = await call("PATCH", "/repos/docs", { readFirst: true, map: [{ path: " ./guide/ ", role: "手順書", entry: "guide/index.md" }, { path: "", role: "空は捨てる" }], mapFile: "MAP.md" });
    expect(patched.body).toMatchObject({ readFirst: true, map: [{ path: "guide", role: "手順書", entry: "guide/index.md" }], mapFile: "MAP.md" });
    expect((await call("PATCH", "/repos/docs", { mapFile: null })).body.mapFile).toBeUndefined();
    expect((await call("POST", "/repos", { name: "a:b" })).status).toBe(400);
    expect((await call("POST", "/repos", { name: "docs" })).status).toBe(400);
    // ほかのマシンからは、パスを見せず変えさせない
    const remote = await call("GET", "/repos", undefined, { addr: "192.168.1.20" });
    expect(remote.body.local).toBe(false);
    expect(JSON.stringify(remote.body)).not.toContain(docs);
    expect((await call("PUT", "/repos/docs/path", { path: docs }, { addr: "192.168.1.20" })).status).toBe(403);
    expect((await call("PUT", "/repos/docs/path", { path: docs }, { origin: "http://evil.example" })).status).toBe(403);
    // パスを外す・定義ごと消す
    expect((await call("DELETE", "/repos/docs/path")).status).toBe(200);
    expect((await call("GET", "/repos")).body.repos.find((r: any) => r.name === "docs").status).toBe("unregistered");
    expect((await call("DELETE", "/repos/docs")).status).toBe(200);
    expect(ctx.ws.project.repos.map((r) => r.name)).toEqual(["main"]);
  });
});
