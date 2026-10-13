import { sameText } from "../../shared/preflightInput.ts";

/**
 * リリースノートの本文の下書き（画面の編集欄）。lib/draft.ts と同じ考え方で、ファイルの版（version）で外の変更を見る。
 *
 *   - 編集していなければ、取り直した保存済みのノートに追従する
 *   - 編集中に外（CLI・エディタ・別の画面）で変わった・消えた・読めなくなったら、入力はそのままにして external で知らせる
 *   - 保存は編集を始めたときの版（baseVersion）で行う。外で変わっていれば競合になる（最新の版に差し替えて通さない）
 *   - 生成の結果を編集欄に入れるのは人が選んだときだけ（未保存の入力があれば、画面が置き換えてよいかを確かめる）
 */

/** 保存済みのノート（画面が見る分だけ） */
export interface SavedNote {
  body: string;
  version: string;
  updatedAt: string;
  updatedBy?: string;
}

/** サーバの今の状態（GET /api/release-notes/:mid の note と noteError） */
export interface NoteState {
  note: SavedNote | null;
  noteError: string | null;
}

export type External =
  /** 外で保存された（新しく作られたときも。baseVersion が null） */
  | { kind: "changed"; note: SavedNote }
  /** 外で消された */
  | { kind: "deleted" }
  /** ファイルが読めなくなった */
  | { kind: "invalid"; error: string };

export interface NoteDraft {
  value: string;
  /** 編集を始めたときの本文（新規なら空） */
  base: string;
  /** 編集を始めたときの版（null は新規） */
  baseVersion: string | null;
  external: External | null;
}

export const isNoteDirty = (d: NoteDraft) => !sameText(d.value, d.base);

/** サーバの状態から下書きを始める（読めないファイルは空の新規とせず、知らせを付ける） */
export function noteDraftOf(s: NoteState): NoteDraft {
  if (s.note) return { value: s.note.body, base: s.note.body, baseVersion: s.note.version, external: null };
  return { value: "", base: "", baseVersion: null, external: s.noteError ? { kind: "invalid", error: s.noteError } : null };
}

export const editNote = (d: NoteDraft, value: string): NoteDraft => ({ ...d, value });

/** 取り直したサーバの状態を取り込む */
export function syncNote(d: NoteDraft, s: NoteState): NoteDraft {
  if (!isNoteDirty(d)) {
    const next = noteDraftOf(s);
    // 変わらなければ同じもの（描き直さない）
    const same = next.baseVersion === d.baseVersion && next.value === d.value && JSON.stringify(next.external) === JSON.stringify(d.external);
    return same ? d : next;
  }
  if (s.note) {
    if (s.note.version === d.baseVersion) return d.external ? { ...d, external: null } : d;
    return { ...d, external: { kind: "changed", note: s.note } };
  }
  if (s.noteError) return { ...d, external: { kind: "invalid", error: s.noteError } };
  return d.baseVersion !== null ? { ...d, external: { kind: "deleted" } } : d.external ? { ...d, external: null } : d;
}

/** 保存の引数。版は編集を始めたときのもの（新規なら付けない） */
export const saveArgs = (d: NoteDraft): { body: string; version?: string } => ({ body: d.value, ...(d.baseVersion !== null ? { version: d.baseVersion } : {}) });

/** 保存できたら、その版から編集し直す */
export const savedNote = (note: SavedNote): NoteDraft => noteDraftOf({ note, noteError: null });

/** 保存が競合した（409）。入力は残し、今のノートを知らせる（無ければ読めない・消えた） */
export function conflicted(d: NoteDraft, current: SavedNote | null): NoteDraft {
  return { ...d, external: current ? { kind: "changed", note: current } : { kind: "deleted" } };
}

/** 消えたノートを、今の入力で新しく作り直す（人が選んだとき） */
export const asNew = (d: NoteDraft): NoteDraft => ({ value: d.value, base: "", baseVersion: null, external: null });

/** 入力を捨てて、サーバの今の状態にする */
export const discardNote = (s: NoteState): NoteDraft => noteDraftOf(s);

/** 生成の結果を編集欄に入れる（置き換えてよいかは呼ぶ側が確かめる。版は変えない） */
export const applyGenerated = (d: NoteDraft, markdown: string): NoteDraft => ({ ...d, value: markdown });

/** 生成の結果で置き換える前に確かめるか（未保存の入力があるとき） */
export const confirmBeforeReplace = (d: NoteDraft) => isNoteDirty(d) && d.value.trim() !== "";
