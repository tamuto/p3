import type { PreflightNote, PreflightRun } from "../../shared/types.ts";
import { ApiError, type NotesInfo, type api as Api } from "./api.ts";

/** 次の Preflight が何を引き継ぐか（実行する前に見せる） */
export function nextRunLabel(info: Pick<NotesInfo, "notes" | "previous" | "previousSkipped">): string {
  const pending = info.notes.filter((n) => n.pending).length;
  const prev = info.previous
    ? `前回 ${info.previous} の結果を引き継ぎます`
    : info.previousSkipped
      ? `前回の結果は引き継ぎません（${info.previousSkipped}）`
      : "最初の評価です";
  return `次の Preflight: ${prev}。メモ ${pending} 件を渡します。`;
}

export type SubmitResult =
  | { kind: "saved"; note: PreflightNote }
  | { kind: "started"; run: PreflightRun }
  /** メモは保存したが実行を始められなかった。再試行はメモを書き直さず Preflight だけ */
  | { kind: "not-started"; note: PreflightNote; error: string };

/** メモを保存する（run: 続けて Preflight を実行する）。空のメモは送らない */
export async function submitNote(
  client: Pick<typeof Api, "addNote" | "startPreflight">,
  rid: string,
  body: string,
  run: boolean,
): Promise<SubmitResult> {
  const text = body.trim();
  if (!text) throw new Error("メモが空です");
  if (!run) return { kind: "saved", note: await client.addNote(rid, text) };
  try {
    return { kind: "started", run: await client.startPreflight(rid, { note: text }) };
  } catch (e) {
    const note = e instanceof ApiError ? (e.body as { note?: PreflightNote }).note : undefined;
    if (note) return { kind: "not-started", note, error: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/** メモ欄の表示と操作を決める材料 */
export interface NotesPanelInput {
  /** この要望で Preflight を実行したことがある（開始した直後も含む） */
  hasHistory: boolean;
  /** 表示中の run が実行中 */
  running: boolean;
  /** 評価エンジンが使える */
  engineOk: boolean;
  /** 入力中（未保存）のメモ */
  draft: string;
  /** 保存・開始の途中 */
  busy: boolean;
  /** 次の Preflight に渡す保存済みのメモの数 */
  pending: number;
}

export interface NotesPanelState {
  /** intro: まだ一度も実行していない（入力欄は出さず、本文に書くよう案内する）/ input: 入力欄を出す */
  mode: "intro" | "input";
  canSaveAndRun: boolean;
  canSaveOnly: boolean;
  /** 上の通常の実行ボタンを止める（未保存の入力が渡らないまま実行されるのを防ぐ） */
  blockPlainRun: boolean;
  /** メモ欄に添える説明 */
  hint?: string;
}

/**
 * メモは「評価の結果を見て、確認事項への回答や方針の変更を次の評価に渡す」ための欄。
 *   - 一度も実行していなければ入力欄は出さない（最初の条件は要望の本文に書く）。CLI などで保存済みのメモがあれば見せる
 *   - 入力中のメモがある間は、上の通常の実行を止める（「保存して再実行」か、入力を消す）
 *   - 実行中でも保存はできる（実行中の評価ではなく次の Preflight に渡る）。エンジンが使えなくても保存はできる
 */
export function notesPanelState(i: NotesPanelInput): NotesPanelState {
  if (!i.hasHistory) {
    return {
      mode: "intro",
      canSaveAndRun: false,
      canSaveOnly: false,
      blockPlainRun: false,
      hint:
        i.pending > 0
          ? `保存済みのメモ ${i.pending} 件を、最初の Preflight に渡します。`
          : "最初の Preflight の条件や背景は、要望の本文に書いてください。メモは、評価の結果を見てから確認事項への回答や方針の変更を書く欄です。",
    };
  }
  const hasDraft = i.draft.trim() !== "";
  return {
    mode: "input",
    canSaveAndRun: hasDraft && !i.busy && !i.running && i.engineOk,
    canSaveOnly: hasDraft && !i.busy,
    blockPlainRun: hasDraft,
    hint: i.running
      ? "実行中です。ここで保存したメモは、実行中の評価ではなく次の Preflight に渡ります。"
      : !i.engineOk
        ? "評価エンジンが使えないため、メモの保存だけできます。"
        : undefined,
  };
}

/** 上の実行ボタンの近くに出す、止めている理由 */
export const PLAIN_RUN_BLOCKED = "入力中のメモがあります。メモ欄の「保存して再実行」を使うか、入力を消してください。";
