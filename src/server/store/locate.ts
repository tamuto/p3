import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { UserConfig } from "../userConfig.ts";

/** リポジトリの中にデータを置く場合のフォルダ名（以前の既定。今もデモやテストで使う） */
export const DATA_DIR_NAME = ".p3";

export interface ResolvedProject {
  /** 個人設定に登録したプロジェクト名（登録していないフォルダを --dir で指したときは無い） */
  name?: string;
  dataDir: string;
  /** 個人設定の参照先の名前 → このマシンのパス（Preflight が読む。全部） */
  repos: Record<string, string>;
  /** どうやって決まったか */
  via: "dir" | "project" | "cwd" | "legacy" | "only";
}

/** 操作するプロジェクトが決まらない（次に何をすればよいかをメッセージに含める） */
export class ProjectNotResolvedError extends Error {}

/**
 * 操作するプロジェクトを決める。環境変数では切り替えない（同じ人が複数のプロジェクトを行き来するため）。
 *
 *   1. --dir <フォルダ>          データのフォルダを直接指す
 *   2. --project <名前>          個人設定に登録したプロジェクト
 *   3. 今いる場所                 登録したプロジェクトのデータのフォルダか、そのリポジトリ（作業ツリーを含む）の中
 *   4. リポジトリの中の .p3/   以前の置き方（git のメインの作業ツリー → 上へ辿る）
 *   5. 登録が1つだけ              それを使う
 */
export function resolveProject(o: { cwd: string; dir?: string; project?: string; user: UserConfig }): ResolvedProject {
  const entries = Object.entries(o.user.projects);
  const named = ([name, p]: (typeof entries)[number], via: ResolvedProject["via"]): ResolvedProject => ({
    name,
    dataDir: p.dir,
    repos: { ...p.repos },
    via,
  });

  if (o.dir) {
    const dataDir = resolve(o.cwd, o.dir);
    const hit = entries.find(([, p]) => p.dir === dataDir);
    return hit ? named(hit, "dir") : { dataDir, repos: {}, via: "dir" };
  }
  if (o.project) {
    const hit = entries.find(([name]) => name === o.project);
    if (!hit) throw new ProjectNotResolvedError(`プロジェクト「${o.project}」は登録されていません。\n${listing(o.user)}`);
    return named(hit, "project");
  }

  const places = [...new Set([resolve(o.cwd), mainWorktree(o.cwd)].filter((x): x is string => !!x))];
  const hits = entries.filter(([, p]) => places.some((pl) => inside(pl, p.dir) || Object.values(p.repos).some((r) => inside(pl, r))));
  if (hits.length === 1) return named(hits[0], "cwd");
  if (hits.length > 1) {
    throw new ProjectNotResolvedError(
      `この場所は複数のプロジェクトに登録されています: ${hits.map(([n]) => n).join(", ")}\n  → p3 --project <名前> <コマンド> で選んでください`,
    );
  }

  const legacy = findDataDir(o.cwd);
  if (legacy) {
    const hit = entries.find(([, p]) => p.dir === legacy);
    return hit ? named(hit, "legacy") : { dataDir: legacy, repos: {}, via: "legacy" };
  }
  if (entries.length === 1) return named(entries[0], "only");

  throw new ProjectNotResolvedError(
    entries.length
      ? `操作するプロジェクトが決まりません（今いる場所: ${o.cwd}）。\n${listing(o.user)}`
      : "プロジェクトがまだありません。管理したいリポジトリの中で次を実行してください:\n  p3 init --project <名前> --dir <データを置くフォルダ>",
  );
}

function listing(user: UserConfig): string {
  const entries = Object.entries(user.projects);
  if (!entries.length) return "  （登録済みのプロジェクトはありません。p3 init で作ってください）";
  const w = Math.max(...entries.map(([n]) => n.length));
  return [
    "  登録済みのプロジェクト:",
    ...entries.map(([n, p]) => `    ${n.padEnd(w)}  ${p.dir}`),
    "  → p3 --project <名前> <コマンド>、またはプロジェクトのリポジトリの中で実行してください",
  ].join("\n");
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * リポジトリの中の .p3/ を探す（以前の置き方）。
 * 要望ごとの作業ツリーの中で実行しても、git のメインの作業ツリーの .p3/ を使う（各作業ツリーの .p3/ はブランチ時点の写し）。
 */
export function findDataDir(cwd: string): string | undefined {
  const main = mainWorktree(cwd);
  if (main && existsSync(join(main, DATA_DIR_NAME, "project.yaml"))) return join(main, DATA_DIR_NAME);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, DATA_DIR_NAME, "project.yaml"))) return join(dir, DATA_DIR_NAME);
    if (dirname(dir) === dir) return undefined;
  }
}

/** git のメインの作業ツリー（要望の作業ツリーの中からでもメインを返す） */
export function mainWorktree(cwd: string): string | undefined {
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
