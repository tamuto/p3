import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const LOOPBACK_ADDR = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * ローカルだけの API（ChatGPT の接続・個人設定のテーマ）を受けてよいか。serve は既定で 0.0.0.0 で待つので、LAN の別のマシンから
 * サインインの開始・解除をされたり、アカウントを読まれたりしないようにする（P3 自体に本人認証は無い）。
 *   - 接続元が自分のマシン（127.0.0.1 / ::1。DevContainer の VS Code の転送もこれになる）
 *   - 変更は Origin が必須で、ローカルのページ（localhost / 127.0.0.1 / [::1]）から。Origin が無いだけでは通さない
 *     （別のサイトのページや DNS rebinding からの要求を断る。Vite の開発用の proxy は Host を書き換えるので Host とは比べない）
 */
export function localOnly(c: Context, mutating: boolean, what = "ChatGPT の接続"): string | undefined {
  let addr: string | undefined;
  try {
    addr = getConnInfo(c).remote.address;
  } catch {
    addr = undefined;
  }
  if (!addr || !LOOPBACK_ADDR.has(addr)) return `${what}は、P3 を動かしているマシンからだけ操作できます`;
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

