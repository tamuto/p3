import { Hono } from "hono";
import { observerStatus } from "../../core/status.ts";

/**
 * observer の API。入口の serve が常に /api/observer の下に付ける。
 *   GET /status   起動状態（ObserverStatus）
 */
export function observerRoutes(opts: { products?: readonly string[] } = {}) {
  const app = new Hono();
  app.get("/status", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ ...observerStatus(), ...(opts.products ? { products: [...opts.products] } : {}) });
  });
  app.all("*", (c) => c.json({ error: `API がありません: ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));
  return app;
}
