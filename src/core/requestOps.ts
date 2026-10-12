import type { Request, Task } from "../shared/types.ts";
import { defaultRepo } from "../shared/workTarget.ts";
import type { P3Context } from "./context.ts";
import { checkStatusChange, reopenIfNeeded } from "./requestStatus.ts";
import { startWarnings, type Warning } from "./supersede.ts";
import { checkRepoTarget, ensureWorkstreams } from "./workTargets.ts";

/**
 * 要望とタスクの変更の手順。CLI と API はここを呼び、引数の解釈と出力だけを持つ。
 * 規則（作業先・対応済・置き換えの警告・ブランチの割り当て・進行中に戻す・変更通知）を足すときは、ここだけを直す。
 * タスクの関係（depends_on・supersedes）は Preflight のタスク化だけが張る（手で張る操作は持たない）
 *
 * 手順はどれも「確かめる（何も書かない）→ 保存 → 後始末（ブランチの割り当て・進行中に戻す）→ 変更通知」の順。
 */

/** 入力が規則に合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class OpRuleError extends Error {}

export interface WriteOpts {
  /** 楽観ロック。違えば ConflictError */
  expectedRev?: number;
  actor?: string;
}

/** タスクを変えた結果。reopened: 対応済から進行中に戻した要望 */
export interface TaskResult {
  task: Task;
  warnings: Warning[];
  reopened?: string;
}

function changed(ctx: P3Context, kind: "task" | "request", request: string, ref?: string) {
  ctx.ws.emit({ type: "changed", kind, request, ref });
}

/** 要望のマイルストーンは project.yaml にあるものだけ */
export function checkMilestone(ctx: P3Context, id: string | null | undefined) {
  if (id && !ctx.ws.project.milestones.some((m) => m.id === id)) {
    throw new OpRuleError(`マイルストーンがありません: ${id}（p3 milestone add ${id} か、画面の設定で追加してください）`);
  }
}

/** タスクを変えた後: ブランチの割り当てと、対応済の要望に未完了のタスクができたら進行中に戻す */
async function afterTaskWrite(ctx: P3Context, rid: string, task: Task, repo: string | null | undefined, actor?: string): Promise<string | undefined> {
  if (repo) await ensureWorkstreams(ctx.ws, rid, [repo], actor);
  const reopened = (await reopenIfNeeded(ctx.ws, rid, actor)) ? rid : undefined;
  changed(ctx, "task", rid, task.ref);
  if (reopened) changed(ctx, "request", rid);
  return reopened;
}

/**
 * タスクを作る。repo: 省くと作業先にできる参照先が1つならそれ（ほかは作業先なし）、null は作業先なし。
 * 作業先とリポジトリごとの成果物の参照先は、作業先にできるものだけ（書く前に断る）
 */
export async function createTask(ctx: P3Context, rid: string, input: Partial<Task> & { title: string }, actor?: string): Promise<TaskResult> {
  ctx.ws.requests.require(rid);
  const repo = "repo" in input ? (input.repo ?? null) : defaultRepo(ctx.ws.project);
  checkRepoTarget(ctx.ws, repo);
  for (const o of input.repoOutputs ?? []) checkRepoTarget(ctx.ws, o.repo);
  const task = await ctx.ws.tasksOf(rid).create({ ...input, repo, status: input.status ?? "todo" }, actor);
  return { task, warnings: [], reopened: await afterTaskWrite(ctx, rid, task, repo, actor) };
}

/**
 * タスクを変える。checked: 人の「済み」を付ける / 外す（付けられるのは完了したタスクだけ）。
 * 置き換えられたタスクを作業中にすると warnings を返す（変更はする）
 */
export async function updateTask(
  ctx: P3Context,
  rid: string,
  tid: string,
  patch: Partial<Task> & { checked?: boolean },
  opts: WriteOpts = {},
): Promise<TaskResult> {
  const col = ctx.ws.tasksOf(rid);
  const cur = col.require(tid);
  const { checked, ...rest } = patch;
  const next: Partial<Task> = { ...rest };
  if ("repo" in patch) {
    checkRepoTarget(ctx.ws, patch.repo);
    next.repo = patch.repo ?? null;
  }
  for (const o of patch.repoOutputs ?? []) checkRepoTarget(ctx.ws, o.repo);
  if (checked !== undefined) {
    if (checked && (next.status ?? cur.status) !== "done") throw new OpRuleError(`${cur.ref} はまだ完了していません（済みにできるのは完了したタスクだけ）`);
    next.checkedAt = checked ? new Date().toISOString() : undefined;
  }
  const warnings = startWarnings(ctx.ws, cur.ref, cur.status, next.status);
  const task = await col.update(tid, next, opts);
  return { task, warnings, reopened: await afterTaskWrite(ctx, rid, task, patch.repo, opts.actor) };
}

/** タスクをアーカイブする（.archive/ へ移す。消さない） */
export async function archiveTask(ctx: P3Context, rid: string, tid: string): Promise<void> {
  await ctx.ws.tasksOf(rid).archive(tid);
  changed(ctx, "task", rid, `${rid}/${tid}`);
}

/** 要望を作る（下書き） */
export async function createRequest(ctx: P3Context, input: Partial<Request> & { title: string }, actor?: string): Promise<Request> {
  checkMilestone(ctx, input.milestone);
  const r = await ctx.ws.requests.create({ body: "", areas: [], tags: [], ...input, status: "draft" }, actor);
  changed(ctx, "request", r.id);
  return r;
}

/** 要望を変える。対応済にするのは全タスクが完了のときだけ（requestStatus.ts） */
export async function updateRequest(ctx: P3Context, rid: string, patch: Partial<Request>, opts: WriteOpts = {}): Promise<Request> {
  checkMilestone(ctx, patch.milestone);
  await checkStatusChange(ctx.ws, rid, patch.status);
  const r = await ctx.ws.requests.update(rid, patch, opts);
  changed(ctx, "request", r.id);
  return r;
}

/** 要望をアーカイブする（フォルダごと .archive/ へ） */
export async function archiveRequest(ctx: P3Context, rid: string): Promise<void> {
  await ctx.ws.requests.archive(rid);
  changed(ctx, "request", rid);
}
