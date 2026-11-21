import { Hono, type Context } from "hono";
import { observerStatus } from "../../core/status.ts";
import { type ChangeContext, DefinitionError, DefinitionStore, PreparationStore } from "../../core/definitionStore.ts";
import type { WorkRef } from "../../shared/definition.ts";
import { WorkStore } from "../../core/workStore.ts";
import { readEnvironment, ResultStore } from "../../core/resultStore.ts";
import { fileChecker, fileHasher } from "../../core/files.ts";
import type { DefinitionTarget } from "../../shared/status.ts";
import type { SuggestionService } from "../../core/suggest.ts";
import type { CandidateService } from "../../core/candidates.ts";
import { validateSuggestionRequest } from "../../shared/suggestion.ts";
import type { Slot } from "../../shared/preparation.ts";

const STATUS: Record<DefinitionError["code"], 400 | 404 | 409 | 422> = { invalid: 400, not_found: 404, conflict: 409, in_use: 409, unreadable: 422 };

/**
 * observer の API。アプリの serve が /api/observer（プロジェクトを跨ぐ serve の観測は /api/projects/<名前>/observer）の下に付ける。
 *   GET  /status                       起動状態（ObserverStatus）。プロジェクトを決めなくても使える
 *   GET  /definitions                  観測の定義の一覧 { definitions, unreadable }
 *   POST /definitions                  作成（タイトルと観測内容だけでよい）。201 で作った定義（ID が付く）
 *   GET  /definitions/:id              1つの定義と、前提の観測・使う準備の名前・期待の見直しの注意 { definition, references, drift }
 *   PUT  /definitions/:id              更新（{ rev: 今の版, definition, reason?: 期待を変えた理由 }）。版が違えば 409（current に今の定義）
 *   POST /definitions/:id/end          終える（{ rev, reason, movedTo? }）。前提として使われていれば 409 の in_use
 *   作成・更新・終了に作業の文脈のヘッダー（x-p3-work: <要望ID>/<T>）を添えると、アプリが確かめて履歴に作業の帰属を残す
 *   GET  /definitions/:id/draft        編集途中の入力 { draft }（無ければ null）
 *   PUT  /definitions/:id/draft        保存（{ version: 読んだ版か null, basedOnRev, input }）。版が違えば 409
 *   GET  /definitions/:id/suggestions  提案の履歴（新しい順。実行していたプロセスが終わっていれば interrupted）
 *   POST /definitions/:id/suggestions  提案を頼む（{ definition: 頼むときの入力, note, basedOnRev }）。依頼を保存してから始め、202
 *   GET  /definitions/:id/suggestions/:sid  1件 / POST .../:sid/cancel 取り消す
 *   POST /definitions/:id/procedures/:pid/switch  手順を置き換え候補のスクリプトに切り替える（{ rev, invoke, evidence }。ファイルが有ること・今の版が要る）
 *   GET  /definitions/:id/results      観測の結果の一覧 { results, unreadable }（新しい順）/ POST 実行を始める（{ note? }。開始時点の定義と準備を写す。201）
 *   GET  /definitions/:id/results/:rid 1件 / POST .../steps 段を1つ記録 / POST .../finish 完了して判定 / POST .../interrupt 中断として閉じる（{ reason }）
 *   GET  /preparations                 準備の一覧 { items, unreadable } / POST 作成（201）
 *   GET  /preparations/:id             1つの準備と、それを使う観測 { preparation, usedBy: { definitions, unreadable } }
 *   PUT  /preparations/:id             更新（{ rev, preparation }）/ DELETE ?rev=<今の版> 消す（使っている観測があれば 409 の in_use）
 *   POST /preparations/:id/:slot/switch  確かめ・前処理・後処理（check|setup|teardown）を置き換え候補に切り替える（{ rev, invoke, evidence }）
 *   POST /candidates                   観測の候補を頼む（{ note? }。人が頼んだときだけ）。202 で依頼 / GET /candidates・/candidates/:cid 履歴・1件
 *   POST /definitions?candidate=<CID>&n=<番号>&origin=1  候補から作り、確かめた推定の経緯を残す（origin を付けたときだけ）
 *   GET  /files?ref=<参照先>:<パス>   ファイルの有無 { files: { "<参照先>:<パス>": { state: exists|planned|unverified, checkedAt } } }
 *   GET  /suggestions/context          頼む先の状態とプロジェクトの参照先
 *   POST /suggestions・GET /suggestions/:sid・POST .../cancel  ID の無い互換の経路（未保存の入力。このプロセスの中だけで保存しない）
 * 入力の誤りは 400 の { error, code: "invalid", problems: [{ path, message }] }（CLI・画面と同じ検証）。
 * target を渡さないとき（プロジェクトを決めていない）は /status だけを付ける。プロジェクトを跨ぐ serve の登録世代はアプリが確かめる
 */
/** 画面がタスクの詳細から移ったときに添える作業の文脈（<要望ID>/<T>） */
export const WORK_HEADER = "x-p3-work";

export function observerRoutes(
  opts: { products?: readonly string[]; target?: DefinitionTarget; suggestions?: SuggestionService; candidates?: CandidateService; resolveWork?: (ref: string) => { ok: true; work: WorkRef } | { ok: false; reason: string } } = {},
) {
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
    const store = new DefinitionStore(target.dataDir, files, target.repoPath && fileHasher(target.repoPath));
    const work = new WorkStore(target.dataDir);
    const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";
    const body = async (c: Context): Promise<Record<string, unknown>> => {
      const b: unknown = await c.req.json().catch(() => undefined);
      return typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {};
    };
    const num = (v: unknown) => (typeof v === "number" ? v : Number.NaN);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const id = async (c: Context) => (await store.get(c.req.param("id")!)).id;
    // 作業の帰属: 作業の文脈のヘッダーがあれば、アプリが同じプロジェクトの作業中のタスクかを確かめる（確かめられなければ断る）
    const change = (c: Context, reason?: unknown): ChangeContext => {
      const ref = c.req.header(WORK_HEADER);
      const r = typeof reason === "string" ? { reason } : {};
      if (!ref) return r;
      const w = opts.resolveWork?.(ref) ?? { ok: false as const, reason: "作業の文脈を確かめられません" };
      if (!w.ok) throw new DefinitionError("invalid", w.reason, [{ path: "work", message: w.reason }]);
      return { ...r, work: w.work };
    };
    app.get("/definitions", async (c) => c.json(await store.list()));
    app.post("/definitions", async (c) => {
      // 観測の候補から作るとき（?candidate=<CID>&n=<番号>&origin=1）は、記録した候補の推定の経緯を、利用者が確かめたときだけ残す
      const cid = c.req.query("candidate");
      const cand = cid ? (await work.getCandidates(cid))?.candidates?.[Number(c.req.query("n"))] : undefined;
      if (cid && !cand) throw new DefinitionError("not_found", `観測の候補がありません: ${cid}#${c.req.query("n")}`);
      const origin = c.req.query("origin") === "1" ? cand?.estimatedOrigin : undefined;
      return c.json(await store.create(await body(c), actorOf(c), { ...change(c), ...(origin ? { estimatedOrigin: origin } : {}) }), 201);
    });
    app.get("/candidates", async (c) => c.json({ candidates: await work.listCandidates() }));
    app.get("/candidates/:cid", async (c) => {
      const j = await work.getCandidates(c.req.param("cid"));
      return j ? c.json(j) : c.json({ error: `観測の候補の依頼がありません: ${c.req.param("cid")}`, code: "not_found" }, 404);
    });
    if (opts.candidates) {
      const cands = opts.candidates;
      app.post("/candidates", async (c) => c.json(await cands.start(str((await body(c)).note)), 202));
    }
    app.get("/definitions/:id", async (c) => {
      const d = await store.get(c.req.param("id"));
      return c.json({ definition: d, references: await store.references(d), drift: await store.drift(d) });
    });
    app.put("/definitions/:id", async (c) => {
      const b = await body(c);
      return c.json(await store.update(c.req.param("id"), num(b.rev), b.definition, actorOf(c), change(c, b.reason)));
    });
    app.post("/definitions/:id/end", async (c) => {
      const b = await body(c);
      return c.json(await store.end(c.req.param("id"), num(b.rev), { reason: str(b.reason), movedTo: str(b.movedTo) }, actorOf(c), change(c)));
    });
    app.post("/definitions/:id/procedures/:pid/switch", async (c) => {
      const b = await body(c);
      return c.json(await store.switchProcedure(c.req.param("id"), num(b.rev), c.req.param("pid"), { invoke: str(b.invoke), evidence: str(b.evidence) }, actorOf(c)));
    });
    const preps = new PreparationStore(target.dataDir, files);
    // 観測の実行と結果（P3 は手順を実行しない。人か担当の AI が実行して記録する）
    const results = new ResultStore(target.dataDir, store, preps);
    app.get("/definitions/:id/results", async (c) => c.json(await results.list(c.req.param("id"))));
    app.post("/definitions/:id/results", async (c) => {
      const b = await body(c);
      return c.json(await results.start(c.req.param("id"), actorOf(c), { repos: readEnvironment((target.repoNames?.() ?? []).map((n) => [n, target.repoPath?.(n)])), note: str(b.note) }), 201);
    });
    app.get("/definitions/:id/results/:rid", async (c) => c.json(await results.get(c.req.param("id"), c.req.param("rid"))));
    app.post("/definitions/:id/results/:rid/steps", async (c) => c.json(await results.record(c.req.param("id"), c.req.param("rid"), await body(c), actorOf(c))));
    app.post("/definitions/:id/results/:rid/finish", async (c) => c.json(await results.finish(c.req.param("id"), c.req.param("rid"), actorOf(c))));
    app.post("/definitions/:id/results/:rid/interrupt", async (c) => c.json(await results.interrupt(c.req.param("id"), c.req.param("rid"), actorOf(c), str((await body(c)).reason) ?? "")));
    app.get("/preparations", async (c) => c.json(await preps.list()));
    app.post("/preparations", async (c) => c.json(await preps.create(await body(c), actorOf(c)), 201));
    app.get("/preparations/:id", async (c) => {
      const p = await preps.get(c.req.param("id"));
      return c.json({ preparation: p, usedBy: await preps.usedBy(p.id) });
    });
    app.put("/preparations/:id", async (c) => {
      const b = await body(c);
      return c.json(await preps.update(c.req.param("id"), num(b.rev), b.preparation, actorOf(c)));
    });
    app.delete("/preparations/:id", async (c) => {
      await preps.remove(c.req.param("id"), Number(c.req.query("rev")));
      return c.json({ deleted: c.req.param("id") });
    });
    app.post("/preparations/:id/:slot/switch", async (c) => {
      const b = await body(c);
      return c.json(await preps.switchSlot(c.req.param("id"), num(b.rev), c.req.param("slot") as Slot, { invoke: str(b.invoke), evidence: str(b.evidence) }, actorOf(c)));
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
