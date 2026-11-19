import { dirname, join } from "node:path";
import { ChatGptAccount, OAuthError, type OAuthDeps } from "@infodb/chatgpt-plan";
import { userConfigPath } from "./userConfig.ts";

/**
 * ChatGPT（Sign in with ChatGPT のプラン利用）との接続。サインイン・トークンの保存と更新・解除は
 * @infodb/chatgpt-plan（llmcs の chatgpt-plan-ts）が行い、ここには P3 の決まりだけを置く。設計: docs/chatgpt-sign-in.md
 *
 *   ~/.config/infodb-p3/chatgpt.json   0600。秘密（トークン）を含む。個人設定（config.yaml）とは別のファイル
 *   ~/.config/infodb-p3/chatgpt.lock   トークンの更新の排他（CLI・serve・並行する Preflight で1つずつ）
 */
export { ChatGptAccount, ChatGptAuthError, OAuthError, type ChatGptStatus } from "@infodb/chatgpt-plan";

/** アプリの名前。初回の登録の agent_name_hint と、app-server の initialize の clientInfo.name をそろえる */
export const APP_NAME = "infodb_p3";

/** Codex に渡す access token の残りの長さ（1 ターンの途中で切れないように、部品の既定の 5 分より長く取る） */
export const CODEX_TOKEN_MIN_VALID_MS = 35 * 60_000;

export const connectionPath = () => join(dirname(userConfigPath()), "chatgpt.json");

/** P3 の接続（CLI と serve で同じファイルを使う）。file と deps はテストで差し替える */
export function chatgptAccount(file = connectionPath(), deps?: OAuthDeps): ChatGptAccount {
  return new ChatGptAccount({ file, appName: APP_NAME, appLabel: "P3", ...(deps ? { deps } : {}) });
}

/** サインインの失敗を CLI で次にすることが分かる文言にする（部品の文言は呼び方が P3 のものではない） */
export function signInFailure(e: unknown): Error {
  if (e instanceof OAuthError && e.code === "account_mismatch") {
    return new Error(`${e.message.replace(/（登録ごと消す: .*）$/, "")}（p3 chatgpt logout --forget で登録ごと解除してから、サインインし直してください）`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
