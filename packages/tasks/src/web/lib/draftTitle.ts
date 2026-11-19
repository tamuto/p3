/**
 * タスク案のカードの題の下書き。案には rev が無いので、題の値そのもので比べる（lib/draft.ts の考え方を題に合わせたもの）。
 *
 *   - 編集していなければ（value が base と同じ）取り直した題に追従する（フォーカス中でも同じ）
 *   - 編集中に外で題が変わったら入力は残し、external に外の最新を持って知らせる。そのあいだは保存しない
 *   - 保存は編集を始めたときの題（base）を期待値にして送る（サーバが今の題と比べ、違えば 409）
 *   - 保存中に打ち足した入力は、成功の応答で消さない
 *
 * 下書きは 要望 / run / 案のキー の組（titleKey）で持つ。同じキーでも別の run の入力・応答は混ぜない
 */
export interface TitleDraft {
  value: string;
  /** 編集を始めたときの題（保存の期待値） */
  base: string;
  /** 編集中に外で変わった最新の題 */
  external: string | null;
  /** 保存中の題（送った値） */
  saving: string | null;
  error: string | null;
}

export const titleKey = (requestId: string, runId: string, key: string) => `${requestId}/${runId}/${key}`;

export const titleDraftOf = (title: string): TitleDraft => ({ value: title, base: title, external: null, saving: null, error: null });

export const titleDirty = (d: TitleDraft) => d.value !== d.base;

/** 保存してよいか（変えていて、外の変更が無く、保存中でない） */
export const canSaveTitle = (d: TitleDraft) => titleDirty(d) && d.external === null && d.saving === null;

/** タスク化を止めるべきか（未保存・保存中・競合中） */
export const titlePending = (d: TitleDraft | undefined) => !!d && (titleDirty(d) || d.saving !== null || d.external !== null);

export const editTitle = (d: TitleDraft, value: string): TitleDraft => ({ ...d, value, error: null });

/** 取り直した題を取り込む */
export function syncTitle(d: TitleDraft, server: string): TitleDraft {
  // 保存中は応答で決める（自分の保存が先に取り直しに出ても競合にしない）
  if (d.saving !== null) return d;
  if (!titleDirty(d)) return server === d.base ? d : titleDraftOf(server);
  if (server === d.value) return { ...titleDraftOf(server) }; // 外でも同じ題にした
  if (server === d.base) return d.external === null ? d : { ...d, external: null };
  return d.external === server ? d : { ...d, external: server };
}

/** 入力を捨てて、知っている最新の題に戻す */
export const discardTitle = (d: TitleDraft): TitleDraft => titleDraftOf(d.external ?? d.base);

/** 保存を始める（送る値を saving に） */
export const startTitleSave = (d: TitleDraft): TitleDraft => ({ ...d, saving: d.value, error: null });

/** 保存できた。保存した題を基準にし、保存中に打ち足した入力は残す */
export const titleSaved = (d: TitleDraft, saved: string): TitleDraft => ({ ...d, base: saved, saving: null, external: null, error: null });

/** 保存できなかった。入力は残す。current: 409 のときの今の題（外で変わった） */
export function titleSaveFailed(d: TitleDraft, message: string, current?: string): TitleDraft {
  const next = { ...d, saving: null, error: message };
  if (current === undefined) return next;
  if (current === d.value) return titleDraftOf(current);
  return { ...next, external: current === d.base ? null : current };
}
