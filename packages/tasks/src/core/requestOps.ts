import { REQUEST_FIELD_GROUPS, TASK_FIELD_GROUPS, withoutManaged } from "./store/fieldGroups.ts";
import { acceptanceChanged, acceptanceSeqChanged, applyAcceptanceOps, type AcceptanceOp } from "../features/requirements/shared/acceptance.ts";
import { applyBlockOp, checkBlockedStatus, type BlockOp } from "../shared/taskBlock.ts";
import { qualityCriteria, QualityInputError } from "../features/quality/shared/quality.ts";
import type { Request, Task } from "../shared/types.ts";
import { answersKey, makeAnswer, putAnswer, RequirementInputError, type AnswerInput, type Clarification, type ClarifyAnswer } from "../features/requirements/shared/clarify.ts";
import { defaultRepo } from "../shared/workTarget.ts";
import { appendRework, reworkOf, REWORK_SKIPPED } from "../features/records/shared/reworkHistory.ts";
import type { P3Context } from "./context.ts";
import { withArchiveCheck, withChildOrder, withNewChild, withParentChange } from "./hierarchy.ts";
import { type AncestorWarning, checkStatusChange, reopenAncestors, reopenIfNeeded } from "./requestStatus.ts";
import { checkRepoTarget, ensureWorkstreams } from "./workTargets.ts";
import { observeRequest, observeTask } from "./systemObservations.ts";

/**
 * 要望とタスクの変更の手順。CLI と API はここを呼び、引数の解釈と出力だけを持つ。
 * 規則（作業先・対応済・置き換えの警告・ブランチの割り当て・進行中に戻す・変更通知）を足すときは、ここだけを直す。
 * タスクの関係（depends_on）は Preflight のタスク化だけが張る（手で張る操作は持たない）
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
 * warnings: 完了済の祖先の下に未完了ができた（ancestor_done）
 */
export interface TaskResult {
  task: Task;
  warnings: AncestorWarning[];
  reopened?: string;
  reopenedAncestors?: string[];
  /** 手戻りの履歴が壊れているため、今回の履歴を足せなかった（状態は変えた） */
  reworkSkipped?: string;
  /** 観測のシステムの項目に記録できなかった（項目・対象・理由。操作はした） */
  observationSkipped?: string[];
}

/** タスクを作るときに足す品質基準の受け入れ基準（作業先に当てはまるもの。未設定なら無し。読めない設定なら理由付きで断る） */
export function qualityOpsFor(ctx: P3Context, repo: string | null): AcceptanceOp[] {
  const q = ctx.ws.project.quality;
  if (q?.state === "invalid") throw new QualityInputError("quality_unreadable", `project.yaml の品質基準が読めないためタスクを作れません。ファイルを直してください: ${q.problems.join(" / ")}`);
  if (q?.state !== "set") return [];
  return qualityCriteria(q.config, repo).map((c) => ({ op: "add", text: c.text, quality: c.quality }));
}

/** 書く必要が無い（更新の中から抜けるため。外には出さない） */
class NoChange extends Error {}

/** 要望を作った・変えた結果に添える、祖先を戻した結果（無ければ何も足さない） */
export type RequestResult = Request & { reopenedAncestors?: string[]; warnings?: AncestorWarning[]; observationSkipped?: string[] };

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
  { criteria, ...input }: Partial<Task> & { title: string; criteria?: readonly string[] },
  actor?: string,
): Promise<TaskResult> {
  ctx.ws.requests.require(rid);
  const repo = "repo" in input ? (input.repo ?? null) : defaultRepo(ctx.ws.project);
  checkRepoTarget(ctx.ws, repo);
  for (const o of input.repoOutputs ?? []) checkRepoTarget(ctx.ws, o.repo);
  // 受け入れ基準は文の並びで受け取り、ID（A1, A2, ...）はここで振る（基準・証拠をそのまま渡す道は持たない）
  // 停止は作るときには付けない（作業中にしてから block で付ける）
  const plain = withoutManaged(input, TASK_FIELD_GROUPS);
  // 品質基準: 作業先に当てはまるものを受け入れ基準として足す（読めない設定なら何も書かずに断る）
  const ops: AcceptanceOp[] = [...(criteria ?? []).map((text): AcceptanceOp => ({ op: "add", text })), ...qualityOpsFor(ctx, repo)];
  const acceptance = ops.length ? applyAcceptanceOps({}, ops, { now: new Date().toISOString(), actor }) : {};
  const status = input.status ?? "todo";
  const task = await ctx.ws.tasksOf(rid).create({ ...plain, ...acceptance, repo, status }, actor);
  const observationSkipped = await observeTask(ctx, undefined, task, actor);
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, repo, actor);
  return { task, warnings: ancestorWarnings, ...after, ...(observationSkipped.length ? { observationSkipped } : {}) };
}

/**
 * タスクを変える。acceptance: 受け入れ基準・証拠への操作（shared/acceptance.ts。書く直前に読み直した今の値に当て、規則に合わなければ何も書かない）。
 * blockOp: 停止の操作。完了から戻したときは手戻りの履歴に1件足す（shared/reworkHistory.ts）。
 */
export async function updateTask(
  ctx: P3Context,
  rid: string,
  tid: string,
  patch: Partial<Task> & { acceptance?: readonly AcceptanceOp[]; blockOp?: BlockOp },
  opts: WriteOpts = {},
): Promise<TaskResult> {
  const col = ctx.ws.tasksOf(rid);
  const { acceptance, blockOp, ...rest } = patch;
  // 基準・証拠は操作（acceptance）、停止は操作（blockOp）でだけ変える（値・履歴をそのまま書く道は持たない）
  const plain = withoutManaged(rest, TASK_FIELD_GROUPS);
  const next: Partial<Task> = { ...plain };
  if ("repo" in patch) {
    checkRepoTarget(ctx.ws, patch.repo);
    next.repo = patch.repo ?? null;
  }
  for (const o of patch.repoOutputs ?? []) checkRepoTarget(ctx.ws, o.repo);
  let reworkSkipped: string | undefined;
  // 停止の操作だけで何も変わらない（同じ内容の付け直し・付いていない解除）なら書かない（rev を上げない）
  const onlyBlock = !!blockOp && !acceptance?.length && Object.keys(next).length === 0;
  let unchanged: Task | undefined;
  // 書く直前に読み直した値（観測のシステムの項目は、この値と書いた後の値で状態の変化を見る）
  let before: Task | undefined;
  const write = () =>
    col.update(
      tid,
      (fresh) => {
        before = fresh;
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
        if (acceptance?.length) {
          const changedTo = applyAcceptanceOps(fresh, acceptance, { now, actor: opts.actor });
          // 中身は同じでも（同じ操作の中で足して消したなど）採番が進んだら、採番だけを書く
          if (acceptanceChanged(fresh, changedTo)) out = { ...out, ...changedTo };
          else if (acceptanceSeqChanged(fresh, changedTo)) out = { ...out, acceptanceSeq: changedTo.acceptanceSeq };
        }
        // 手戻り（完了からの再開）。書く直前の値と保存する値で決める
        const rw = reworkOf(fresh, { status });
        if (!rw) return out;
        const list = appendRework(fresh, { at: now, ...(opts.actor ? { by: opts.actor } : {}), rev: fresh.rev + 1, ...rw });
        if (list) return { ...out, reworkHistory: list };
        reworkSkipped = REWORK_SKIPPED;
        return out;
      },
      opts,
    );
  const task = await write().catch((e: unknown) => {
    if (e instanceof NoChange && unchanged) return unchanged;
    throw e;
  });
  if (unchanged && task === unchanged) return { task, warnings: [] };
  const observationSkipped = before ? await observeTask(ctx, before, task, opts.actor) : [];
  const { ancestorWarnings, ...after } = await afterTaskWrite(ctx, rid, task, patch.repo, opts.actor);
  return { task, warnings: ancestorWarnings, ...after, ...(reworkSkipped ? { reworkSkipped } : {}), ...(observationSkipped.length ? { observationSkipped } : {}) };
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
export async function updateRequest(ctx: P3Context, rid: string, input: Partial<Request>, opts: WriteOpts = {}): Promise<RequestResult> {
  // 確認事項への回答は操作（saveClarifyAnswer）でだけ変える（値をそのまま書く道は持たない）
  const patch = withoutManaged(input, REQUEST_FIELD_GROUPS);
  checkMilestone(ctx, patch.milestone);
  await checkStatusChange(ctx.ws, rid, patch.status);
  // 書く直前に読み直した値（観測のシステムの項目は、この値と書いた後の値で状態の変化を見る）
  let before: Request | undefined;
  // 状態か親が変わったら、未完了になった配下の分だけ祖先を戻す
  const after = async (r: Request) => (patch.status !== undefined || "parent" in patch ? withAncestors(r, await afterRequestWrite(ctx, r.id, opts.actor)) : r);
  const write = () =>
    ctx.ws.requests.update(
      rid,
      (fresh) => {
        before = fresh;
        return patch;
      },
      opts,
    );
  const skipped = async (r: RequestResult): Promise<RequestResult> => {
    const observationSkipped = before ? await observeRequest(ctx, before, r, opts.actor) : [];
    return observationSkipped.length ? { ...r, observationSkipped } : r;
  };
  if (!("parent" in patch)) {
    const r = await write();
    changed(ctx, "request", r.id);
    return after(await skipped(r));
  }
  const { result: r, previous } = await withParentChange(ctx.ws, rid, patch.parent, write);
  changed(ctx, "request", r.id);
  // 前と今の親の子の一覧も変わる
  for (const p of new Set([previous, r.parent])) if (p && p !== r.id) changed(ctx, "request", p);
  return after(await skipped(r));
}

/** 要望の回答が読めないときは変えない */
function checkRequirementReadable(r: Request) {
  if (r.requirementProblems?.length) throw new RequirementInputError(`${r.id} の確認事項への回答のファイルの値が読めないため変えられません。request.md を直してください: ${r.requirementProblems.join(" / ")}`);
}

/**
 * Preflight の確認事項に回答する（要望の clarifyAnswers に残す。過去の run と評価は書き換えない）。clarification は元の run の確認事項
 * （呼ぶ側が run から取り出す）。answer が null なら回答を消す
 */
export async function saveClarifyAnswer(
  ctx: P3Context,
  rid: string,
  runId: string,
  q: Clarification,
  input: AnswerInput | null,
  opts: WriteOpts = {},
): Promise<{ request: Request; answer?: ClarifyAnswer }> {
  let unchanged: Request | undefined;
  let saved: ClarifyAnswer | undefined;
  const r = await ctx.ws.requests
    .update(
      rid,
      (fresh) => {
        checkRequirementReadable(fresh);
        const cur = fresh.clarifyAnswers ?? [];
        if (input === null) {
          if (!cur.some((a) => a.run === runId && a.question === q.id)) throw new RequirementInputError(`${runId}/${q.id} への回答はありません`);
          const next = cur.filter((a) => !(a.run === runId && a.question === q.id));
          return { clarifyAnswers: next.length ? next : undefined };
        }
        saved = makeAnswer(runId, q, input, { now: new Date().toISOString(), actor: opts.actor });
        const next = putAnswer(cur, saved);
        if (answersKey(next) === answersKey(cur)) {
          saved = cur.find((a) => a.run === runId && a.question === q.id);
          unchanged = fresh;
          throw new NoChange();
        }
        return { clarifyAnswers: next };
      },
      opts,
    )
    .catch((e: unknown) => {
      if (e instanceof NoChange && unchanged) return unchanged;
      throw e;
    });
  if (r !== unchanged) changed(ctx, "request", rid);
  return { request: r, ...(saved ? { answer: saved } : {}) };
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

