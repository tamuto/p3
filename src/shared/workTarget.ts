import { effectiveRepos, LEGACY_REPO } from "./repos.ts";
import type { ProjectConfig, Request, Task, Workstream } from "./types.ts";

/**
 * タスクの作業先と、要望のリポジトリごとのブランチ。
 *
 *   作業先にできるのは writable な参照先だけ（共有の repos が無いプロジェクトは今までの main）
 *   以前のタスク（repo が無い）と、以前の1つのブランチ（workstream）は主リポジトリのもの
 *   主リポジトリ: 共有の repos が無ければ main、あれば writable の先頭（無ければ先頭）
 */

export const writableRepos = (p: Pick<ProjectConfig, "repos">): string[] =>
  p.repos.length ? p.repos.filter((r) => r.writable).map((r) => r.name) : [LEGACY_REPO];

export function primaryRepo(p: Pick<ProjectConfig, "repos">): string {
  if (!p.repos.length) return LEGACY_REPO;
  return (p.repos.find((r) => r.writable) ?? effectiveRepos(p.repos)[0]).name;
}

/** タスクの作業先（作業先なしは undefined） */
export function taskRepo(t: Pick<Task, "repo">, p: Pick<ProjectConfig, "repos">): string | undefined {
  if (t.repo === undefined) return primaryRepo(p);
  return t.repo ?? undefined;
}

/** 要望のリポジトリごとのブランチ（以前の1つのブランチは主リポジトリの分） */
export function requestWorkstreams(r: Pick<Request, "workstream" | "workstreams">, p: Pick<ProjectConfig, "repos">): Record<string, Workstream> {
  return { ...(r.workstream ? { [primaryRepo(p)]: r.workstream } : {}), ...(r.workstreams ?? {}) };
}

/** 作業先にできない理由（できれば undefined）。null（作業先なし）はいつでもよい */
export function repoTargetProblem(repo: string | null | undefined, p: Pick<ProjectConfig, "repos">): string | undefined {
  if (repo === null || repo === undefined) return undefined;
  const known = effectiveRepos(p.repos).find((r) => r.name === repo);
  if (!known) return `作業先「${repo}」は参照先に登録されていません（p3 repo ls）`;
  if (!writableRepos(p).includes(repo)) return `「${repo}」は参照だけの参照先なので作業先にできません（作業先にするなら p3 repo set ${repo} writable=true）`;
  return undefined;
}

/** 画面の作業先の選択肢（作業先にできる参照先と「作業先なし」）。今の値が選べないもの（登録から消えた・参照だけ）でも、黙って置き換えずに選択肢に残す */
export interface RepoChoice {
  value: string;
  label: string;
  /** 今の値だが、作業先にはできない */
  invalid?: boolean;
}

export const NO_REPO = "";

export function repoChoices(p: Pick<ProjectConfig, "repos">, current: string | null | undefined): RepoChoice[] {
  const writable = writableRepos(p);
  const out: RepoChoice[] = [...writable.map((name) => ({ value: name, label: name })), { value: NO_REPO, label: "作業先なし" }];
  if (current && !writable.includes(current)) out.unshift({ value: current, label: `${current}（作業先にできません）`, invalid: true });
  return out;
}
