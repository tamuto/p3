import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { apiRoutes } from "./api/routes.ts";
import { projectsRoutes } from "./api/projectsRoutes.ts";
import { chatgptAccount } from "../core/chatgpt.ts";
import { openProject, P3_ROOT, type P3Context } from "../core/context.ts";
import { machineSettingsSource, type MachineSettings, type SettingsSource } from "../core/machineSettings.ts";
import { ProjectRegistry } from "../core/projectRegistry.ts";

export interface ServeOptions {
  /** 1つのプロジェクトのデータのフォルダ（allProjects のときは使わない） */
  dataDir?: string;
  /** 参照先の名前 → このマシンのパス（個人設定） */
  repos?: Record<string, string>;
  /** 個人設定に登録したプロジェクト名（設定画面で参照先のこのマシンのパスを書くため） */
  projectName?: string;
  /** 個人設定に登録したプロジェクトを跨いで扱う（p3 serve --all-projects） */
  allProjects?: boolean;
  port: number;
  host: string;
  /** ビルド済みの画面 (dist/web) も配信する */
  static: boolean;
  /** マシンごとの設定（省くと環境変数と個人設定から、Preflight を始めるたびに読む） */
  settings?: MachineSettings | SettingsSource;
}

export interface RunningServer {
  /**
   * 止める。新しい接続を断り、開いている接続（SSE を含む）を閉じ、実行中の Preflight・生成を取り消して終わるまで待つ
   * （timeoutMs まで）。監視を外す。待ちきれなかった実行の数を返す
   */
  close(opts?: { timeoutMs?: number }): Promise<{ pending: number }>;
}

/** 1つのプロジェクトの API（通常の serve）。/api の下 */
export function singleProjectApp(ctx: P3Context) {
  const app = new Hono();
  app.get("/mode", (c) => c.json({ mode: "single", project: ctx.projectName ?? null }));
  app.route("/", apiRoutes(ctx));
  // 無い API は画面（index.html）に流さない
  app.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  return app;
}

/** ブラウザ用のローカルサーバ。ファイルを監視して画面へ流すビューア兼エディタ */
export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const app = new Hono();
  let ctx: P3Context | undefined;
  let registry: ProjectRegistry | undefined;
  if (opts.allProjects) {
    const settings = !opts.settings ? machineSettingsSource() : "get" in opts.settings ? opts.settings : { path: "", get: async () => opts.settings as MachineSettings };
    registry = new ProjectRegistry({ settings, chatgpt: chatgptAccount() });
    await registry.refresh();
    app.route("/api", projectsRoutes(registry));
  } else {
    if (!opts.dataDir) throw new Error("serve: データのフォルダが決まっていません");
    ctx = await openProject(opts.dataDir, { repos: opts.repos, settings: opts.settings, projectName: opts.projectName });
    void ctx.ws.watch();
    app.route("/api", singleProjectApp(ctx));
  }
  if (opts.static) {
    // serveStatic の root はカレントからの相対で解釈される
    const root = relative(process.cwd(), `${P3_ROOT}dist/web`) || ".";
    app.use("/*", serveStatic({ root }));
    app.get("*", serveStatic({ path: `${root}/index.html` }));
  }

  const server: ServerType = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => {
    if (registry) {
      const l = registry.list();
      console.log("p3: プロジェクトを跨ぐ serve（--all-projects）");
      console.log(`  projects ${l.projects.map((p) => p.name).join(", ") || "（登録なし。p3 init / p3 join で登録して、画面の一覧を読み直す）"}`);
      if (l.configError) console.log(`  ⚠ ${l.configError}`);
      for (const i of l.invalid) console.log(`  ⚠ 使えない登録 ${i.name}: ${i.reason}`);
    } else if (ctx) {
      console.log(`p3: ${ctx.ws.project.name}`);
      console.log(`  data     ${opts.dataDir}`);
      console.log(`  repos    ${ctx.ws.project.repos.map((r) => r.name).join(", ") || "（なし）"}`);
      console.log(`  engines  ${ctx.preflight.availableEngines().join(", ")} (default: ${ctx.preflight.defaultEngine})`);
    }
    console.log(`  listen   http://${opts.host}:${opts.port}${opts.static ? "" : "  (api only)"}`);
    if (opts.static && !existsSync(`${P3_ROOT}dist/web/index.html`)) {
      console.log(`  ⚠ 画面がビルドされていません。${P3_ROOT} で \`pnpm build\` を実行してください`);
    }
  });

  return {
    async close({ timeoutMs = 10_000 } = {}) {
      // 新しい接続を断り、開いている接続（SSE）を閉じる
      const closed = new Promise<void>((r) => server.close(() => r()));
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      let pending = 0;
      if (registry) pending = (await registry.close({ timeoutMs })).pending;
      else if (ctx) {
        const c = ctx;
        const settle = Promise.all([c.preflight.settle({ cancel: true }), c.releaseGenerator.settle({ cancel: true })]).then(() => false);
        const timedOut = await Promise.race([settle, new Promise<boolean>((r) => setTimeout(() => r(true), timeoutMs).unref())]);
        c.ws.close();
        pending = timedOut ? c.preflight.running() + c.releaseGenerator.running() : 0;
      }
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 1000).unref())]);
      return { pending };
    },
  };
}
