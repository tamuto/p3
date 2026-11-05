import { Hono, type Context } from "hono";
import { z } from "zod";
import type { P3Context } from "../../core/context.ts";
import { extractReviewInput } from "../../core/milestoneReview/material.ts";
import { ReviewCancelRefused, ReviewRejected } from "../../core/milestoneReview/service.ts";
import { checkReviewMilestoneId, ReviewStoreError } from "../../core/milestoneReview/store.ts";

/**
 * マイルストーンレビュー（画面のため）。規則と保存は core/milestoneReview（CLI の p3 milestone review と同じ）。
 *
 *   GET  /milestone-reviews                     履歴のあるマイルストーン（project.yaml に無い孤立も）
 *   GET  /milestones/:mid/review-preview        今の材料（比較単位・目的・要望の件数と状態・範囲・警告・hash）。何も書かない
 *   GET  /milestones/:mid/reviews               履歴（新しい順。読めない記録も broken で出す）
 *   POST /milestones/:mid/reviews               実行を始める（202。目的も予定機能も無ければ 400 no_goals、実行中なら 409 running）
 *   GET  /milestones/:mid/reviews/:run          1回分（固定した材料・結果。実行中は所有者の状態 owner）
 *   POST /milestones/:mid/reviews/:run/cancel   取り消す（ほかのプロセスの run は要求を残す）。{ acknowledgeStopped: true } は
 *                                               所有者の分からない run を人が明示して中断する（ほかの環境のプロセスを止めたとは限らない）
 */

const actorOf = (c: Context) => c.req.header("x-p3-actor") ?? "human:web";

export function milestoneReviewRoutes(ctx: P3Context) {
  const app = new Hono();
  const svc = () => ctx.milestoneReview;

  app.onError((err, c) => {
    if (err instanceof ReviewStoreError) {
      const status = err.code === "not_found" ? 404 : err.code === "bad_id" ? 400 : err.code === "broken" ? 422 : 409;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof ReviewRejected) {
      const status = err.code === "running" ? 409 : err.code === "unknown_milestone" ? 404 : 400;
      return c.json({ error: err.message, code: err.code, ...(err.running ? { run: err.running } : {}) }, status);
    }
    if (err instanceof ReviewCancelRefused) return c.json({ error: err.message, code: err.code }, 409);
    if (err instanceof z.ZodError) return c.json({ error: "invalid input", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 400);
  });

  app.get("/milestone-reviews", async (c) => c.json({ milestones: await ctx.ws.milestoneReviews.milestones() }));
  app.get("/milestones/:mid/review-preview", async (c) => {
    const mid = c.req.param("mid");
    checkReviewMilestoneId(mid);
    const i = await extractReviewInput(ctx.ws.dataDir, mid);
    const statuses: Record<string, number> = {};
    for (const r of i.requests) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    return c.json({
      milestone: i.milestone,
      units: i.units,
      requests: i.requests.length,
      statuses,
      context: i.context.length,
      warnings: i.warnings,
      scope: i.scope,
      hash: i.hash,
      extractedAt: i.extractedAt,
    });
  });
  app.get("/milestones/:mid/reviews", async (c) => c.json({ items: await svc().list(c.req.param("mid")) }));
  app.post("/milestones/:mid/reviews", async (c) => {
    const { engine } = z.object({ engine: z.enum(["codex", "mock"]).optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc().start(c.req.param("mid"), actorOf(c), engine), 202);
  });
  app.get("/milestones/:mid/reviews/:run", async (c) => c.json(await svc().get(c.req.param("mid"), c.req.param("run"))));
  app.post("/milestones/:mid/reviews/:run/cancel", async (c) => {
    const { acknowledgeStopped } = z.object({ acknowledgeStopped: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc().cancel(c.req.param("mid"), c.req.param("run"), actorOf(c), { acknowledgeStopped }));
  });

  return app;
}
