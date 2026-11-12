import { acceptanceChanged, applyAcceptanceOps, type AcceptanceOp } from "../shared/acceptance.ts";
import { applyBlockOp, checkBlockedStatus, type BlockOp } from "../shared/taskBlock.ts";
import { qualityCriteria, standardHash, taskQualityDiff } from "../shared/quality.ts";
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
  /** 済みのタスクの受け入れ基準・証拠の中身が変わったので、人の「済み」を外した（理由） */
  checkCleared?: string;
}

/** 品質基準の取り込み方（auto: 作業先に当てはまるもの / none: 取り込まない / ID の並び: 明示したもの） */
export type QualityChoice = "auto" | "none" | readonly string[];

/** 品質基準を受け入れ基準に取り込む操作（未設定・読めない設定なら無し） */
export function qualityOpsFor(ctx: P3Context, repo: string | null, choice: QualityChoice): AcceptanceOp[] {
  const q = ctx.ws.project.quality;
  if (q?.state !== "set" || choice === "none") return [];
  if (choice === "auto" && !repo) return [];
  return qualityCriteria(q.config, ctx.ws.project.qualityVersion ?? "", { repo, ...(choice === "auto" ? {} : { ids: choice }) }).map((c) => ({ op: "add", text: c.text, quality: c.quality }));
}

/**
 * 今の品質基準との差分から、明示して選んだものを受け入れ基準に取り込む（add は足す、change は文と出典を直す、remove・exempt は消す）。
 * keys: "<kind>:<品質 ID>"（省くと edited 以外の全部）。書く直前に読み直した値に当てる。プロジェクトの設定を変えただけではタスクは変わらない
 */
export async function importQuality(ctx: P3Context, rid: string, tid: string, keys: readonly string[] | undefined, opts: WriteOpts = {}): Promise<TaskResult & { applied: string[] }> {
  const t = ctx.ws.tasksOf(rid).require(tid);
  const diff = taskQualityDiff(t.acceptanceCriteria ?? [], ctx.ws.project.quality, t.repo).filter((d) => d.kind !== "edited");
  const chosen = keys ? diff.filter((d) => keys.includes(`${d.kind}:${d.quality}`)) : diff;
  if (keys) {
    const unknown = keys.filter((k) => !diff.some((d) => `${d.kind}:${d.quality}` === k));
    if (unknown.length) throw new OpRuleError(`取り込める差分にありません: ${unknown.join(", ")}（今の差分は p3 criteria ${t.id} quality で見る）`);
  }
  if (!chosen.length) throw new OpRuleError(`${t.ref} に取り込む品質基準の差分はありません`);
  const q = ctx.ws.project.quality;
  const version = ctx.ws.project.qualityVersion ?? "";
  const config = q?.state === "set" ? q.config : { standards: [] };
  const hashOf = (id: string) => standardHash(config.standards.find((s) => s.id === id)!);
  const acceptance: AcceptanceOp[] = chosen.map((d): AcceptanceOp => {
    if (d.kind === "add") return { op: "add", text: d.text!, quality: { id: d.quality, hash: hashOf(d.quality), version } };
    if (d.kind === "change") return { op: "edit", id: d.criterion!, text: d.text!, quality: { id: d.quality, hash: hashOf(d.quality), version } };
    return { op: "remove", id: d.criterion! };
  });
  const r = await updateTask(ctx, rid, tid, { acceptance }, opts);
  return { ...r, applied: chosen.map((d) => `${d.kind}:${d.quality}`) };
}

/** 書く必要が無い（更新の中から抜けるため。外には出さない） */
class NoChange extends Error {}

/** 済みを外した理由（基準・証拠の中身が変わった） */
export const CHECK_CLEARED_BY_ACCEPTANCE = "受け入れ基準か証拠の中身が変わったため、人の「済み」を外しました（もう一度確かめてください）";

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
  const reviewed = (await ctx.ws.milestoneReviews.milestones()).filter((id) => removed.includes(id));
  if (reviewed.length) {
    throw new OpRuleError(`レビューの履歴のあるマイルストーンは消せません（ID も変えられません）: ${reviewed.join(", ")}（milestone-reviews/<ID>/ に残っています）`);
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
export async function createTask(
  ctx: P3Context,
  rid: string,
  { criteria, quality, ...input }: Partial<Task> & { title: string; criteria?: readonly string[]; quality?: QualityChoice },
  actor?: string,
): Promise<TaskResult> {
  ctx.ws.requests.require(rid);
  const repo = "repo" in input ? (input.repo ?? null) : defaultRepo(ctx.ws.project);
  checkRepoTarget(ctx.ws, repo);
  for (const o of input.repoOutputs ?? []) checkRepoTarget(ctx.ws, o.repo);
  // 受け入れ基準は文の並びで受け取り、ID（A1, A2, ...）はここで振る（基準・証拠をそのまま渡す道は持たない）
  // 停止は作るときには付けない（作業中にしてから block で付ける）
  const { acceptanceCriteria: _c, acceptanceEvidence: _e, acceptanceSeq: _s, acceptanceProblems: _p, block: _b, blockHistory: _bh, blockProblems: _bp, ...plain } = input;
  // 品質基準: 作業先があれば当てはまるものを取り込む（auto）。作業先なしは明示したものだけ。none は取り込まない
  const fromQuality = qualityOpsFor(ctx, repo, quality ?? "auto");
  const ops: AcceptanceOp[] = [...(criteria ?? []).map((text): AcceptanceOp => ({ op: "add", text })), ...fromQuality];
  const acceptance = ops.length ? applyAcceptanceOps({}, ops, { now: new Date().toISOString(), actor }) : {};
  const task = await ctx.ws.tasksOf(rid).create({ ...plain, ...acceptance, repo, status: input.status ?? "todo" }, actor);
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, repo, actor);
  return { task, warnings: ancestorWarnings, ...after };
}

/**
 * タスクを変える。checked: 人の「済み」を付ける / 外す（付けられるのは完了したタスクだけ）。
 * acceptance: 受け入れ基準・証拠への操作（shared/acceptance.ts。書く直前に読み直した今の値に当て、規則に合わなければ何も書かない）。
 * 済みのタスクの基準・証拠の中身が変わったら済みを外し、checkCleared に理由を返す（同じ値の再保存・成果物だけの追加では外さない）。
 * 置き換えられたタスクを作業中にすると warnings を返す（変更はする）
 */
export async function updateTask(
  ctx: P3Context,
  rid: string,
  tid: string,
  patch: Partial<Task> & { checked?: boolean; acceptance?: readonly AcceptanceOp[]; blockOp?: BlockOp },
  opts: WriteOpts = {},
): Promise<TaskResult> {
  const col = ctx.ws.tasksOf(rid);
  const cur = col.require(tid);
  const { checked, acceptance, blockOp, ...rest } = patch;
  // 基準・証拠は操作（acceptance）、停止は操作（blockOp）でだけ変える（値・履歴をそのまま書く道は持たない）
  const { acceptanceCriteria: _c, acceptanceEvidence: _e, acceptanceSeq: _s, acceptanceProblems: _p, block: _b, blockHistory: _bh, blockProblems: _bp, ...plain } = rest;
  const next: Partial<Task> = { ...plain };
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
  let checkCleared: string | undefined;
  // 停止の操作だけで何も変わらない（同じ内容の付け直し・付いていない解除）なら書かない（rev を上げない）
  const onlyBlock = !!blockOp && !acceptance?.length && Object.keys(next).length === 0;
  let unchanged: Task | undefined;
  const write = () =>
    col.update(
      tid,
      (fresh) => {
        const now = new Date().toISOString();
        let out: Partial<Task> = next;
        // 停止: 書く直前に読み直した値と、更新した後の状態で確かめる（止まったままの移動・作業中でない付与は断る）
        const status = next.status ?? fresh.status;
        const blockTo = blockOp ? applyBlockOp(fresh, blockOp, { now, actor: opts.actor, status }) : undefined;
        if (onlyBlock && !blockTo) {
          unchanged = fresh;
          throw new NoChange();
        }
        if (blockTo) out = { ...out, ...blockTo };
        checkBlockedStatus(fresh.status, status, blockTo ? blockTo.block : fresh.block, fresh.ref);
        if (!acceptance?.length) return out;
        const changedTo = applyAcceptanceOps(fresh, acceptance, { now, actor: opts.actor });
        if (!acceptanceChanged(fresh, changedTo)) return out;
        // 済みの後に中身が変わった（同じ操作で済みを付け直すときは外さない）
        const clear = !!fresh.checkedAt && !("checkedAt" in next);
        if (clear) checkCleared = CHECK_CLEARED_BY_ACCEPTANCE;
        return { ...out, ...changedTo, ...(clear ? { checkedAt: undefined } : {}) };
      },
      opts,
    );
  const task = await write().catch((e: unknown) => {
    if (e instanceof NoChange && unchanged) return unchanged;
    throw e;
  });
  if (unchanged && task === unchanged) return { task, warnings };
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, patch.repo, opts.actor);
  return { task, warnings: [...warnings, ...ancestorWarnings], ...after, ...(checkCleared ? { checkCleared } : {}) };
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
