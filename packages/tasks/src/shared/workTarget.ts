import type { ProjectConfig, Request, Task, Workstream } from "./types.ts";

/**
 * タスクの作業先と、要望のリポジトリごとのブランチ。作業先にできるのは writable な参照先だけ。
 */

export const writableRepos = (p: Pick<ProjectConfig, "repos">): string[] => p.repos.filter((r) => r.writable).map((r) => r.name);

/** 作業先を書かずにタスクを足したときの作業先: 作業先にできる参照先が1つならそれ、ほかは作業先なし */
export const defaultRepo = (p: Pick<ProjectConfig, "repos">): string | null => {
  const w = writableRepos(p);
  return w.length === 1 ? w[0] : null;
};

/** タスクの作業先（作業先なしは undefined） */
export const taskRepo = (t: Pick<Task, "repo">): string | undefined => t.repo ?? undefined;

/** 要望のリポジトリごとのブランチ */
export const requestWorkstreams = (r: Pick<Request, "workstreams">): Record<string, Workstream> => ({ ...r.workstreams });

/** 作業先にできない理由（できれば undefined）。null（作業先なし）はいつでもよい */
export function repoTargetProblem(repo: string | null | undefined, p: Pick<ProjectConfig, "repos">): string | undefined {
  if (repo === null || repo === undefined) return undefined;
  if (!p.repos.some((r) => r.name === repo)) return `作業先「${repo}」は参照先に登録されていません（p3 repo ls）`;
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
