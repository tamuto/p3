import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DATA_DIR_NAME = ".pcube";

/**
 * データディレクトリ（.pcube/）を探す。
 *
 *   1. 明示指定（--dir / PCUBE_DATA_DIR）
 *   2. git のメインの作業ツリーの .pcube/
 *      要望ごとの作業ツリー（git worktree）の中で実行しても、タスクの状態はメインの1か所に書く。
 *      各作業ツリーの .pcube/ はブランチ時点の写しなので、そこに書くと状態が分岐してしまう。
 *   3. カレントから上へ辿って最初に見つかった .pcube/
 */
export function locateDataDir(cwd = process.cwd(), explicit = process.env.PCUBE_DATA_DIR): string | undefined {
  if (explicit) return resolve(cwd, explicit);
  const main = mainWorktree(cwd);
  if (main && existsSync(join(main, DATA_DIR_NAME, "project.yaml"))) return join(main, DATA_DIR_NAME);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, DATA_DIR_NAME, "project.yaml"))) return join(dir, DATA_DIR_NAME);
    if (dirname(dir) === dir) return undefined;
  }
}

function mainWorktree(cwd: string): string | undefined {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // 通常は <main>/.git。bare リポジトリなどはメインの作業ツリーが無いので対象外
    return common.endsWith("/.git") ? dirname(common) : undefined;
  } catch {
    return undefined;
  }
}
