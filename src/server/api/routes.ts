import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { relationTypes, type Relation, type ServerEvent, type Task } from "../../shared/types.ts";
import type { PcubeContext } from "../context.ts";
import { addRelation, listTasks, removeRelation, resolve } from "../ops.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import { AI_MANIFEST } from "./manifest.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const relation = z.object({
  type: z.enum(relationTypes as [string, ...string[]]),
  target: z.string().regex(/^(TASK|REQ)-\d+$/),
  note: z.string().optional(),
  origin: z.enum(["human", "ai", "preflight"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
const taskInput = z.object({
  title: z.string().min(1),
  status: z.string().optional(),
  request: z.string().nullish(),
  assignee: z.string().nullish(),
  labels: z.array(z.string()).optional(),
  areas: z.array(z.string()).optional(),
  estimate: z.number().nonnegative().nullish(),
  start: date.nullish(),
  due: date.nullish(),
  progress: z.number().min(0).max(100).nullish(),
  relations: z.array(relation).optional(),
  body: z.string().optional(),
});
const taskPatch = taskInput.partial().extend({ rev: z.number().int().optional() });
const requestInput = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  areas: z.array(z.string()).optional(),
  relations: z.array(relation).optional(),
});
const projectPatch = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    docs: z.array(z.string().min(1)),
    members: z.array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9._-]+$/, "id は英数字と . _ - のみ"),
        name: z.string().min(1),
        email: z.string().optional(),
        role: z.string().optional(),
        kind: z.enum(["human", "ai"]),
      }),
    ),
    statuses: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/), label: z.string().min(1), done: z.boolean().optional() })).min(1),
    branchPattern: z.string().includes("{id}"),
    worktreeDir: z.string().min(1),
    preflight: z.object({ instructions: z.string() }),
  })
  .partial()
  .superRefine((p, ctx) => {
    const dup = (xs: string[]) => xs.find((x, i) => xs.indexOf(x) !== i);
    const m = p.members && dup(p.members.map((x) => x.id));
    if (m) ctx.addIssue({ code: "custom", message: `メンバーの id が重複しています: ${m}` });
    const st = p.statuses && dup(p.statuses.map((x) => x.id));
    if (st) ctx.addIssue({ code: "custom", message: `ステータスの id が重複しています: ${st}` });
  });
const requestPatch = requestInput
  .partial()
  .extend({ status: z.enum(["draft", "preflight", "reviewed", "accepted", "rejected"]).optional(), rev: z.number().int().optional() });

/** null は「項目を消す」意味。frontmatter から外すため undefined に変換 */
const unnull = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === null ? undefined : v])) as {
    [K in keyof T]: Exclude<T[K], null>;
  };

/** 誰が変更したか。AI エージェントは `X-Pcube-Actor: ai:<name>` を付ける */
const actorOf = (c: Context) => c.req.header("x-pcube-actor") ?? "human:web";

/** 楽観ロック: body.rev か If-Match ヘッダ */
const expectedRev = (c: Context, body: { rev?: number }) => body.rev ?? (c.req.header("if-match") ? Number(c.req.header("if-match")) : undefined);

export function apiRoutes(ctx: PcubeContext) {
  const { ws, index, preflight } = ctx;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError)
      return c.json({ error: err.message, current: ws.tasks.get(err.id) ?? ws.requests.get(err.id) }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  // --- meta ---------------------------------------------------------------
  app.get("/project", (c) =>
    c.json({
      project: ws.project,
      dataDir: ws.dataDir,
      engines: preflight.availableEngines(),
      defaultEngine: preflight.defaultEngine,
      errors: Object.fromEntries([...ws.tasks.errors, ...ws.requests.errors]),
    }),
  );
  app.put("/project", async (c) => {
    const patch = projectPatch.parse(await c.req.json());
    if (patch.statuses) {
      // 使われているステータスを消すと、そのタスクがかんばんから消えてしまう
      const ids = new Set(patch.statuses.map((s) => s.id));
      const orphan = ws.tasks.list().filter((t) => !ids.has(t.status));
      if (orphan.length) throw new Error(`使用中のステータスは消せません: ${[...new Set(orphan.map((t) => t.status))].join(", ")}（${orphan.map((t) => t.id).join(", ")}）`);
    }
    return c.json(await ws.saveProject(patch));
  });
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));

  // --- tasks --------------------------------------------------------------
  app.get("/tasks", (c) => {
    const { status, request, area, q } = c.req.query();
    return c.json(listTasks(ctx, { status: status?.split(","), request, area, q }));
  });

  app.get("/tasks/:id", (c) => {
    const task = ws.tasks.require(c.req.param("id"));
    return c.json({ task, graph: index.neighborhood(task.id) });
  });

  app.post("/tasks", async (c) => {
    const b = unnull(taskInput.parse(await c.req.json()));
    const t = await ws.tasks.create(
      {
        ...b,
        status: b.status ?? ws.project.statuses[0]?.id ?? "backlog",
        labels: b.labels ?? [],
        areas: b.areas ?? [],
        relations: b.relations ?? [],
        body: b.body ?? "",
      } as Omit<Task, "id" | "rev" | "createdAt" | "updatedAt">,
      actorOf(c),
    );
    changed("task", t.id);
    return c.json(t, 201);
  });

  app.patch("/tasks/:id", async (c) => {
    const { rev, ...patch } = taskPatch.parse(await c.req.json());
    const t = await ws.tasks.update(c.req.param("id"), unnull(patch) as Partial<Task>, {
      expectedRev: expectedRev(c, { rev }),
      actor: actorOf(c),
    });
    changed("task", t.id);
    return c.json(t);
  });

  app.delete("/tasks/:id", async (c) => {
    await ws.tasks.archive(c.req.param("id"));
    changed("task", c.req.param("id"));
    return c.json({ ok: true });
  });

  // 関係の追加/削除（多元的な関係を1本ずつ操作する）
  app.post("/:kind{tasks|requests}/:id/relations", async (c) => {
    const id = c.req.param("id");
    const t = await addRelation(ctx, id, relation.parse(await c.req.json()) as Relation, actorOf(c));
    ws.emit({ type: "changed", kind: c.req.param("kind") === "tasks" ? "task" : "request", id });
    return c.json(t);
  });

  app.delete("/:kind{tasks|requests}/:id/relations", async (c) => {
    const id = c.req.param("id");
    const { type, target } = c.req.query();
    const t = await removeRelation(ctx, id, { type, target }, actorOf(c));
    ws.emit({ type: "changed", kind: c.req.param("kind") === "tasks" ? "task" : "request", id });
    return c.json(t);
  });

  // --- requests & preflight ----------------------------------------------
  app.get("/requests", (c) => c.json(ws.requests.list()));
  app.get("/requests/:id", async (c) => {
    const request = ws.requests.require(c.req.param("id"));
    return c.json({
      request,
      tasks: ws.tasks.list().filter((t) => t.request === request.id),
      runs: await preflight.list(request.id),
      graph: index.neighborhood(request.id),
    });
  });
  app.post("/requests", async (c) => {
    const b = requestInput.parse(await c.req.json());
    const r = await ws.requests.create(
      { title: b.title, body: b.body ?? "", areas: b.areas ?? [], relations: (b.relations ?? []) as Relation[], status: "draft" },
      actorOf(c),
    );
    changed("request", r.id);
    return c.json(r, 201);
  });
  app.patch("/requests/:id", async (c) => {
    const { rev, ...patch } = requestPatch.parse(await c.req.json());
    const r = await ws.requests.update(c.req.param("id"), patch as never, { expectedRev: expectedRev(c, { rev }), actor: actorOf(c) });
    changed("request", r.id);
    return c.json(r);
  });

  app.post("/requests/:id/preflight", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { engine?: "codex" | "mock" };
    return c.json(await preflight.start(c.req.param("id"), { engine: body.engine, actor: actorOf(c) }), 202);
  });
  app.get("/requests/:id/preflight", async (c) => c.json(await preflight.list(c.req.param("id"))));
  app.get("/requests/:id/preflight/:run", async (c) => {
    const run = await preflight.get(c.req.param("id"), c.req.param("run"));
    if (!run) throw new NotFoundError(c.req.param("run"));
    return c.json(run);
  });
  app.post("/requests/:id/preflight/:run/cancel", (c) => {
    preflight.cancel(c.req.param("run"));
    return c.json({ ok: true });
  });
  app.patch("/requests/:id/preflight/:run/drafts/:key", async (c) => {
    const patch = z
      .object({ title: z.string(), description: z.string(), estimateDays: z.number(), include: z.boolean() })
      .partial()
      .parse(await c.req.json());
    return c.json(await preflight.updateDraft(c.req.param("id"), c.req.param("run"), c.req.param("key"), patch));
  });
  app.post("/requests/:id/preflight/:run/materialize", async (c) =>
    c.json(await preflight.materialize(c.req.param("id"), c.req.param("run"), actorOf(c)), 201),
  );

  // --- intelligence ------------------------------------------------------
  app.get("/graph", (c) => c.json({ edges: index.edges() }));
  app.get("/related", (c) => {
    const { q = "", areas = "", seeds = "", limit } = c.req.query();
    return c.json(
      index.related({
        text: q,
        areas: areas ? areas.split(",") : [],
        seeds: seeds ? seeds.split(",") : [],
        limit: limit ? Number(limit) : 10,
      }),
    );
  });
  /**
   * AI 向け: 自然文や部分的な ID から対象タスクを特定する。
   * 完全一致 ID → タイトル部分一致 → 内容類似 の順で候補を返す。
   */
  app.get("/resolve", (c) => c.json(resolve(ctx, c.req.query("q") ?? "")));

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

  function changed(kind: "task" | "request", id: string) {
    index.invalidate();
    ws.emit({ type: "changed", kind, id });
  }

  return app;
}
