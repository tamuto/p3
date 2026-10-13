import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chatgptAccount, signInFailure, type ChatGptStatus } from "../core/chatgpt.ts";
import { UsageError } from "./project.ts";

/**
 * p3 chatgpt login | status | logout。プロジェクトを決める前に動く（どのプロジェクトにも属さない、このマシンの接続）。
 * 設計: docs/chatgpt-sign-in.md
 */
export async function chatgptCommand(
  args: string[],
  o: { port?: string; paste?: boolean; "no-browser"?: boolean; forget?: boolean },
  account = chatgptAccount(),
): Promise<{ data: unknown; text: string; code?: number }> {
  const [sub = "status"] = args;
  switch (sub) {
    case "status": {
      const s = await account.status();
      return { data: s, text: describe(s) };
    }
    case "login": {
      const attempt = await account.startLogin({ port: o.port ? Number(o.port) : undefined });
      process.stderr.write(
        [
          "ブラウザで ChatGPT にサインインし、プランの利用に同意してください:",
          `  ${attempt.url}`,
          `（${attempt.redirectUri} で待っています。5分で取り消します）`,
          o.paste
            ? "ブラウザが「接続できません」になったら、そのときのアドレスバーの URL をここに貼って Enter:"
            : "DevContainer などでブラウザがコールバックに届かないときは、--paste を付けてやり直してください",
          "",
        ].join("\n"),
      );
      if (!o["no-browser"] && !o.paste) openBrowser(attempt.url);
      let s: ChatGptStatus;
      try {
        if (o.paste) {
          const rl = createInterface({ input: process.stdin });
          const line = new Promise<string>((res) => rl.once("line", res));
          s = await Promise.race([attempt.done, line.then((url) => attempt.submit(url))]).finally(() => rl.close());
        } else {
          s = await attempt.done;
        }
      } catch (e) {
        throw signInFailure(e);
      }
      return { data: s, text: `サインインしました: ${describe(s)}`, code: s.planAllowed ? 0 : 1 };
    }
    case "logout": {
      const r = await account.logout({ forget: o.forget });
      return { data: { ...r, status: await account.status() }, text: r.message };
    }
    default:
      throw new UsageError("p3 chatgpt login | status | logout");
  }
}

function describe(s: ChatGptStatus): string {
  if (!s.connected) return s.registered ? "接続していません（このマシンは登録済み。p3 chatgpt login でサインイン）" : "接続していません（p3 chatgpt login でサインイン）";
  const plan = s.planAllowed ? "ChatGPT プランを使います" : "プランの利用が許可されていません（もう一度サインインして同意してください）";
  return `${s.email ?? "（アカウント不明）"}  ${plan}  トークンの期限 ${s.expiresAt?.slice(0, 16).replace("T", " ")}（使うときに更新）`;
}

/** ブラウザを開く（DevContainer では VS Code が BROWSER にホストで開く仕組みを入れる）。開けなくても URL は表示済み */
function openBrowser(url: string) {
  const cmd = process.env.BROWSER || (process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open");
  try {
    const p = spawn(cmd, [url], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // URL は表示してある
  }
}
