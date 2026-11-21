import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./usage.ts";

/**
 * CLI の作業の文脈（タスクを起点にした作業）。`p3 move <T> doing` で今の作業ツリーの git のフォルダに残し、そのタスクを作業中から動かすと消す。
 * 観測の操作は、入口がこれを読んで同じプロジェクト・作業中のタスクかを確かめてから、作業の帰属として observer に渡す
 * （要望のブランチの作業中のタスクの数から推測しない）。git の作業ツリーでなければ残さない
 */
export interface WorkSession {
  project: string;
  dataDir: string;
  /** <要望ID>/<T> */
  ref: string;
  at: string;
}

const file = (cwd: string) => {
  const dir = git(cwd, "rev-parse", "--absolute-git-dir");
  return dir && join(dir, "p3-work.json");
};

export function readWorkSession(cwd: string): WorkSession | undefined {
  const f = file(cwd);
  try {
    const s = f && (JSON.parse(readFileSync(f, "utf8")) as WorkSession);
    return s && typeof s.ref === "string" && typeof s.project === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

export function writeWorkSession(cwd: string, s: WorkSession) {
  const f = file(cwd);
  if (f) writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
}

/** そのタスクの文脈なら消す（別のタスクの文脈は残す） */
export function clearWorkSession(cwd: string, ref: string) {
  const f = file(cwd);
  if (f && readWorkSession(cwd)?.ref === ref) rmSync(f, { force: true });
}
