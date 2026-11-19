import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * CLI の共通の小物（入口と製品のコマンドの両方が使う。複数パッケージの構成では kit に置く候補。docs/architecture.md「パッケージの構成」）
 */

/** 使い方の誤り（終了コード 1。メッセージだけを出す） */
export class UsageError extends Error {}

/** 入力されたパス。対話式の入力ではシェルが ~ を展開しないので、ここで展開する */
export const resolvePath = (cwd: string, p: string) => resolve(cwd, p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** git の出力（失敗・空は undefined） */
export function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** リポジトリのルート（git のメインの作業ツリー）。git 管理外ならカレント */
export function repoRoot(cwd: string): string {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common?.endsWith("/.git")) return common.slice(0, -"/.git".length);
  return git(cwd, "rev-parse", "--show-toplevel") ?? cwd;
}
