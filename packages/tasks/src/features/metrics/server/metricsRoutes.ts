import { Hono } from "hono";
import type { P3Context } from "../../../core/context.ts";
import { metricScopeOf, metricsReport } from "../core/index.ts";

/** 開発の指標の API（読むだけ）。GET /metrics[?milestone=<ID>]。API の組み立て（server/api/routes.ts）がつなぐ */
export function metricsRoutes(ctx: P3Context) {
  const app = new Hono();
  app.get("/metrics", async (c) => c.json(await metricsReport(ctx, metricScopeOf(ctx, c.req.query("milestone")))));
  return app;
}
