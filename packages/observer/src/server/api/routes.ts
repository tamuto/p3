import { Hono, type Context } from "hono";
import { observerStatus } from "../../core/status.ts";
import { DefinitionError, DefinitionStore } from "../../core/definitionStore.ts";
import { DEFINITIONS_DIR } from "../../shared/definition.ts";
import type { DefinitionTarget } from "../../shared/status.ts";
import type { SuggestionService } from "../../core/suggest.ts";
import { validateSuggestionRequest } from "../../shared/suggestion.ts";

const STATUS: Record<DefinitionError["code"], 400 | 404 | 409 | 422> = { invalid: 400, not_found: 404, conflict: 409, unreadable: 422 };

/**
 * observer の API。入口の serve が /api/observer（プロジェクトを跨ぐ serve の観測の定義は /api/projects/<名前>/observer）の下に付ける。
 *   GET  /status                 起動状態（ObserverStatus）。プロジェクトを決めなくても使える
 *   GET  /definitions            観測の定義の一覧 { target, definitions, unreadable }（target は登録先: プロジェクト名・保存の場所）
 *   GET  /definitions/:id        1つの定義
 *   POST /definitions            作成（本文は DefinitionInput）。201 で作った定義
 *   PUT  /definitions/:id        更新（本文は { rev: 今の版, definition: DefinitionInput }）。版が違えば 409（current に今の定義）
 *   GET  /suggestions/context    手順の提案の頼む先の状態と、読ませられる参照先（SuggestionContext）
 *   POST /suggestions            手順の提案を始める（本文 { definition: 未保存の入力, repos: 参照先の名前, note: 補足 }）。202 で実行（SuggestionJob）。保存しない
 *   GET  /suggestions/:id        提案の実行（running / completed（result）/ failed（failure・error）/ cancelled）
 *   POST /suggestions/:id/cancel 取り消す
 * 入力の誤りは 400 の { error, code: "invalid", problems: [{ path, message }] }（CLI・画面と同じ検証）。
 * target を渡さないとき（プロジェクトを決めていない）は /status だけを付ける。プロジェクトを跨ぐ serve の登録世代は入口が確かめる
 */
export function observerRoutes(opts: { products?: readonly string[]; target?: DefinitionTarget; suggestions?: SuggestionService } = {}) {
  const app = new Hono();
  app.get("/status", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ ...observerStatus(), ...(opts.products ? { products: [...opts.products] } : {}) });
  });
  const target = opts.target;
  if (target) {
    const store = new DefinitionStore(target.dataDir);
    const info = { project: target.project ?? null, dataDir: target.dataDir, dir: DEFINITIONS_DIR };
    const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";
    const fail = (c: Context, e: unknown) => {
      if (!(e instanceof DefinitionError)) throw e;
      return c.json({ error: e.message, code: e.code, ...(e.problems.length ? { problems: e.problems } : {}), ...(e.current ? { current: e.current } : {}) }, STATUS[e.code]);
    };
    const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);
    app.get("/definitions", async (c) => {
      c.header("cache-control", "no-store");
      return c.json({ target: info, ...(await store.list()) });
    });
    app.get("/definitions/:id", async (c) => {
      c.header("cache-control", "no-store");
      try {
        return c.json({ target: info, definition: await store.get(c.req.param("id")) });
      } catch (e) {
        return fail(c, e);
      }
    });
    app.post("/definitions", async (c) => {
      try {
        return c.json(await store.create(await body(c), actorOf(c)), 201);
      } catch (e) {
        return fail(c, e);
      }
    });
    app.put("/definitions/:id", async (c) => {
      const b = await body(c);
      const rec = typeof b === "object" && b !== null ? (b as { rev?: unknown; definition?: unknown }) : {};
      try {
        return c.json(await store.update(c.req.param("id"), typeof rec.rev === "number" ? rec.rev : Number.NaN, rec.definition, actorOf(c)));
      } catch (e) {
        return fail(c, e);
      }
    });
  }
  const suggestions = target && opts.suggestions;
  if (suggestions) {
    app.get("/suggestions/context", async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await suggestions.context());
    });
    app.post("/suggestions", async (c) => {
      const v = validateSuggestionRequest(await c.req.json().catch(() => undefined));
      if (!v.ok) return c.json({ error: "提案の依頼に誤りがあります", code: "invalid", problems: v.problems }, 400);
      return c.json(suggestions.start(v.value), 202);
    });
    app.get("/suggestions/:id", (c) => {
      c.header("cache-control", "no-store");
      const j = suggestions.get(c.req.param("id"));
      return j ? c.json(j) : c.json({ error: `提案の実行がありません（serve を起動し直すと消えます）: ${c.req.param("id")}`, code: "not_found" }, 404);
    });
    app.post("/suggestions/:id/cancel", (c) => {
      const id = c.req.param("id");
      if (!suggestions.get(id)) return c.json({ error: `提案の実行がありません: ${id}`, code: "not_found" }, 404);
      return c.json({ cancelled: suggestions.cancel(id), job: suggestions.get(id) });
    });
  }
  app.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  return app;
}
