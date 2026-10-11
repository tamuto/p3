import { Hono } from "hono";
import { z } from "zod";
import type { ChatGptAccount } from "../chatgpt/account.ts";
import type { PreflightService } from "../preflight/service.ts";
import type { Workspace } from "../store/workspace.ts";
import { localOnly } from "./local.ts";

/**
 * /api/chatgpt。サインインの待ち受けは serve のプロセスが行う（同時に1つ。ページを読み直しても待っている試行を返す）。
 * 返すのは状態だけで、トークンは返さない。
 */
export function chatgptRoutes(account: ChatGptAccount, ws: Workspace, preflight: PreflightService) {
  const app = new Hono();
  const changed = () => ws.emit({ type: "changed", kind: "chatgpt" });
  app.use("*", async (c, next) => {
    const why = localOnly(c, c.req.method !== "GET");
    if (why) return c.json({ error: why }, 403);
    await next();
  });

  app.get("/", async (c) => c.json({ ...(await account.status()), engine: await preflight.engineStatus() }));

  app.post("/login", async (c) => {
    const attempt = await account.startLogin();
    // 終わったら（成功・失敗・取消・タイムアウト）画面へ知らせる
    void attempt.done.finally(changed).catch(() => {});
    changed();
    return c.json({ url: attempt.url, redirectUri: attempt.redirectUri, expiresAt: attempt.expiresAt }, 201);
  });
  app.post("/cancel", (c) => {
    account.pending()?.cancel();
    return c.json({ ok: true });
  });
  // ブラウザがコールバックに届かない環境: 「接続できません」の画面のアドレスバーの URL を貼ってもらう
  app.post("/paste", async (c) => {
    const { url } = z.object({ url: z.string() }).parse(await c.req.json());
    const attempt = account.pending();
    if (!attempt) return c.json({ error: "待っているサインインがありません。もう一度「Continue with ChatGPT」から始めてください" }, 409);
    return c.json(await attempt.submit(url));
  });
  app.post("/logout", async (c) => {
    const { forget } = z.object({ forget: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await account.logout({ forget });
    changed();
    return c.json({ ...r, status: await account.status() });
  });
  return app;
}
