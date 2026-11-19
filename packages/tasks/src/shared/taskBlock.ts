import type { Task, TaskStatus } from "./types.ts";

/**
 * 作業中のタスクの「止まっている理由」（停止）の規則。状態ではなく作業中のタスクの属性で、状態は 未着手 / 作業中 / 完了 のまま。
 * CLI・API・画面で同じものを使う（保存は core/requestOps.ts の updateTask がこれで確かめる）。
 *
 *   - 今の値 block: { reason, decision?, since, updatedAt, updatedBy? }。reason は何で止まったか（空白だけは不可）、decision は人に
 *     決めてほしいこと（任意）。since は止まった時刻で、内容を直しても変えない。時刻は P3 が付ける
 *   - 履歴 blockHistory: [{ action: set | update | clear, at, by?, before?, after?, resolution? }] を追記する（直接上書きする入力の道は無い）。
 *     before / after はその時の今の値の写し。解除（clear）には回答・解決の内容（resolution）が要る
 *   - 付けるのと内容を直すのは作業中（doing）のタスクだけ。同じ内容の付け直し・付いていない解除は何もしない（履歴を増やさない）
 *   - 止まったまま未着手・完了へは動かさない（解除と移動を同じ更新で指定すれば、確かめてから一緒に保存する）。解除は状態・日時・
 *     済み・要望の状態を変えない（自動では再開しない）
 *   - 直接編集で読めない値は黙って消さず、problems として知らせる（操作は断り、関係のない更新ではファイルの元の値を書き戻す）。
 *     作業中でないのに停止が付いているのは読める値なので、解除で直せる（警告だけ）
 *   - 同じ OS の権限でファイルを直接書き換えることは防がない。完全な監査ログではない
 */

export const BLOCK_LIMITS = {
  reason: 2000,
  decision: 2000,
  resolution: 4000,
} as const;

/** 停止の今の値 */
export interface TaskBlock {
  /** 何で止まったか */
  reason: string;
  /** 人に決めてほしいこと（任意） */
  decision?: string;
  /** 止まった時刻（内容を直しても変えない） */
  since: string;
  updatedAt: string;
  updatedBy?: string;
}

/** 履歴に写す今の値（時刻・変更者は履歴の側に持つ） */
export type BlockSnapshot = Pick<TaskBlock, "reason" | "decision" | "since">;

export interface BlockHistoryEntry {
  action: "set" | "update" | "clear";
  at: string;
  by?: string;
  before?: BlockSnapshot;
  after?: BlockSnapshot;
  /** 解除の回答・解決の内容 */
  resolution?: string;
}

/** 停止の操作（CLI の block / unblock、API の PATCH の blockOp） */
export type BlockOp = { op: "set"; reason: string; decision?: string } | { op: "clear"; resolution: string };

export type BlockState = Pick<Task, "block" | "blockHistory">;

/** ファイルに書く停止の項目（壊れていたら元の値のまま書き戻す） */
export const BLOCK_KEYS = ["block", "blockHistory"] as const;

/** 入力が規則に合わない・状態と合わない（何も書いていない）。CLI は使い方の誤り、API は 400 */
export class BlockInputError extends Error {
  constructor(
    readonly code: "block_invalid" | "block_not_doing" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

// --- 読む ---------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : undefined);

function snapshotOf(v: unknown): BlockSnapshot | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const reason = str(o.reason)?.trim();
  const since = iso(o.since);
  if (!reason || !since) return undefined;
  const decision = str(o.decision)?.trim();
  return { reason, ...(decision ? { decision } : {}), since };
}

/** frontmatter の値を読む。読めない値は除いて problems に理由を足す（どちらも無ければ何も足さない） */
export function readBlock(d: Record<string, unknown>): BlockState & { blockProblems?: string[] } {
  const problems: string[] = [];
  const out: BlockState & { blockProblems?: string[] } = {};
  if (d.block !== undefined && d.block !== null) {
    const o = typeof d.block === "object" ? (d.block as Record<string, unknown>) : undefined;
    const snap = snapshotOf(d.block);
    if (!o || !snap) problems.push("block が読めません（reason と since が要ります）");
    else {
      const updatedAt = iso(o.updatedAt) ?? snap.since;
      out.block = { ...snap, updatedAt, ...(str(o.updatedBy) ? { updatedBy: str(o.updatedBy) } : {}) };
    }
  }
  if (d.blockHistory !== undefined && d.blockHistory !== null) {
    if (!Array.isArray(d.blockHistory)) problems.push("blockHistory が並びになっていません");
    else {
      const list: BlockHistoryEntry[] = [];
      for (const [i, raw] of (d.blockHistory as unknown[]).entries()) {
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const action = o.action;
        const at = iso(o.at);
        if ((action !== "set" && action !== "update" && action !== "clear") || !at) {
          problems.push(`blockHistory の ${i + 1} 件目が読めません（action と at が要ります）`);
          continue;
        }
        const before = snapshotOf(o.before);
        const after = snapshotOf(o.after);
        const resolution = str(o.resolution)?.trim();
        list.push({ action, at, ...(str(o.by) ? { by: str(o.by) } : {}), ...(before ? { before } : {}), ...(after ? { after } : {}), ...(resolution ? { resolution } : {}) });
      }
      out.blockHistory = list;
    }
  }
  if (problems.length) out.blockProblems = problems;
  return out;
}

// --- 変える -------------------------------------------------------------------

function clean(raw: string | undefined, label: string, max: number, required: boolean): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) {
    if (required) throw new BlockInputError("block_invalid", `${label}を書いてください（空白だけは不可）`);
    return undefined;
  }
  if (t.length > max) throw new BlockInputError("block_invalid", `${label}は ${max} 文字までです（${t.length} 文字）`);
  return t;
}

const snap = (b: TaskBlock): BlockSnapshot => ({ reason: b.reason, ...(b.decision ? { decision: b.decision } : {}), since: b.since });

/**
 * 操作を当てた後の停止の値（何も書かない。規則に合わなければ BlockInputError）。status: 更新した後のタスクの状態。
 * 変わらなければ undefined（同じ内容の付け直し・付いていない解除）
 */
export function applyBlockOp(state: BlockState & { blockProblems?: string[] }, op: BlockOp, at: { now: string; actor?: string; status: TaskStatus }): BlockState | undefined {
  if (state.blockProblems?.length) {
    throw new BlockInputError("block_invalid", `停止の値がファイルで読めないため変えられません。タスクのファイルの block / blockHistory を直してください: ${state.blockProblems.join(" / ")}`);
  }
  const history = state.blockHistory ?? [];
  const by = at.actor ? { by: at.actor } : {};
  if (op.op === "set") {
    const reason = clean(op.reason, "止まっている理由", BLOCK_LIMITS.reason, true)!;
    const decision = clean(op.decision, "決めてほしいこと", BLOCK_LIMITS.decision, false);
    if (at.status !== "doing") throw new BlockInputError("block_not_doing", `停止は作業中のタスクだけに付けられます（今は ${at.status}）`);
    const cur = state.block;
    if (cur && cur.reason === reason && (cur.decision ?? undefined) === decision) return undefined;
    const block: TaskBlock = { reason, ...(decision ? { decision } : {}), since: cur?.since ?? at.now, updatedAt: at.now, ...(at.actor ? { updatedBy: at.actor } : {}) };
    const entry: BlockHistoryEntry = cur ? { action: "update", at: at.now, ...by, before: snap(cur), after: snap(block) } : { action: "set", at: at.now, ...by, after: snap(block) };
    return { block, blockHistory: [...history, entry] };
  }
  if (op.op === "clear") {
    const resolution = clean(op.resolution, "回答・解決の内容", BLOCK_LIMITS.resolution, true)!;
    if (!state.block) return undefined;
    return { block: undefined, blockHistory: [...history, { action: "clear", at: at.now, ...by, before: snap(state.block), resolution }] };
  }
  throw new BlockInputError("block_invalid", `知らない操作です: ${String((op as { op: unknown }).op)}`);
}

/**
 * 止まったままの状態の移動を断る（前と後の状態・更新した後の停止の値で）。既に作業中でないのに停止が付いている（直接編集）タスクの
 * 関係のない更新は断らない（警告だけ。解除で直す）
 */
export function checkBlockedStatus(before: TaskStatus, status: TaskStatus, block: TaskBlock | undefined, ref: string): void {
  if (block && status !== "doing" && status !== before) {
    throw new BlockInputError("blocked", `${ref} は止まっています（${block.reason}）。未着手・完了へ動かす前に、回答・解決の内容を添えて解除してください（p3 unblock ${ref} --resolution "..."）`);
  }
}

/** 読み取りの注意（読めない値・作業中でないのに停止が付いている） */
export function blockWarnings(t: Pick<Task, "status" | "block" | "blockProblems">): string[] {
  return [
    ...(t.blockProblems ?? []).map((p) => `停止の値が読めません: ${p}`),
    ...(t.block && t.status !== "doing" ? [`作業中でないのに停止が付いています（${t.status}）。解除して直してください`] : []),
  ];
}
