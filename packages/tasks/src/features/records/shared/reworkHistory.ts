import type { Task } from "../../../shared/types.ts";

/**
 * タスクの手戻りの履歴（完了からの再開）の規則。CLI・API・画面で同じものを使う（保存は core/requestOps.ts の updateTask）。
 *
 *   - タスクの reworkHistory に追記だけで持つ。状態と同じ更新（同じ rev）で書く。書く直前に読み直した値と、実際に保存する値（状態）を比べて決める
 *   - 足すのは完了から戻したとき（cause: reopen）だけ。以前の版の済みの解除の契機（explicit・acceptance）と済み（checked）は読めるが、新しくは足さない
 *   - 同じ値の再保存・成果物の追記では足さない。再完了でも以前の履歴は消さない
 *   - 主体（by）は保存した変更者（申告。ai:claude / human:<名前>）。ファイルの直接編集からは作らず、過去の分は推し量らない
 *   - 直接編集で壊れた履歴は黙って消さず reworkProblems にし、関係のない更新ではファイルの元の値のまま書き戻す（keepRaw）。壊れている間は
 *     新しい履歴を足さない（状態は変え、足せなかったことを知らせる）
 */

export const REWORK_CAUSES = ["explicit", "acceptance", "reopen"] as const;
export type ReworkCause = (typeof REWORK_CAUSES)[number];

export const REWORK_CAUSE_LABEL: Record<ReworkCause, string> = {
  explicit: "済みを外した",
  acceptance: "基準・証拠の変更で済みが外れた",
  reopen: "完了から戻した",
};

/** 前後の状態（checked は以前の版の済み。読むだけ） */
export interface ReworkState {
  status: Task["status"];
  checked?: boolean;
}

export interface ReworkEntry {
  /** タスクの中で安定した ID（R1, R2, ...。消さないので使い直さない） */
  id: string;
  at: string;
  /** 保存した主体（申告） */
  by?: string;
  /** 書いた後の rev */
  rev: number;
  cause: ReworkCause;
  /** 以前の版の、済みが外れたか（読むだけ） */
  unchecked?: boolean;
  /** 完了から戻したか */
  reopened: boolean;
  from: ReworkState;
  to: ReworkState;
}

export const REWORK_KEYS = ["reworkHistory"] as const;
export const REWORK_ID_RE = /^R\d+$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : str(v));
const isStatus = (v: unknown): v is Task["status"] => v === "todo" || v === "doing" || v === "done";
const isCause = (v: unknown): v is ReworkCause => typeof v === "string" && (REWORK_CAUSES as readonly string[]).includes(v);

function readState(v: unknown): ReworkState | undefined {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  if (!o || !isStatus(o.status)) return undefined;
  return { status: o.status, ...(typeof o.checked === "boolean" ? { checked: o.checked } : {}) };
}

/** frontmatter の reworkHistory を読む（無ければ何も足さない。古いタスクは移行しない） */
export function readRework(d: Record<string, unknown>): { reworkHistory?: ReworkEntry[]; reworkProblems?: string[] } {
  if (d.reworkHistory === undefined || d.reworkHistory === null) return {};
  if (!Array.isArray(d.reworkHistory)) return { reworkProblems: ["reworkHistory が並びになっていません"] };
  const list: ReworkEntry[] = [];
  const problems: string[] = [];
  for (const [i, raw] of (d.reworkHistory as unknown[]).entries()) {
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const id = str(o.id) ?? "";
    const at = `手戻りの履歴 ${i + 1} 件目${id ? `（${id}）` : ""}`;
    const from = readState(o.from);
    const to = readState(o.to);
    if (!REWORK_ID_RE.test(id)) problems.push(`${at} の id が読めません（R1, R2, ...）`);
    else if (list.some((x) => x.id === id)) problems.push(`手戻りの履歴の id が重複しています: ${id}`);
    else if (!iso(o.at) || !Number.isInteger(o.rev) || !isCause(o.cause) || typeof o.reopened !== "boolean" || !from || !to)
      problems.push(`${at} が読めません（at・rev・cause・reopened・from・to が要ります）`);
    else list.push({ id, at: iso(o.at)!, ...(str(o.by) ? { by: str(o.by) } : {}), rev: o.rev as number, cause: o.cause, ...(typeof o.unchecked === "boolean" ? { unchecked: o.unchecked } : {}), reopened: o.reopened, from, to });
  }
  return { ...(list.length ? { reworkHistory: list } : {}), ...(problems.length ? { reworkProblems: problems } : {}) };
}

/** 書く直前（prev）と保存する値（next）から、足す履歴を決める（完了から戻したときだけ。無ければ undefined） */
export function reworkOf(prev: Pick<Task, "status">, next: Pick<Task, "status">): Pick<ReworkEntry, "cause" | "reopened" | "from" | "to"> | undefined {
  if (prev.status !== "done" || next.status === "done") return undefined;
  return { cause: "reopen", reopened: true, from: { status: prev.status }, to: { status: next.status } };
}

/** 履歴を足した値（壊れた履歴があれば足さずに undefined） */
export function appendRework(cur: Pick<Task, "reworkHistory" | "reworkProblems">, entry: Omit<ReworkEntry, "id">): ReworkEntry[] | undefined {
  if (cur.reworkProblems?.length) return undefined;
  const list = cur.reworkHistory ?? [];
  const n = Math.max(0, ...list.map((e) => Number(e.id.slice(1)))) + 1;
  return [...list, { id: `R${n}`, ...entry }];
}

/** 一行の説明（CLI・画面） */
export function reworkLine(e: ReworkEntry): string {
  const what = [e.reopened ? "完了から戻した" : "", e.unchecked ? REWORK_CAUSE_LABEL[e.cause === "acceptance" ? "acceptance" : "explicit"] : ""].filter(Boolean).join("・");
  return `${e.id}  ${what}（${e.from.status} → ${e.to.status}）`;
}

/** 壊れた履歴のため足せなかったときの知らせ */
export const REWORK_SKIPPED = "手戻りの履歴が読めないため、今回の履歴は残していません（状態は変えました）。ファイルの reworkHistory を直してください";
