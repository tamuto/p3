import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { apiRoutes } from "./api/routes.ts";
import { openProject, P3_ROOT } from "./context.ts";
import type { MachineSettings, SettingsSource } from "./machineSettings.ts";

export interface ServeOptions {
  dataDir: string;
  /** 参照先の名前 → このマシンのパス（個人設定） */
  repos?: Record<string, string>;
  /** 個人設定に登録したプロジェクト名（設定画面で参照先のこのマシンのパスを書くため） */
  projectName?: string;
  port: number;
  host: string;
  /** ビルド済みの画面 (dist/web) も配信する */
  static: boolean;
  /** マシンごとの設定（省くと環境変数と個人設定から、Preflight を始めるたびに読む） */
  settings?: MachineSettings | SettingsSource;
}

/** ブラウザ用のローカルサーバ。ファイルを監視して画面へ流すビューア兼エディタ */
export async function startServer(opts: ServeOptions) {
  const ctx = await openProject(opts.dataDir, { repos: opts.repos, settings: opts.settings, projectName: opts.projectName });
  const { ws, preflight } = ctx;
  void ws.watch();

  const app = new Hono();
  app.route("/api", apiRoutes(ctx));
  if (opts.static) {
    // serveStatic の root はカレントからの相対で解釈される
    const root = relative(process.cwd(), `${P3_ROOT}dist/web`) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => {
    console.log(`p3: ${ws.project.name}`);
    console.log(`  data     ${opts.dataDir}`);
    console.log(`  repos    ${ws.project.repos.map((r) => r.name).join(", ") || "（なし）"}`);
    console.log(`  engines  ${preflight.availableEngines().join(", ")} (default: ${preflight.defaultEngine})`);
    console.log(`  listen   http://${opts.host}:${opts.port}${opts.static ? "" : "  (api only)"}`);
    if (opts.static && !existsSync(`${P3_ROOT}dist/web/index.html`)) {
      console.log(`  ⚠ 画面がビルドされていません。${P3_ROOT} で \`pnpm build\` を実行してください`);
    }
  });
}
