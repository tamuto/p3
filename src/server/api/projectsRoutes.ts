import { Hono, type Context } from "hono";
import type { P3Context } from "../../core/context.ts";
import { ProjectRegistry, RegistryError } from "../../core/projectRegistry.ts";
import { PROJECT_NAME } from "../../core/userConfig.ts";
import { chatgptRoutes } from "./chatgptRoutes.ts";
import { apiRoutes, eventStream } from "./routes.ts";
import { userThemeRoutes, userThemeScriptRoute } from "./userThemeRoutes.ts";
import { AI_MANIFEST } from "./manifest.ts";

/** 変える操作に添える登録世代のヘッダー（GET でも添えれば、違うときは断る） */
export const GENERATION_HEADER = "x-p3-project-generation";

const STATUS: Record<RegistryError["code"], 404 | 409 | 503> = { unknown: 404, changed: 409, duplicate: 409, unavailable: 503 };

/**
 * プロジェクトを跨ぐ serve の API（/api の下）。個人設定に登録した名前だけを扱う。
 *
 *   GET  /mode                         { mode: "all-projects" }
 *   GET  /projects                     個人設定を読み直した一覧（登録世代・開けない理由・形の違う登録・個人設定の読めない理由）
 *   *    /projects/:project/...        そのプロジェクトの API（通常の serve の /api/... と同じ）。変える操作には登録世代のヘッダーが要る
 *   GET  /events                       一覧・テーマ・ChatGPT の接続の変更の知らせ（プロジェクトを選んでいない画面のため）
 *   /chatgpt・/user-theme・/user-theme.js・/ai/manifest  プロジェクトを選ばなくても使える（ローカルだけの操作は今までどおり）
 *
 * プロジェクトを書かないデータの API（/api/requests など）は 404（code: project_required）で断る。
 */
export function projectsRoutes(registry: ProjectRegistry) {
  const app = new Hono();
  /** 文脈ごとの API（文脈を閉じたら消える） */
  const routes = new WeakMap<P3Context, Hono>();
  const routesOf = (ctx: P3Context) => {
    let r = routes.get(ctx);
    if (!r) {
      r = new Hono();
      r.route("/", apiRoutes(ctx, { notify: (kind) => registry.notify(kind) }));
      // 無い API は 404 の JSON（画面の index.html に流さない）
      r.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
      routes.set(ctx, r);
    }
    return r;
  };

  app.get("/mode", (c) => c.json({ mode: "all-projects" }));
  app.get("/projects", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await registry.refresh());
  });
  app.get("/events", (c) => eventStream(c, (push) => registry.on((kind) => push({ type: "changed", kind }))));
  app.route("/chatgpt", chatgptRoutes(registry.chatgpt, { changed: () => registry.notify("chatgpt") }));
  app.route("/user-theme", userThemeRoutes(() => registry.notify("user")));
  app.route("/user-theme.js", userThemeScriptRoute());
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));

  app.all("/projects/:project/*", async (c) => {
    const name = c.req.param("project");
    if (!PROJECT_NAME.test(name)) return c.json({ error: `プロジェクトの名前が正しくありません: ${name}`, code: "unknown" }, 404);
    const generation = c.req.header(GENERATION_HEADER);
    const mutating = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (mutating && !generation) {
      return c.json({ error: `変える操作には登録世代（${GENERATION_HEADER}）が要ります。一覧（GET /api/projects）を読んでから送ってください`, code: "generation_required" }, 428);
    }
    let ctx: P3Context;
    try {
      ctx = await registry.open(name, generation);
    } catch (e) {
      if (e instanceof RegistryError) return c.json({ error: e.message, code: e.code }, STATUS[e.code]);
      throw e;
    }
    return forward(c, routesOf(ctx), `/projects/${name}`);
  });

  // プロジェクトを書かないデータの API は、どのプロジェクトか分からないので断る
  app.all("*", (c) =>
    c.json({ error: "プロジェクトを跨ぐ serve では、/api/projects/<名前>/... で対象のプロジェクトを指定してください", code: "project_required" }, 404),
  );
  return app;
}

/** /api/projects/<名前> を外して、そのプロジェクトの API へ渡す（接続元の情報 c.env はそのまま。ローカルだけの操作の確かめに使う） */
async function forward(c: Context, target: Hono, prefix: string) {
  const url = new URL(c.req.url);
  const at = url.pathname.indexOf(prefix);
  url.pathname = url.pathname.slice(at + prefix.length) || "/";
  const raw = c.req.raw;
  const body = raw.method === "GET" || raw.method === "HEAD" ? undefined : raw.body;
  // 本文は流れのまま渡す（Node の fetch は流れの本文に duplex: "half" が要る。型の RequestInit には無い）
  const init: RequestInit & { duplex?: "half" } = { method: raw.method, headers: raw.headers, body, signal: raw.signal, ...(body ? { duplex: "half" } : {}) };
  const req = new Request(url, init);
  return target.fetch(req, c.env);
}
