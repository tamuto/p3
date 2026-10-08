import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { normalizeTaskId } from "../../shared/refs.ts";
import { REQUEST_STATUSES, relationTypes, type Relation, type ServerEvent, type Task } from "../../shared/types.ts";
import type { PcubeContext } from "../context.ts";
import { addRelation, listTasks, progress, removeRelation, resolve } from "../ops.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import { AI_MANIFEST } from "./manifest.ts";

/**
 * ブラウザ用のローカル API。AI や人の操作は CLI（ファイルを直接読み書き）が主で、ここは画面のため。
 *
 *   /requests                              要望（進捗つき）
 *   /requests/:rid                         要望の詳細
 *   /requests/:rid/tasks[/:tid]            要望のタスク
 *   /requests/:rid/preflight[/:run]        Preflight
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
  status: z.string().optional(),
  labels: z.array(z.string()).optional(),
  areas: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
  start: date.nullish(),
  due: date.nullish(),
  progress: z.number().min(0).max(100).nullish(),
  body: z.string().optional(),
});
const taskPatch = taskInput.partial().extend({ rev: z.number().int().optional() });
const requestInput = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  areas: z.array(z.string()).optional(),
});
const requestPatch = requestInput
  .partial()
  .extend({ status: z.enum(REQUEST_STATUSES as [string, ...string[]]).optional(), rev: z.number().int().optional() });
const projectPatch = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    docs: z.array(z.string().min(1)),
    statuses: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1), done: z.boolean().optional() })).min(1),
    branchPattern: z.string().includes("{id}"),
    worktreeDir: z.string().min(1),
    preflight: z.object({ instructions: z.string() }),
  })
  .partial()
  .superRefine((p, ctx) => {
    const ids = p.statuses?.map((x) => x.id) ?? [];
    const dup = ids.find((x, i) => ids.indexOf(x) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `ステータスの id が重複しています: ${dup}` });
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

export function apiRoutes(ctx: PcubeContext) {
  const { ws, index, preflight } = ctx;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) {
      const current = c.req.param("tid") ? ws.tasksOf(c.req.param("rid")!).get(err.id) : ws.requests.get(err.id);
      return c.json({ error: err.message, current }, 409);
    }
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
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
    if (patch.statuses) {
      // 使われているステータスを消すと、そのタスクがかんばんから消えてしまう
      const ids = new Set(patch.statuses.map((s) => s.id));
      const orphan = ws.allTasks().filter((t) => !ids.has(t.status));
      if (orphan.length) {
        throw new Error(`使用中のステータスは消せません: ${[...new Set(orphan.map((t) => t.status))].join(", ")}（${orphan.map((t) => t.ref).join(", ")}）`);
      }
    }
    return c.json(await ws.saveProject(patch));
  });
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));

  // --- requests -------------------------------------------------------------
  app.get("/requests", (c) => c.json(progress(ctx)));
  app.post("/requests", async (c) => {
    const b = requestInput.parse(await c.req.json());
    const r = await ws.requests.create({ title: b.title, body: b.body ?? "", areas: b.areas ?? [], status: "draft" }, actorOf(c));
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
    });
  });
  app.patch("/requests/:rid", async (c) => {
    const { rev, ...patch } = requestPatch.parse(await c.req.json());
    const r = await ws.requests.update(rid(c), patch as never, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
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
    const b = unnull(taskInput.parse(await c.req.json()));
    const t = await ws.tasksOf(id).create({ ...b, status: b.status ?? ws.project.statuses[0]?.id } as Partial<Task>, actorOf(c));
    changed("task", id, t.ref);
    return c.json(t, 201);
  });
  app.get("/requests/:rid/tasks/:tid", (c) => {
    const task = ws.tasksOf(rid(c)).require(tid(c));
    return c.json({ task, graph: index.neighborhood(task.ref) });
  });
  app.patch("/requests/:rid/tasks/:tid", async (c) => {
    const { rev, ...patch } = taskPatch.parse(await c.req.json());
    const id = rid(c);
    const t = await ws.tasksOf(id).update(tid(c), unnull(patch) as Partial<Task>, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    changed("task", id, t.ref);
    return c.json(t);
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
    const body = (await c.req.json().catch(() => ({}))) as { engine?: "codex" | "mock" };
    return c.json(await preflight.start(rid(c), { engine: body.engine, actor: actorOf(c) }), 202);
  });
  app.get("/requests/:rid/preflight", async (c) => c.json(await preflight.list(rid(c))));
  app.get("/requests/:rid/preflight/:run", async (c) => {
    const run = await preflight.get(rid(c), c.req.param("run"));
    if (!run) throw new NotFoundError(c.req.param("run"));
    return c.json(run);
  });
  app.post("/requests/:rid/preflight/:run/cancel", (c) => {
    preflight.cancel(c.req.param("run"));
    return c.json({ ok: true });
  });
  app.patch("/requests/:rid/preflight/:run/drafts/:key", async (c) => {
    const patch = z
      .object({ title: z.string(), description: z.string(), include: z.boolean() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateDraft(rid(c), c.req.param("run"), c.req.param("key"), patch));
  });
  app.post("/requests/:rid/preflight/:run/materialize", async (c) =>
    c.json(await preflight.materialize(rid(c), c.req.param("run"), actorOf(c)), 201),
  );

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
