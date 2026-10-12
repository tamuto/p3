import { execFileSync } from "node:child_process";
import { slugify } from "./store/fsutil.ts";
import type { Workspace } from "./store/workspace.ts";
import type { Workstream } from "../shared/types.ts";
import { primaryRepo, repoTargetProblem, requestWorkstreams } from "../shared/workTarget.ts";

/** 作業先にできない（参照先に無い・参照だけ）。何も変えていない */
export class RepoTargetError extends Error {}

/** 作業先を確かめる（作業先にできなければ RepoTargetError） */
export function checkRepoTarget(ws: Workspace, repo: string | null | undefined) {
  const problem = repoTargetProblem(repo, ws.project);
  if (problem) throw new RepoTargetError(problem);
}

/** 要望のブランチ名（branchPattern。日本語のタイトルは slug にならないので、そのときは区切りごと落とす） */
export function branchName(ws: Workspace, requestId: string, title: string): string {
  const slug = slugify(title);
  return ws.project.branchPattern.replace("{id}", requestId).replace(slug ? "{slug}" : /[-_/]?\{slug\}/, slug);
}

/** フォルダの git の実体（共通の .git のディレクトリ）。git でなければ undefined */
function gitIdentity(path: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export interface WorkstreamPlan {
  /** 新しく割り当てる（参照先の名前 → ブランチと作業ツリー） */
  add: Record<string, Workstream>;
  /** git でない（書き込めるフォルダ）ので、ブランチを割り当てない */
  noGit: string[];
}

/**
 * 作業先の集まりに要るブランチの割当を決める（ファイルは変えない。git のブランチや作業ツリーも作らない）。
 *   - 既に割り当てたリポジトリは上書きしない
 *   - git でないフォルダはブランチなし（作業先は残る）
 *   - リポジトリの中のサブフォルダは、それを含む git のリポジトリを基準にする。別の名前の参照先が同じ git の実体を指し、
 *     どちらにも割り当てることになるなら、理由を添えて RepoTargetError（同じリポジトリに2本のブランチを作らせない）
 *   - このマシンのパスが無い参照先は確かめられないので、名前どおりに割り当てる（作業の前にパスを登録してもらう）
 */
export function planWorkstreams(ws: Workspace, requestId: string, repos: readonly string[]): WorkstreamPlan {
  const request = ws.requests.require(requestId);
  const existing = requestWorkstreams(request, ws.project);
  const refs = new Map(ws.refs().map((r) => [r.name, r]));
  const identity = (name: string) => {
    const r = refs.get(name);
    return r?.status === "ok" && r.local ? gitIdentity(r.local) : undefined;
  };
  const plan: WorkstreamPlan = { add: {}, noGit: [] };
  const seen = new Map<string, string>();
  for (const [name] of Object.entries(existing)) {
    const id = identity(name);
    if (id) seen.set(id, name);
  }
  const branch = branchName(ws, requestId, request.title);
  for (const name of [...new Set(repos)]) {
    if (existing[name]) continue;
    const ref = refs.get(name);
    if (ref?.status === "ok" && ref.local) {
      const id = identity(name);
      if (!id) {
        plan.noGit.push(name);
        continue;
      }
      const other = seen.get(id);
      if (other && other !== name) {
        throw new RepoTargetError(
          `作業先「${name}」と「${other}」は同じ git のリポジトリです。1つの要望で同じリポジトリに2本のブランチは割り当てません（作業先をどちらかにそろえてください）`,
        );
      }
      seen.set(id, name);
    }
    plan.add[name] = { branch, worktree: `${ws.project.worktreeDir}/${requestId}` };
  }
  return plan;
}

/**
 * 割当を要望に書く（足すだけ。既存は消さない）。共有の参照先が無いプロジェクトの主リポジトリは、今までどおり workstream に書く
 */
export function workstreamPatch(ws: Workspace, requestId: string, plan: WorkstreamPlan) {
  const request = ws.requests.require(requestId);
  const add = { ...plan.add };
  const patch: { workstream?: Workstream; workstreams?: Record<string, Workstream> } = {};
  const primary = primaryRepo(ws.project);
  if (!ws.project.repos.length && add[primary] && !request.workstream) {
    patch.workstream = add[primary];
    delete add[primary];
  }
  if (Object.keys(add).length) patch.workstreams = { ...(request.workstreams ?? {}), ...add };
  return patch;
}

/** 作業先を足したタスク（手で足した・作業先を変えた）に要る割当を書く */
export async function ensureWorkstreams(ws: Workspace, requestId: string, repos: (string | null | undefined)[], actor?: string) {
  const names = repos.filter((r): r is string => !!r);
  if (!names.length) return;
  const patch = workstreamPatch(ws, requestId, planWorkstreams(ws, requestId, names));
  if (Object.keys(patch).length) await ws.requests.update(requestId, patch, { actor });
}
