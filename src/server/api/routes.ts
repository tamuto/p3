import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { normalizeTaskId } from "../../shared/refs.ts";
import { REQUEST_STATUSES, type Request, type ServerEvent, type Task, TASK_STATUSES, type AttachmentFormat } from "../../shared/types.ts";
import type { P3Context } from "../../core/context.ts";
import { listTasks, progress, resolve } from "../../core/ops.ts";
import { ConflictError, NotFoundError } from "../../core/store/collection.ts";
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES, AttachmentError, safeFileName } from "../../core/store/attachments.ts";
import { bodyLimit } from "hono/body-limit";
import { ReloadError } from "../../core/store/workspace.ts";
import { completionCheckOf, hierarchyNow, resolvedIssue } from "../../core/requestStatus.ts";
import { HierarchyError, hierarchyView } from "../../core/hierarchy.ts";
import { supersededMarks } from "../../core/supersede.ts";
import { chatgptRoutes } from "./chatgptRoutes.ts";
import { userThemeRoutes, userThemeScriptRoute } from "./userThemeRoutes.ts";
import { UserConfigError } from "../../core/userConfig.ts";
import { AI_MANIFEST } from "./manifest.ts";
import { repoRoutes } from "./repoRoutes.ts";
import { releaseNoteRoutes } from "./releaseNoteRoutes.ts";
import { archiveTask, checkMilestoneRemoval, createRequest, createTask, orderChildren, updateRequest, updateTask } from "../../core/requestOps.ts";
import { StaleInputError } from "../../core/preflight/input.ts";
import { ChildConflictError, ChildDraftsChangedError, DraftConflictError, PulseInputError } from "../../core/preflight/service.ts";

/**
 * ブラウザ用のローカル API。AI や人の操作は CLI（ファイルを直接読み書き）が主で、ここは画面のため。
 *
 *   /requests                              要望（進捗つき）
 *   /requests/:rid                         要望の詳細
 *   /requests/:rid/tasks[/:tid]            要望のタスク
 *   /requests/:rid/preflight[/:run]        Preflight
 *   /requests/:rid/notes                   Preflight へのメモ
 *   /release-notes[/:mid]                  マイルストーンのリリースノート（releaseNoteRoutes.ts）
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const taskInput = z.object({
  title: z.string().min(1),
  /** 作業先（参照先の名前）。null は作業先なし */
  repo: z.string().nullable().optional(),
  repoOutputs: z.array(z.object({ repo: z.string().min(1), output: z.string().min(1) })).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  labels: z.array(z.string()).optional(),
  areas: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  body: z.string().optional(),
  /** 変更の記録（Markdown。完了にするときに書く） */
  record: z.string().nullable().optional(),
});
/** checked: 完了したタスクに人が「済み」を付ける / 外す */
const taskPatch = taskInput.partial().extend({ rev: z.number().int().optional(), checked: z.boolean().optional() });
const requestInput = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  areas: z.array(z.string()).optional(),
  due: date.nullish(),
  milestone: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  /** 親の要望 ID（子の要望にする。PATCH の null は親を外す） */
  parent: z.string().nullish(),
});
const requestPatch = requestInput
  .partial()
  .extend({ status: z.enum(REQUEST_STATUSES as [string, ...string[]]).optional(), rev: z.number().int().optional() });
/** 子の表示順: 直下の子の ID を全部、上から順に */
const childOrderInput = z.object({ children: z.array(z.string().min(1)), rev: z.number().int().optional() });
const projectPatch = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    milestones: z.array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9._-]+$/, "マイルストーンの id は英数字と . _ -"),
        title: z.string().min(1),
        due: date.optional(),
        done: z.boolean().optional(),
      }),
    ),
    branchPattern: z.string().includes("{id}"),
    preflight: z.object({ instructions: z.string() }),
  })
  .partial()
  .superRefine((p, ctx) => {
    for (const [label, ids] of [["マイルストーン", p.milestones?.map((x) => x.id) ?? []]] as const) {
      const dup = ids.find((x, i) => ids.indexOf(x) !== i);
      if (dup) ctx.addIssue({ code: "custom", message: `${label}の id が重複しています: ${dup}` });
    }
  });

/** null は「項目を消す」意味。frontmatter から外すため undefined に変換 */
const unnull = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? undefined : v])) as {
    [K in keyof T]: Exclude<T[K], null>;
  };

/** 誰が変更したか */
const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";

/** 楽観ロック: body.rev か If-Match ヘッダ */
const expectedRev = (c: Context, body: { rev?: number }) => body.rev ?? (c.req.header("if-match") ? Number(c.req.header("if-match")) : undefined);

/** 原本を返す。xlsx は必ずダウンロードにし、画像も中身を推測させない */
function download(c: Context, data: Buffer, format: AttachmentFormat, name: string) {
  const file = safeFileName(name, format);
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": ATTACHMENT_TYPES[format],
    "Content-Disposition": `${format === "xlsx" ? "attachment" : "inline"}; filename="${file.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "private, no-cache",
  });
}

/**
 * notify: プロジェクトに属さない変更（ChatGPT の接続・テーマ）の知らせ方。省くとこのプロジェクトの画面へだけ流す
 * （プロジェクトを跨ぐ serve では開いている全プロジェクトへ）
 */
export function apiRoutes(ctx: P3Context, opts: { notify?: (kind: "user" | "chatgpt") => void } = {}) {
  const { ws, preflight } = ctx;
  const notify = opts.notify ?? ((kind: "user" | "chatgpt") => ws.emit({ type: "changed", kind }));
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    // 409 は code で分ける: rev_conflict（読み直してやり直す）/ stale_input（評価のあとで要望が変わった。再評価する）
    if (err instanceof DraftConflictError || err instanceof ChildConflictError) return c.json({ error: err.message, code: "rev_conflict", current: err.current }, 409);
    if (err instanceof ChildDraftsChangedError) return c.json({ error: err.message, code: err.code }, 409);
    if (err instanceof StaleInputError) return c.json({ error: err.message, code: err.code, inputMatch: err.match }, 409);
    if (err instanceof ConflictError) {
      const current = err.id.includes("/") ? ws.task(err.id) : c.req.param("tid") ? ws.tasksOf(c.req.param("rid")!).get(err.id) : ws.requests.get(err.id);
      return c.json({ error: err.message, code: "rev_conflict", current }, 409);
    }
    // 要望の親子（code: hierarchy_invalid・hierarchy_busy・has_children・has_parent。何も書いていない）
    if (err instanceof HierarchyError) return c.json({ error: err.message, code: err.code, ...err.detail }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    // 個人設定のファイルが読めない・壊れている（ファイルは変えていない）
    if (err instanceof UserConfigError) return c.json({ error: err.message }, 500);
    // データのフォルダが読めない（メモリ上の状態は変えていない）
    if (err instanceof ReloadError) return c.json({ error: err.message }, 503);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  /** パスの要望 ID（存在しなければ 404） */
  const rid = (c: Context) => ws.requests.require(c.req.param("rid")!).id;
  /** パスのタスク ID（T3 / 3 も可） */
  const tid = (c: Context) => normalizeTaskId(c.req.param("tid")!) ?? c.req.param("tid")!;

  // --- meta ---------------------------------------------------------------
  app.get("/project", (c) =>
    c.json({
      project: ws.project,
      dataDir: ws.dataDir,
      engines: preflight.availableEngines(),
      defaultEngine: preflight.defaultEngine,
      errors: ws.errors(),
    }),
  );
  app.put("/project", async (c) => {
    const patch = projectPatch.parse(await c.req.json());
    // 使っている要望・リリースノートのあるマイルストーンは消さない（CLI の milestone rm と同じ規則）
    if (patch.milestones) await checkMilestoneRemoval(ctx, patch.milestones.map((m) => m.id));
    return c.json(await ws.saveProject(patch));
  });
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));
  /** 参照先（設定画面。このマシンのパスはローカルの画面からだけ） */
  app.route("/repos", repoRoutes(ctx));
  /** データのフォルダを全部読み直す（ファイル監視に頼らない取り込み）。終わったら変更通知 kind: "reload" */
  app.post("/reload", async (c) => c.json(await ws.reloadAll()));
  /** Preflight のエンジンが使えるか（Codex なら Docker・認証・イメージを確かめる） */
  app.get("/engine", async (c) => c.json(await preflight.engineStatus()));
  if (ctx.chatgpt) app.route("/chatgpt", chatgptRoutes(ctx.chatgpt, { changed: () => notify("chatgpt"), engine: () => preflight.engineStatus() }));
  /** 個人設定のテーマ（このマシンのすべてのプロジェクトで共通。ほかの個人設定は扱わない） */
  app.route("/user-theme", userThemeRoutes(() => notify("user")));
  /** 最初の描画の前に読むスクリプト（index.html の先頭）。テーマだけを埋め込み、キャッシュさせない */
  app.route("/user-theme.js", userThemeScriptRoute());

  /** マイルストーンのリリースノート（材料・保存・出力・要約の生成） */
  app.route("/", releaseNoteRoutes(ctx));

  // --- requests -------------------------------------------------------------
  app.get("/requests", (c) => {
    // ?parent=<ID>: 直下の子だけを、親の表示順（子の一覧・詳細と同じ）で。省くと更新の新しい順
    const parent = c.req.query("parent");
    const all = progress(ctx);
    if (parent === undefined) return c.json(all);
    const rows = new Map(all.map((p) => [p.request.id, p]));
    return c.json(hierarchyNow(ws).children(parent).flatMap((r) => rows.get(r.id) ?? []));
  });
  app.post("/requests", async (c) => {
    const b = unnull(requestInput.parse(await c.req.json()));
    return c.json(await createRequest(ctx, b, actorOf(c)), 201);
  });
  app.get("/requests/:rid", async (c) => {
    const id = rid(c);
    return c.json({
      request: ws.requests.get(id),
      tasks: ws.tasksOf(id).list(),
      runs: await Promise.all((await preflight.list(id)).map((r) => preflight.withInputMatch(id, r))),
      // 対応済なのに未完了のタスクがある（外部の直接編集など）
      issue: resolvedIssue(ws, ws.requests.require(id)) ?? null,
      // 親子（parent・ancestors・children・hierarchyIssues）と、対応済にできるか（blocker・見送りで対象外の子 excluded）
      ...(await hierarchyView(ws, id)),
      completion: completionCheckOf(ws, hierarchyNow(ws), id),
      // 置き換えられたタスクの印（T001 → 置き換えた側）
      superseded: Object.fromEntries(
        [...supersededMarks(ws)].filter(([ref]) => ref.startsWith(`${id}/`)).map(([ref, m]) => [ref.slice(id.length + 1), m]),
      ),
    });
  });
  app.patch("/requests/:rid", async (c) => {
    const { rev, ...patch } = requestPatch.parse(await c.req.json());
    return c.json(await updateRequest(ctx, rid(c), unnull(patch) as Partial<Request>, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) }));
  });

  /** 子の表示順（直下の子を全部、上から順に。CLI の request order と同じ操作） */
  app.put("/requests/:rid/child-order", async (c) => {
    const { children, rev } = childOrderInput.parse(await c.req.json());
    const id = rid(c);
    const r = await orderChildren(ctx, id, children, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ request: r, children: hierarchyNow(ws).children(id).map((k) => k.id) });
  });

  // --- tasks（要望の中） --------------------------------------------------------
  app.get("/requests/:rid/tasks", (c) => {
    const { status, area, q } = c.req.query();
    return c.json(listTasks(ctx, { request: rid(c), status: status?.split(","), area, q }));
  });
  app.post("/requests/:rid/tasks", async (c) => {
    const raw = taskInput.parse(await c.req.json());
    const { repo, ...b } = unnull(raw);
    // 作業先は null（作業先なし）を残す。書かなければ既定（requestOps.createTask）
    const input = { ...b, ...("repo" in raw ? { repo: raw.repo ?? null } : {}) } as Partial<Task> & { title: string };
    const { task, reopened, reopenedAncestors, warnings } = await createTask(ctx, rid(c), input, actorOf(c));
    return c.json({ ...task, ...(reopened ? { reopened } : {}), ...(reopenedAncestors ? { reopenedAncestors } : {}), ...(warnings.length ? { warnings } : {}) }, 201);
  });
  app.get("/requests/:rid/tasks/:tid", (c) => {
    const task = ws.tasksOf(rid(c)).require(tid(c));
    return c.json({ task, superseded: supersededMarks(ws).get(task.ref) ?? [] });
  });
  app.patch("/requests/:rid/tasks/:tid", async (c) => {
    const { rev, checked, ...patch } = taskPatch.parse(await c.req.json());
    const next = { ...(unnull(patch) as Partial<Task>), ...("repo" in patch ? { repo: patch.repo ?? null } : {}), ...(checked !== undefined ? { checked } : {}) };
    // 置き換えられたタスクを作業中にしたら警告を添える（操作は続ける）
    const { task, warnings, reopened, reopenedAncestors } = await updateTask(ctx, rid(c), tid(c), next, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    return c.json({ ...task, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}), ...(reopenedAncestors ? { reopenedAncestors } : {}) });
  });
  app.delete("/requests/:rid/tasks/:tid", async (c) => {
    await archiveTask(ctx, rid(c), tid(c));
    return c.json({ ok: true });
  });

  // --- preflight ----------------------------------------------------------
  app.post("/requests/:rid/preflight", async (c) => {
    const body = z
      .object({ engine: z.enum(["codex", "mock"]).optional(), note: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const id = rid(c);
    const actor = actorOf(c);
    // メモを書き足してから実行する。実行を始められなくてもメモは残し、その ID を返す（再試行で書き直さない）
    const note = body.note?.trim() ? await preflight.addNote(id, body.note, actor) : undefined;
    try {
      return c.json(await preflight.start(id, { engine: body.engine, actor }), 202);
    } catch (e) {
      if (!note) throw e;
      return c.json({ error: (e as Error).message, note }, 400);
    }
  });
  app.get("/requests/:rid/notes", async (c) => {
    const id = rid(c);
    const [{ notes, invalid }, carry] = await Promise.all([ws.notes.list(id), preflight.carryover(id)]);
    const pending = new Set(carry.notes.map((n) => n.id));
    return c.json({
      notes: notes.map((n) => ({ ...n, pending: pending.has(n.id) })),
      invalid,
      previous: carry.previous?.id ?? null,
      previousSkipped: carry.previousSkipped ?? null,
    });
  });
  app.post("/requests/:rid/notes", async (c) => {
    const { body } = z.object({ body: z.string() }).parse(await c.req.json());
    return c.json(await preflight.addNote(rid(c), body, actorOf(c)), 201);
  });
  // run ごとに、評価対象と今の要望が同じか（inputMatch）を添える
  app.get("/requests/:rid/preflight", async (c) => {
    const id = rid(c);
    return c.json(await Promise.all((await preflight.list(id)).map((r) => preflight.withInputMatch(id, r))));
  });
  // 最新の Preflight と見ている run の今の状態（ディスクから読むだけ。開いている要望の画面が軽く確かめる）。キャッシュの要望は使わない
  app.get("/requests/:rid/preflight-status", async (c) => {
    try {
      return c.json(await preflight.pulse(c.req.param("rid"), c.req.query("run")));
    } catch (e) {
      if (e instanceof PulseInputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.get("/requests/:rid/preflight/:run", async (c) => {
    const id = rid(c);
    const run = await preflight.get(id, c.req.param("run"));
    if (!run) throw new NotFoundError(c.req.param("run"));
    return c.json(await preflight.withInputMatch(id, run));
  });
  // 画面資料の画像（PNG / JPEG）。要望 / run / 資料 ID で決め、パスは受け取らない。原稿（HTML）は配信しない
  app.get("/requests/:rid/preflight/:run/ui/:material", async (c) => {
    const { data, type } = await preflight.uiImage(rid(c), c.req.param("run"), c.req.param("material"));
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "private, max-age=3600",
    });
  });
  // 添付（画像・xlsx）。原本はダウンロードとして返す（画像も画面には ui の資料として出す）
  app.get("/requests/:rid/attachments", async (c) => c.json({ ...(await ws.attachments.list(rid(c))), limits: ATTACHMENT_LIMITS }));
  app.post("/requests/:rid/attachments", bodyLimit({ maxSize: ATTACHMENT_LIMITS.xlsxBytes + 1024 * 1024, onError: (c) => c.json({ error: "大きすぎます" }, 413) }), async (c) => {
    const id = rid(c);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return c.json({ error: "file（ファイル）を付けてください" }, 400);
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    try {
      const a = await preflight.addAttachment(id, { data: Buffer.from(await file.arrayBuffer()), name: file.name, description: text(form.description), source: text(form.source) }, actorOf(c));
      return c.json(a, 201);
    } catch (e) {
      if (e instanceof AttachmentError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.get("/requests/:rid/attachments/:aid", async (c) => {
    const { meta, data } = await ws.attachments.content(rid(c), c.req.param("aid")).catch((e) => {
      throw e instanceof AttachmentError ? new NotFoundError(e.message) : e;
    });
    return download(c, data, meta.format, meta.name);
  });
  app.delete("/requests/:rid/attachments/:aid", async (c) => {
    try {
      await preflight.removeAttachment(rid(c), c.req.param("aid"));
    } catch (e) {
      throw e instanceof AttachmentError ? new NotFoundError(e.message) : e;
    }
    return c.json({ ok: true });
  });
  app.get("/requests/:rid/preflight/:run/attachments/:aid", async (c) => {
    const { meta, data } = await preflight.fixedAttachment(rid(c), c.req.param("run"), c.req.param("aid"));
    return download(c, data, meta.format, meta.name);
  });
  app.get("/requests/:rid/preflight/:run/attachments/:aid/extract", async (c) => {
    const text = await preflight.fixedExtract(rid(c), c.req.param("run"), c.req.param("aid"));
    return c.body(text, 200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" });
  });
  app.post("/requests/:rid/preflight/:run/cancel", (c) => {
    preflight.cancel(c.req.param("run"));
    return c.json({ ok: true });
  });
  app.patch("/requests/:rid/preflight/:run/drafts/:key", async (c) => {
    // expectedTitle: 編集を始めたときの題（制御用。案には書かない）。今の題と違えば 409 で書かない
    const { expectedTitle, ...patch } = z
      .object({ title: z.string(), description: z.string(), include: z.boolean(), repo: z.string().nullable(), expectedTitle: z.string() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateDraft(rid(c), c.req.param("run"), c.req.param("key"), patch, { expectedTitle }));
  });
  /** 子の要望の案（分割の run）を直す。expectedTitle は上と同じ */
  app.patch("/requests/:rid/preflight/:run/children/:key", async (c) => {
    const { expectedTitle, ...patch } = z
      .object({ title: z.string(), description: z.string(), include: z.boolean(), expectedTitle: z.string() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateChild(rid(c), c.req.param("run"), c.req.param("key"), patch, { expectedTitle }));
  });
  app.get("/requests/:rid/preflight/:run/materialize", async (c) => c.json(await preflight.previewMaterialize(rid(c), c.req.param("run"))));
  app.post("/requests/:rid/preflight/:run/materialize", async (c) => {
    const body = z
      .object({ archive: z.array(z.object({ id: z.string(), rev: z.number().int().optional() })).optional(), version: z.string().optional() })
      .parse(await c.req.json().catch(() => ({})));
    const run = await preflight.get(rid(c), c.req.param("run"));
    // 分割の run は子の要望を作る（version: 確認したときの子の案の版。違えば 409 drafts_changed）
    if (run?.children) {
      const r = await preflight.adopt(rid(c), c.req.param("run"), actorOf(c), { version: body.version });
      return c.json(r, r.failed.length ? 207 : 201);
    }
    return c.json(await preflight.materialize(rid(c), c.req.param("run"), actorOf(c), { archive: body.archive }), 201);
  });

  // --- 横断 --------------------------------------------------------------
  app.get("/tasks", (c) => {
    const { status, area, q } = c.req.query();
    return c.json(listTasks(ctx, { status: status?.split(","), area, q }));
  });
  /** 参照・タイトルから対象を特定する（?request= で今の要望を優先） */
  app.get("/resolve", (c) => c.json(resolve(ctx, c.req.query("q") ?? "", c.req.query("request"))));

  // --- events (SSE) ------------------------------------------------------
  app.get("/events", (c) => eventStream(c, (push) => ws.on(push)));

  return app;
}

/** 変更の知らせを SSE で流す（subscribe は知らせを受け取る関数を登録し、外す関数を返す）。25 秒ごとに ping */
export function eventStream(c: Context, subscribe: (push: (e: ServerEvent) => void) => () => void) {
  return streamSSE(c, async (stream) => {
    const queue: ServerEvent[] = [];
    let wake: (() => void) | undefined;
    const off = subscribe((e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      off();
      wake?.();
    });
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(25000)]);
        wake = undefined;
        if (!queue.length) await stream.writeSSE({ event: "ping", data: "" });
      }
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
    }
  });
}
