import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { relationTypes, type Relation, type ServerEvent, type Task } from "../../shared/types.ts";
import type { ProjectIndex } from "../intel/index.ts";
import type { PreflightService } from "../preflight/service.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import type { Workspace } from "../store/workspace.ts";
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

export function apiRoutes(ws: Workspace, index: ProjectIndex, preflight: PreflightService) {
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
  app.get("/ai/manifest", (c) => c.json(AI_MANIFEST));

  // --- tasks --------------------------------------------------------------
  app.get("/tasks", (c) => {
    const { status, request, area, q } = c.req.query();
    let tasks = ws.tasks.list();
    if (status) tasks = tasks.filter((t) => status.split(",").includes(t.status));
    if (request) tasks = tasks.filter((t) => t.request === request);
    if (area) tasks = tasks.filter((t) => t.areas.some((a) => a.startsWith(area)));
    if (q) {
      const ql = q.toLowerCase();
      tasks = tasks.filter((t) => `${t.id} ${t.title} ${t.body}`.toLowerCase().includes(ql));
    }
    return c.json(tasks);
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
    const col = c.req.param("kind") === "tasks" ? ws.tasks : ws.requests;
    const id = c.req.param("id");
    const rel = relation.parse(await c.req.json()) as Relation;
    if (rel.target === id) throw new Error("自分自身には関係を張れません");
    if (!ws.tasks.get(rel.target) && !ws.requests.get(rel.target)) throw new NotFoundError(rel.target);
    if (rel.type === "depends_on" && index.wouldCycle(id, rel.target)) throw new Error(`${id} → ${rel.target} は依存の循環になります`);
    const cur = col.require(id);
    const relations = [...cur.relations.filter((r) => !(r.type === rel.type && r.target === rel.target)), { ...rel, origin: rel.origin ?? (actorOf(c).startsWith("ai") ? "ai" : "human") }];
    const t = await col.update(id, { relations } as never, { actor: actorOf(c) });
    index.invalidate();
    changed(c.req.param("kind") === "tasks" ? "task" : "request", id);
    return c.json(t);
  });

  app.delete("/:kind{tasks|requests}/:id/relations", async (c) => {
    const col = c.req.param("kind") === "tasks" ? ws.tasks : ws.requests;
    const id = c.req.param("id");
    const { type, target } = c.req.query();
    const cur = col.require(id);
    const t = await col.update(id, { relations: cur.relations.filter((r) => !(r.type === type && r.target === target)) } as never, {
      actor: actorOf(c),
    });
    index.invalidate();
    changed(c.req.param("kind") === "tasks" ? "task" : "request", id);
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
  app.get("/resolve", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const exact = ws.tasks.get(q.toUpperCase()) ?? ws.requests.get(q.toUpperCase());
    if (exact) return c.json({ match: exact.id, candidates: [{ id: exact.id, title: exact.title, score: 1, reasons: ["ID 一致"] }] });
    const byTitle = [...ws.tasks.list(), ...ws.requests.list()]
      .filter((t) => q && t.title.toLowerCase().includes(q.toLowerCase()))
      .map((t) => ({ id: t.id, title: t.title, score: 0.9, reasons: ["タイトルに含む"] }));
    const similar = index.related({ text: q, limit: 5, minScore: 0.15 }).filter((r) => !byTitle.some((b) => b.id === r.id));
    const candidates = [...byTitle, ...similar].slice(0, 8);
    return c.json({ match: candidates.length === 1 ? candidates[0].id : null, candidates });
  });

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
