import { Hono, type Context } from "hono";
import { z } from "zod";
import type { P3Context } from "../../core/context.ts";
import { ReviewCancelRefused, ReviewStoreError } from "../../core/reviewRuns.ts";
import { NotFoundError } from "../../core/store/collection.ts";
import { TaskReviewRejected } from "../../core/taskReview/material.ts";
import { previewOf } from "../../shared/taskReview.ts";

/**
 * タスクの AI レビュー（画面のため）。規則と保存は core/taskReview（CLI の p3 review と同じサービス）。
 *
 *   POST /requests/:rid/tasks/:tid/review-preview       今の材料の要約と hash（{targets?, viewpoint?}。何も書かない）
 *   GET  /requests/:rid/tasks/:tid/reviews              履歴（新しい順。読めない記録も broken で出す。アーカイブしたタスクも読める）
 *   POST /requests/:rid/tasks/:tid/reviews              始める（202。{targets?, viewpoint?, engine?, expectedHash?}）。
 *                                                       材料が変わっていれば 409 material_changed、実行中なら 409 running、Preflight の担当が agent で
 *                                                       engine を明示していなければ 400 engine_required
 *   GET  /requests/:rid/tasks/:tid/reviews/:run         1回分（固定した材料・結果。実行中は所有者の状態 owner）
 *   POST /requests/:rid/tasks/:tid/reviews/:run/cancel  取り消す（{acknowledgeStopped?}。マイルストーンレビューと同じ）
 *
 * 結果を直す口は作らない（直すなら材料を直して別の run でレビューし直す）
 */

const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";

const startBody = z.object({
  targets: z.array(z.string().min(1)).max(50).optional(),
  viewpoint: z.string().max(2000).optional(),
  engine: z.enum(["codex", "mock"]).optional(),
  expectedHash: z.string().optional(),
});

export function taskReviewRoutes(ctx: P3Context) {
  const app = new Hono();
  const svc = () => ctx.taskReview;

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message, code: "not_found" }, 404);
    if (err instanceof ReviewStoreError) {
      const status = err.code === "not_found" ? 404 : err.code === "bad_id" ? 400 : err.code === "broken" ? 422 : 409;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof TaskReviewRejected) {
      const status = err.code === "running" || err.code === "material_changed" ? 409 : 400;
      return c.json({ error: err.message, code: err.code, ...(err.running ? { run: err.running } : {}) }, status);
    }
    if (err instanceof ReviewCancelRefused) return c.json({ error: err.message, code: err.code }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  const rid = (c: Context) => c.req.param("rid")!;
  const tid = (c: Context) => c.req.param("tid")!;

  app.post("/requests/:rid/tasks/:tid/review-preview", async (c) => {
    const { targets, viewpoint } = startBody.parse(await c.req.json().catch(() => ({})));
    const p = await svc().preview(rid(c), tid(c), { targets, viewpoint });
    return c.json({ ...previewOf(p.input), engineRequired: p.engineRequired });
  });
  app.get("/requests/:rid/tasks/:tid/reviews", async (c) => c.json({ items: await svc().list(rid(c), tid(c)) }));
  app.post("/requests/:rid/tasks/:tid/reviews", async (c) => {
    const body = startBody.parse(await c.req.json().catch(() => ({})));
    return c.json(await svc().start(rid(c), tid(c), actorOf(c), body), 202);
  });
  app.get("/requests/:rid/tasks/:tid/reviews/:run", async (c) => c.json(await svc().get(rid(c), tid(c), c.req.param("run"))));
  app.post("/requests/:rid/tasks/:tid/reviews/:run/cancel", async (c) => {
    const { acknowledgeStopped } = z.object({ acknowledgeStopped: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc().cancel(rid(c), tid(c), c.req.param("run"), actorOf(c), { acknowledgeStopped }));
  });

  return app;
}
