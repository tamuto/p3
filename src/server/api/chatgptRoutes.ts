import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChatGptAccount } from "../chatgpt/account.ts";
import type { PreflightService } from "../preflight/service.ts";
import type { Workspace } from "../store/workspace.ts";

const LOOPBACK_ADDR = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * ChatGPT の接続の API を受けてよいか。serve は既定で 0.0.0.0 で待つので、LAN の別のマシンから
 * サインインの開始・解除をされたり、アカウントを読まれたりしないようにする（P3 自体に本人認証は無い）。
 *   - 接続元が自分のマシン（127.0.0.1 / ::1。DevContainer の VS Code の転送もこれになる）
 *   - 変更は Origin が必須で、ローカルのページ（localhost / 127.0.0.1 / [::1]）から。Origin が無いだけでは通さない
 *     （別のサイトのページや DNS rebinding からの要求を断る。Vite の開発用の proxy は Host を書き換えるので Host とは比べない）
 */
export function localOnly(c: Context, mutating: boolean): string | undefined {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined;
  }
  if (!addr || !LOOPBACK_ADDR.has(addr)) return "ChatGPT の接続は、P3 を動かしているマシンからだけ操作できます";
  if (!mutating) return undefined;
  const origin = c.req.header("origin");
  let host: string | undefined;
  try {
    host = origin ? new URL(origin).hostname : undefined;
  } catch {
    host = undefined;
  }
  if (!host || !LOOPBACK_HOST.has(host === "::1" ? "[::1]" : host)) return "この操作はローカルの P3 の画面からだけ行えます";
  return undefined;
}

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
