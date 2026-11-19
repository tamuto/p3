import { Hono } from "hono";
import { observerStatus } from "../../core/status.ts";

/**
 * observer の API。入口の serve が observer を選んだときだけ /api/observer の下に付ける（選んでいなければ付けず、入口の 404 の JSON になる）。
 *   GET /status   起動状態（ObserverStatus）
 */
export function observerRoutes() {
  const app = new Hono();
  app.get("/status", (c) => {
    c.header("cache-control", "no-store");
    return c.json(observerStatus());
  });
  app.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  return app;
}
