import { Hono, type Context } from "hono";
import { observerStatus } from "../../core/status.ts";
import { DefinitionError, DefinitionStore } from "../../core/definitionStore.ts";
import { WorkStore } from "../../core/workStore.ts";
import { fileChecker } from "../../core/files.ts";
import type { DefinitionTarget } from "../../shared/status.ts";
import type { SuggestionService } from "../../core/suggest.ts";
import { validateSuggestionRequest } from "../../shared/suggestion.ts";

const STATUS: Record<DefinitionError["code"], 400 | 404 | 409 | 422> = { invalid: 400, not_found: 404, conflict: 409, unreadable: 422 };

/**
 * observer の API。アプリの serve が /api/observer（プロジェクトを跨ぐ serve の観測は /api/projects/<名前>/observer）の下に付ける。
 *   GET  /status                       起動状態（ObserverStatus）。プロジェクトを決めなくても使える
 *   GET  /definitions                  観測の定義の一覧 { definitions, unreadable }
 *   POST /definitions                  作成（タイトルと観測内容だけでよい）。201 で作った定義（ID が付く）
 *   GET  /definitions/:id              1つの定義 { definition }
 *   PUT  /definitions/:id              更新（{ rev: 今の版, definition }）。版が違えば 409（current に今の定義）
 *   GET  /definitions/:id/draft        編集途中の入力 { draft }（無ければ null）
 *   PUT  /definitions/:id/draft        保存（{ version: 読んだ版か null, basedOnRev, input }）。版が違えば 409
 *   GET  /definitions/:id/suggestions  提案の履歴（新しい順。実行していたプロセスが終わっていれば interrupted）
 *   POST /definitions/:id/suggestions  提案を頼む（{ definition: 頼むときの入力, note, basedOnRev }）。依頼を保存してから始め、202
 *   GET  /definitions/:id/suggestions/:sid  1件 / POST .../:sid/cancel 取り消す
 *   POST /definitions/:id/procedures/:pid/switch  手順を置き換え候補のスクリプトに切り替える（{ rev, invoke, evidence }。ファイルが有ること・今の版が要る）
 *   GET  /files?ref=<参照先>:<パス>   ファイルの有無 { files: { "<参照先>:<パス>": { state: exists|planned|unverified, checkedAt } } }
 *   GET  /suggestions/context          頼む先の状態とプロジェクトの参照先
 *   POST /suggestions・GET /suggestions/:sid・POST .../cancel  ID の無い互換の経路（未保存の入力。このプロセスの中だけで保存しない）
 * 入力の誤りは 400 の { error, code: "invalid", problems: [{ path, message }] }（CLI・画面と同じ検証）。
 * target を渡さないとき（プロジェクトを決めていない）は /status だけを付ける。プロジェクトを跨ぐ serve の登録世代はアプリが確かめる
 */
export function observerRoutes(opts: { products?: readonly string[]; target?: DefinitionTarget; suggestions?: SuggestionService } = {}) {
  const app = new Hono();
  app.onError((e, c) => {
    if (!(e instanceof DefinitionError)) throw e;
    return c.json({ error: e.message, code: e.code, ...(e.problems.length ? { problems: e.problems } : {}), ...(e.current ? { current: e.current } : {}) }, STATUS[e.code]);
  });
  app.use("*", async (c, next) => {
    await next();
    if (c.req.method === "GET") c.header("cache-control", "no-store");
  });
  app.get("/status", (c) => c.json({ ...observerStatus(), ...(opts.products ? { products: [...opts.products] } : {}) }));
  const { target, suggestions } = opts;
  if (target) {
    const files = target.repoPath && fileChecker(target.repoPath);
    const store = new DefinitionStore(target.dataDir, files);
    const work = new WorkStore(target.dataDir);
    const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";
    const body = async (c: Context): Promise<Record<string, unknown>> => {
      const b: unknown = await c.req.json().catch(() => undefined);
      return typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {};
    };
    const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);
    const id = async (c: Context) => (await store.get(c.req.param("id")!)).id;
    app.get("/definitions", async (c) => c.json(await store.list()));
    app.post("/definitions", async (c) => c.json(await store.create(await body(c), actorOf(c)), 201));
    app.get("/definitions/:id", async (c) => c.json({ definition: await store.get(c.req.param("id")) }));
    app.put("/definitions/:id", async (c) => {
      const b = await body(c);
      return c.json(await store.update(c.req.param("id"), num(b.rev), b.definition, actorOf(c)));
    });
    app.post("/definitions/:id/procedures/:pid/switch", async (c) => {
      const b = await body(c);
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      return c.json(await store.switchProcedure(c.req.param("id"), num(b.rev), c.req.param("pid"), { invoke: str(b.invoke), evidence: str(b.evidence) }, actorOf(c)));
    });
    app.get("/files", (c) => {
      const checkedAt = new Date().toISOString();
      const entries = c.req.queries("ref") ?? [];
      return c.json({ files: Object.fromEntries(entries.map((k) => [k, { state: files && k.includes(":") ? files(k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)) : "unverified", checkedAt }])) });
    });
    app.get("/definitions/:id/draft", async (c) => c.json({ draft: (await work.readDraft(await id(c))) ?? null }));
    app.put("/definitions/:id/draft", async (c) => {
      const b = await body(c);
      return c.json(await work.saveDraft(await id(c), b.version === null ? null : num(b.version), b.input, num(b.basedOnRev), actorOf(c)));
    });
    app.get("/definitions/:id/suggestions", async (c) => c.json({ suggestions: await work.listSuggestions(await id(c)) }));
    app.get("/definitions/:id/suggestions/:sid", async (c) => {
      const j = suggestions?.get(c.req.param("sid")) ?? (await work.getSuggestion(await id(c), c.req.param("sid")));
      return j ? c.json(j) : c.json({ error: `提案がありません: ${c.req.param("sid")}`, code: "not_found" }, 404);
    });
    if (suggestions) {
      app.post("/definitions/:id/suggestions", async (c) => {
        const def = await store.get(c.req.param("id"));
        const { basedOnRev, ...b } = await body(c);
        const v = validateSuggestionRequest(b);
        if (!v.ok) return c.json({ error: "提案の依頼に誤りがあります", code: "invalid", problems: v.problems }, 400);
        return c.json(await suggestions.start(v.value, { definition: def.id, basedOnRev: typeof basedOnRev === "number" ? basedOnRev : def.rev }), 202);
      });
      app.post("/definitions/:id/suggestions/:sid/cancel", async (c) => c.json({ cancelled: suggestions.cancel(c.req.param("sid")), job: suggestions.get(c.req.param("sid")) ?? null }));
      app.get("/suggestions/context", async (c) => c.json(await suggestions.context()));
      app.post("/suggestions", async (c) => {
        const v = validateSuggestionRequest(await body(c));
        if (!v.ok) return c.json({ error: "提案の依頼に誤りがあります", code: "invalid", problems: v.problems }, 400);
        return c.json(await suggestions.start(v.value), 202);
      });
      app.get("/suggestions/:sid", (c) => {
        const j = suggestions.get(c.req.param("sid"));
        return j ? c.json(j) : c.json({ error: `提案の実行がありません（serve を起動し直すと消えます）: ${c.req.param("sid")}`, code: "not_found" }, 404);
      });
      app.post("/suggestions/:sid/cancel", (c) => {
        const sid = c.req.param("sid");
        if (!suggestions.get(sid)) return c.json({ error: `提案の実行がありません: ${sid}`, code: "not_found" }, 404);
        return c.json({ cancelled: suggestions.cancel(sid), job: suggestions.get(sid) });
      });
    }
  }
  app.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  return app;
}
