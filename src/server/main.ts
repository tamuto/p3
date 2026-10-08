import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { apiRoutes } from "./api/routes.ts";
import { ProjectIndex } from "./intel/index.ts";
import { CodexWorkspaceEngine, codexConfigFromEnv } from "./preflight/codexEngine.ts";
import type { PreflightEngine } from "./preflight/engine.ts";
import { MockEngine } from "./preflight/mockEngine.ts";
import { PreflightService } from "./preflight/service.ts";
import { seedDemo } from "./scripts/seedDemo.ts";
import { Workspace } from "./store/workspace.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // .env は任意
}

const DEMO_DIR = ".pcube-demo";
const dataDir = resolve(process.env.PCUBE_DATA_DIR ?? DEMO_DIR);
if (!process.env.PCUBE_DATA_DIR && !existsSync(dataDir)) await seedDemo(dataDir);

const ws = new Workspace(dataDir);
await ws.load();
void ws.watch();
const index = new ProjectIndex(ws);

const engines: Partial<Record<PreflightEngine["name"], PreflightEngine>> = { mock: new MockEngine() };
const codexCfg = codexConfigFromEnv();
if (codexCfg) engines.codex = new CodexWorkspaceEngine(codexCfg);
const defaultEngine = (process.env.PCUBE_PREFLIGHT_ENGINE as PreflightEngine["name"]) ?? (codexCfg ? "codex" : "mock");
const preflight = new PreflightService(ws, index, engines, defaultEngine);

const app = new Hono();
app.route("/api", apiRoutes(ws, index, preflight));
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "dist/web" }));
  app.get("*", serveStatic({ path: "dist/web/index.html" }));
}

const port = Number(process.env.PCUBE_PORT ?? 4310);
// DevContainer の外（ホストのブラウザ）から見られるよう、既定ですべてのインターフェースで待ち受ける
const host = process.env.PCUBE_HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`pcube: ${ws.project.name}`);
  console.log(`  data     ${dataDir}`);
  console.log(`  repo     ${ws.repoRoot}`);
  console.log(`  engines  ${Object.keys(engines).join(", ")} (default: ${defaultEngine})`);
  console.log(`  listen   http://${host}:${port}  (api: /api)`);
});
