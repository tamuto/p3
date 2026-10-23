import type { Request, Task } from "../shared/types.ts";
import { defaultRepo } from "../shared/workTarget.ts";
import type { P3Context } from "./context.ts";
import { withArchiveCheck, withChildOrder, withNewChild, withParentChange } from "./hierarchy.ts";
import { type AncestorWarning, checkStatusChange, reopenAncestors, reopenIfNeeded } from "./requestStatus.ts";
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

/**
 * タスクを変えた結果。reopened: 対応済から進行中に戻した要望 / reopenedAncestors: 同じく戻した祖先（近い順）/
 * warnings: 置き換えられたタスクへの着手（superseded）・完了済の祖先の下に未完了ができた（ancestor_done）
 */
export interface TaskResult {
  task: Task;
  warnings: (Warning | AncestorWarning)[];
  reopened?: string;
  reopenedAncestors?: string[];
}

/** 要望を作った・変えた結果に添える、祖先を戻した結果（無ければ何も足さない） */
export type RequestResult = Request & { reopenedAncestors?: string[]; warnings?: AncestorWarning[] };

function changed(ctx: P3Context, kind: "task" | "request", request: string, ref?: string) {
  ctx.ws.emit({ type: "changed", kind, request, ref });
}

/** 要望のマイルストーンは project.yaml にあるものだけ */
export function checkMilestone(ctx: P3Context, id: string | null | undefined) {
  if (id && !ctx.ws.project.milestones.some((m) => m.id === id)) {
    throw new OpRuleError(`マイルストーンがありません: ${id}（p3 milestone add ${id} か、画面のリリースノートの「マイルストーン」タブで追加してください）`);
  }
}

/**
 * マイルストーンを外すときの規則（CLI の milestone rm と、API の設定全体の更新で同じに効かせる）。
 * next: 外した後に残るマイルストーンの ID。使っている要望か、リリースノート（読めないファイルも含む）があれば断る
 */
export async function checkMilestoneRemoval(ctx: P3Context, next: string[]): Promise<void> {
  const keep = new Set(next);
  const removed = ctx.ws.project.milestones.map((m) => m.id).filter((id) => !keep.has(id));
  if (!removed.length) return;
  const used = [...new Set(ctx.ws.requests.list().flatMap((r) => (r.milestone && removed.includes(r.milestone) ? [r.milestone] : [])))];
  if (used.length) {
    const n = (id: string) => ctx.ws.requests.list().filter((r) => r.milestone === id).length;
    throw new OpRuleError(`使用中のマイルストーンは消せません: ${used.map((id) => `${id}（要望 ${n(id)} 件）`).join(", ")}。要望の milestone を外してから消してください`);
  }
  const notes = (await ctx.ws.releaseNotes.ids()).filter((id) => removed.includes(id));
  if (notes.length) {
    throw new OpRuleError(`リリースノートのあるマイルストーンは消せません: ${notes.join(", ")}（release-notes/<ID>.md を残すなら消さないでください）`);
  }
}

/** 要望を変えた後: 配下に未完了ができたら対応済の祖先を進行中に戻し（変更通知も）、完了済の祖先は警告にする */
async function afterRequestWrite(ctx: P3Context, rid: string, actor?: string) {
  const up = await reopenAncestors(ctx.ws, rid, actor);
  for (const a of up.reopened) changed(ctx, "request", a);
  return up;
}

const withAncestors = (r: Request, up: Awaited<ReturnType<typeof afterRequestWrite>>): RequestResult => ({
  ...r,
  ...(up.reopened.length ? { reopenedAncestors: up.reopened } : {}),
  ...(up.warnings.length ? { warnings: up.warnings } : {}),
});

/** タスクを変えた後: ブランチの割り当てと、対応済の要望（と祖先）に未完了のタスクができたら進行中に戻す */
async function afterTaskWrite(ctx: P3Context, rid: string, task: Task, repo: string | null | undefined, actor?: string) {
  if (repo) await ensureWorkstreams(ctx.ws, rid, [repo], actor);
  const reopened = (await reopenIfNeeded(ctx.ws, rid, actor)) ? rid : undefined;
  changed(ctx, "task", rid, task.ref);
  if (reopened) changed(ctx, "request", rid);
  const up = await afterRequestWrite(ctx, rid, actor);
  return { reopened, ...(up.reopened.length ? { reopenedAncestors: up.reopened } : {}), ancestorWarnings: up.warnings };
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
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, repo, actor);
  return { task, warnings: ancestorWarnings, ...after };
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
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, patch.repo, opts.actor);
  return { task, warnings: [...warnings, ...ancestorWarnings], ...after };
}

/** タスクをアーカイブする（.archive/ へ移す。消さない） */
export async function archiveTask(ctx: P3Context, rid: string, tid: string): Promise<void> {
  await ctx.ws.tasksOf(rid).archive(tid);
  changed(ctx, "task", rid, `${rid}/${tid}`);
}

/**
 * 要望を作る（下書き）。parent を付けると子の要望にする（親を確かめ、指定していない期限・マイルストーン・タグを親から写す。
 * hierarchy.ts）。子のブランチは子のタスク化で割り当てる（親の workstreams は写さない）
 */
export async function createRequest(ctx: P3Context, input: Partial<Request> & { title: string }, actor?: string): Promise<RequestResult> {
  const create = async (inp: Partial<Request> & { title: string }) => {
    checkMilestone(ctx, inp.milestone);
    return ctx.ws.requests.create({ body: "", areas: [], tags: [], ...inp, status: "draft" }, actor);
  };
  const { parent, ...rest } = input;
  const r = parent ? await withNewChild(ctx.ws, parent, rest, (inp) => create({ ...inp, title: input.title })) : await create(rest);
  changed(ctx, "request", r.id);
  if (r.parent) changed(ctx, "request", r.parent);
  // 対応済の親に未完了の子を足した
  return r.parent ? withAncestors(r, await afterRequestWrite(ctx, r.id, actor)) : r;
}

/**
 * 要望を変える。対応済にするのは全タスクが完了のときだけ（requestStatus.ts）。
 * parent を含むなら親の付け替え（undefined で外す）を関係のロックの中で確かめてから書く（hierarchy.ts）
 */
export async function updateRequest(ctx: P3Context, rid: string, patch: Partial<Request>, opts: WriteOpts = {}): Promise<RequestResult> {
  checkMilestone(ctx, patch.milestone);
  await checkStatusChange(ctx.ws, rid, patch.status);
  // 状態か親が変わったら、未完了になった配下の分だけ祖先を戻す
  const after = async (r: Request) => (patch.status !== undefined || "parent" in patch ? withAncestors(r, await afterRequestWrite(ctx, r.id, opts.actor)) : r);
  if (!("parent" in patch)) {
    const r = await ctx.ws.requests.update(rid, patch, opts);
    changed(ctx, "request", r.id);
    return after(r);
  }
  const { result: r, previous } = await withParentChange(ctx.ws, rid, patch.parent, () => ctx.ws.requests.update(rid, patch, opts));
  changed(ctx, "request", r.id);
  // 前と今の親の子の一覧も変わる
  for (const p of new Set([previous, r.parent])) if (p && p !== r.id) changed(ctx, "request", p);
  return after(r);
}

/**
 * 子の表示順を保存する（親の request.md の childOrder だけを書く。子・タスク・親子の所属は変えない）。ids は今の直下の子の完全な並び。
 * 子の集合が違えば child_order_invalid（hierarchy.ts）、expectedRev が親の rev と違えば ConflictError で、どちらも何も書かない。
 * 表示の順で、実行の順・着手できるかは表さない
 */
export async function orderChildren(ctx: P3Context, rid: string, ids: string[], opts: WriteOpts = {}): Promise<Request> {
  const r = await withChildOrder(ctx.ws, rid, ids, () => ctx.ws.requests.update(rid, { childOrder: [...ids] }, opts));
  changed(ctx, "request", r.id);
  return r;
}

/** 要望をアーカイブする（フォルダごと .archive/ へ）。子のある要望・親のある要望は断る（hierarchy.ts） */
export async function archiveRequest(ctx: P3Context, rid: string): Promise<void> {
  await withArchiveCheck(ctx.ws, rid, () => ctx.ws.requests.archive(rid));
  changed(ctx, "request", rid);
}
