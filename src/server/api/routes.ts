import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { normalizeTaskId } from "../../shared/refs.ts";
import { REQUEST_STATUSES, relationTypes, type Relation, type Request, type ServerEvent, type Task, TASK_STATUSES } from "../../shared/types.ts";
import type { PcubeContext } from "../context.ts";
import { addRelation, listTasks, progress, removeRelation, resolve } from "../ops.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES, AttachmentError, safeFileName } from "../store/attachments.ts";
import type { AttachmentFormat } from "../../shared/types.ts";
import { bodyLimit } from "hono/body-limit";
import { ReloadError } from "../store/workspace.ts";
import { checkRepoTarget, ensureWorkstreams } from "../workTargets.ts";
import { defaultRepo } from "../../shared/workTarget.ts";
import { checkStatusChange, reopenIfNeeded, resolvedIssue } from "../requestStatus.ts";
import { startWarnings, supersededMarks } from "../supersede.ts";
import { chatgptRoutes } from "./chatgptRoutes.ts";
import { userThemeRoutes, userThemeScriptRoute } from "./userThemeRoutes.ts";
import { UserConfigError } from "../userConfig.ts";
import { AI_MANIFEST } from "./manifest.ts";
import { repoRoutes } from "./repoRoutes.ts";

/**
 * ブラウザ用のローカル API。AI や人の操作は CLI（ファイルを直接読み書き）が主で、ここは画面のため。
 *
 *   /requests                              要望（進捗つき）
 *   /requests/:rid                         要望の詳細
 *   /requests/:rid/tasks[/:tid]            要望のタスク
 *   /requests/:rid/preflight[/:run]        Preflight
 *   /requests/:rid/notes                   Preflight へのメモ
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const relation = z.object({
  type: z.enum(relationTypes as [string, ...string[]]),
  /** "T003"（同じ要望）/ "<要望ID>/T003" / "<要望ID>" */
  target: z.string().min(1),
  note: z.string().optional(),
  origin: z.enum(["human", "ai", "preflight"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
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
});
const requestPatch = requestInput
  .partial()
  .extend({ status: z.enum(REQUEST_STATUSES as [string, ...string[]]).optional(), rev: z.number().int().optional() });
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
const actorOf = (c: Context) => c.req.header("x-pcube-actor") ?? "human:web";

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

export function apiRoutes(ctx: PcubeContext) {
  const { ws, index, preflight } = ctx;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) {
      const current = err.id.includes("/") ? ws.task(err.id) : c.req.param("tid") ? ws.tasksOf(c.req.param("rid")!).get(err.id) : ws.requests.get(err.id);
      return c.json({ error: err.message, current }, 409);
    }
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
  const changed = (kind: "task" | "request", request: string, ref?: string) => {
    index.invalidate();
    ws.emit({ type: "changed", kind, request, ref });
  };

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
    if (patch.milestones) {
      const ids = new Set(patch.milestones.map((m) => m.id));
      const used = ws.requests.list().filter((r) => r.milestone && !ids.has(r.milestone));
      if (used.length) throw new Error(`使用中のマイルストーンは消せません: ${[...new Set(used.map((r) => r.milestone))].join(", ")}`);
    }
    return c.json(await ws.saveProject(patch));
  });
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));
  /** 参照先（設定画面。このマシンのパスはローカルの画面からだけ） */
  app.route("/repos", repoRoutes(ctx));
  /** データのフォルダを全部読み直す（ファイル監視に頼らない取り込み）。終わったら変更通知 kind: "reload" */
  app.post("/reload", async (c) => c.json(await ws.reloadAll()));
  /** Preflight のエンジンが使えるか（Codex なら Docker・認証・イメージを確かめる） */
  app.get("/engine", async (c) => c.json(await preflight.engineStatus()));
  if (ctx.chatgpt) app.route("/chatgpt", chatgptRoutes(ctx.chatgpt, ws, preflight));
  /** 個人設定のテーマ（このマシンのすべてのプロジェクトで共通。ほかの個人設定は扱わない） */
  app.route("/user-theme", userThemeRoutes(() => ws.emit({ type: "changed", kind: "user" })));
  /** 最初の描画の前に読むスクリプト（index.html の先頭）。テーマだけを埋め込み、キャッシュさせない */
  app.route("/user-theme.js", userThemeScriptRoute());

  // --- requests -------------------------------------------------------------
  app.get("/requests", (c) => c.json(progress(ctx)));
  /** 要望のマイルストーンは project.yaml にあるものだけ */
  const checkMilestone = (m: string | null | undefined) => {
    if (m && !ws.project.milestones.some((x) => x.id === m)) throw new Error(`マイルストーンがありません: ${m}（設定で追加してください）`);
  };
  app.post("/requests", async (c) => {
    const b = unnull(requestInput.parse(await c.req.json()));
    checkMilestone(b.milestone);
    const r = await ws.requests.create({ ...b, body: b.body ?? "", areas: b.areas ?? [], tags: b.tags ?? [], status: "draft" }, actorOf(c));
    changed("request", r.id);
    return c.json(r, 201);
  });
  app.get("/requests/:rid", async (c) => {
    const id = rid(c);
    return c.json({
      request: ws.requests.get(id),
      tasks: ws.tasksOf(id).list(),
      runs: await preflight.list(id),
      graph: index.neighborhood(id),
      // 対応済なのに未完了のタスクがある（外部の直接編集など）
      issue: resolvedIssue(ws, ws.requests.require(id)) ?? null,
      // 置き換えられたタスクの印（T001 → 置き換えた側）
      superseded: Object.fromEntries(
        [...supersededMarks(ws)].filter(([ref]) => ref.startsWith(`${id}/`)).map(([ref, m]) => [ref.slice(id.length + 1), m]),
      ),
    });
  });
  app.patch("/requests/:rid", async (c) => {
    const { rev, ...patch } = requestPatch.parse(await c.req.json());
    checkMilestone(patch.milestone);
    await checkStatusChange(ws, rid(c), patch.status as Request["status"] | undefined);
    const r = await ws.requests.update(rid(c), unnull(patch) as never, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    changed("request", r.id);
    return c.json(r);
  });

  // --- tasks（要望の中） --------------------------------------------------------
  app.get("/requests/:rid/tasks", (c) => {
    const { status, area, q } = c.req.query();
    return c.json(listTasks(ctx, { request: rid(c), status: status?.split(","), area, q }));
  });
  app.post("/requests/:rid/tasks", async (c) => {
    const id = rid(c);
    const raw = taskInput.parse(await c.req.json());
    const b = unnull(raw);
    // 作業先は null（作業先なし）を残す。作業先にできるものだけ（変える前に断る）
    checkRepoTarget(ws, raw.repo);
    for (const o of raw.repoOutputs ?? []) checkRepoTarget(ws, o.repo);
    // 作業先を書かなければ、作業先にできる参照先が1つならそれ（ほかは作業先なし）
    const repo = "repo" in raw ? (raw.repo ?? null) : defaultRepo(ws.project);
    const t = await ws.tasksOf(id).create({ ...b, repo, status: b.status ?? "todo" } as Partial<Task>, actorOf(c));
    if (repo) await ensureWorkstreams(ws, id, [repo], actorOf(c));
    // 対応済の要望に未完了のタスクを足したら進行中に戻す
    const reopened = (await reopenIfNeeded(ws, id, actorOf(c))) ? id : undefined;
    changed("task", id, t.ref);
    if (reopened) changed("request", id);
    return c.json(reopened ? { ...t, reopened } : t, 201);
  });
  app.get("/requests/:rid/tasks/:tid", (c) => {
    const task = ws.tasksOf(rid(c)).require(tid(c));
    return c.json({ task, graph: index.neighborhood(task.ref), superseded: supersededMarks(ws).get(task.ref) ?? [] });
  });
  app.patch("/requests/:rid/tasks/:tid", async (c) => {
    const { rev, checked, ...patch } = taskPatch.parse(await c.req.json());
    const id = rid(c);
    const col = ws.tasksOf(id);
    const next: Partial<Task> = unnull(patch) as Partial<Task>;
    if ("repo" in patch) {
      checkRepoTarget(ws, patch.repo);
      next.repo = patch.repo ?? null;
    }
    for (const o of patch.repoOutputs ?? []) checkRepoTarget(ws, o.repo);
    if (checked !== undefined) {
      const done = (next.status ?? col.require(tid(c)).status) === "done";
      if (checked && !done) throw new Error("済みにできるのは完了したタスクだけです");
      next.checkedAt = checked ? new Date().toISOString() : undefined;
    }
    // 置き換えられたタスクを作業中にしたら警告を添える（操作は続ける）
    const warnings = startWarnings(ws, `${id}/${tid(c)}`, col.require(tid(c)).status, next.status);
    const t = await col.update(tid(c), next, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    if (patch.repo) await ensureWorkstreams(ws, id, [patch.repo], actorOf(c));
    const reopened = (await reopenIfNeeded(ws, id, actorOf(c))) ? id : undefined;
    changed("task", id, t.ref);
    if (reopened) changed("request", id);
    return c.json({ ...t, ...(warnings.length ? { warnings } : {}), ...(reopened ? { reopened } : {}) });
  });
  app.delete("/requests/:rid/tasks/:tid", async (c) => {
    const id = rid(c);
    await ws.tasksOf(id).archive(tid(c));
    changed("task", id, `${id}/${tid(c)}`);
    return c.json({ ok: true });
  });

  // 関係（多元的な関係を1本ずつ操作する）。要望にもタスクにも張れる
  const refOf = (c: Context) => (c.req.param("tid") ? `${rid(c)}/${tid(c)}` : rid(c));
  for (const path of ["/requests/:rid/relations", "/requests/:rid/tasks/:tid/relations"]) {
    app.post(path, async (c) => {
      const ref = refOf(c);
      const t = await addRelation(ctx, ref, relation.parse(await c.req.json()) as Relation, actorOf(c));
      changed(c.req.param("tid") ? "task" : "request", rid(c), ref);
      return c.json(t);
    });
    app.delete(path, async (c) => {
      const ref = refOf(c);
      const { type, target } = c.req.query();
      const t = await removeRelation(ctx, ref, { type, target }, actorOf(c));
      changed(c.req.param("tid") ? "task" : "request", rid(c), ref);
      return c.json(t);
    });
  }

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
  app.get("/requests/:rid/preflight", async (c) => c.json(await preflight.list(rid(c))));
  app.get("/requests/:rid/preflight/:run", async (c) => {
    const run = await preflight.get(rid(c), c.req.param("run"));
    if (!run) throw new NotFoundError(c.req.param("run"));
    return c.json(run);
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
    const patch = z
      .object({ title: z.string(), description: z.string(), include: z.boolean(), repo: z.string().nullable() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateDraft(rid(c), c.req.param("run"), c.req.param("key"), patch));
  });
  app.get("/requests/:rid/preflight/:run/materialize", async (c) => c.json(await preflight.previewMaterialize(rid(c), c.req.param("run"))));
  app.post("/requests/:rid/preflight/:run/materialize", async (c) => {
    const body = z
      .object({ archive: z.array(z.object({ id: z.string(), rev: z.number().int().optional() })).optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await preflight.materialize(rid(c), c.req.param("run"), actorOf(c), { archive: body.archive }), 201);
  });

  // --- intelligence ------------------------------------------------------
  app.get("/tasks", (c) => {
    const { status, area, q } = c.req.query();
    return c.json(listTasks(ctx, { status: status?.split(","), area, q }));
  });
  app.get("/graph", (c) => c.json({ edges: index.edges() }));
  app.get("/related", (c) => {
    const { q = "", areas = "", seeds = "", limit } = c.req.query();
    return c.json(
      index.related({ text: q, areas: areas ? areas.split(",") : [], seeds: seeds ? seeds.split(",") : [], limit: limit ? Number(limit) : 10 }),
    );
  });
  /** 参照・タイトル・自然文から対象を特定する（?request= で今の要望を優先） */
  app.get("/resolve", (c) => c.json(resolve(ctx, c.req.query("q") ?? "", c.req.query("request"))));

  // --- events (SSE) ------------------------------------------------------
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | undefined;
      const off = ws.on((e) => {
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
    }),
  );

  return app;
}
