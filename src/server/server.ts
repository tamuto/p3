import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { apiRoutes } from "./api/routes.ts";
import { openProject, PCUBE_ROOT } from "./context.ts";

export interface ServeOptions {
  dataDir: string;
  /** 手元のリポジトリ（個人設定） */
  repoRoot?: string;
  port: number;
  host: string;
  /** ビルド済みの画面 (dist/web) も配信する */
  static: boolean;
}

/** ブラウザ用のローカルサーバ。ファイルを監視して画面へ流すビューア兼エディタ */
export async function startServer(opts: ServeOptions) {
  const ctx = await openProject(opts.dataDir, { repoRoot: opts.repoRoot });
  const { ws, preflight } = ctx;
  void ws.watch();

  const app = new Hono();
  app.route("/api", apiRoutes(ctx));
  if (opts.static) {
    // serveStatic の root はカレントからの相対で解釈される
    const root = relative(process.cwd(), `${PCUBE_ROOT}dist/web`) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => {
    console.log(`pcube: ${ws.project.name}`);
    console.log(`  data     ${opts.dataDir}`);
    console.log(`  repo     ${ws.repoRoot}`);
    console.log(`  engines  ${preflight.availableEngines().join(", ")} (default: ${preflight.defaultEngine})`);
    console.log(`  listen   http://${opts.host}:${opts.port}${opts.static ? "" : "  (api only)"}`);
    if (opts.static && !existsSync(`${PCUBE_ROOT}dist/web/index.html`)) {
      console.log(`  ⚠ 画面がビルドされていません。${PCUBE_ROOT} で \`pnpm build\` を実行してください`);
    }
  });
}
