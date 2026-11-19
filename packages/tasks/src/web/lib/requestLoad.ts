/**
 * 開いている要望を取り直した結果をどう扱うか（RequestDataProvider）。
 *
 *   - 取れた → その値。消えた・失敗の印は消す
 *   - 見つからない（404）→ 一度も表示していなければ「見つかりません」。表示中なら前の値を残して gone にする
 *     （外で削除・アーカイブされても、入力中のメモや下書きを画面ごと消さない。保存は止める）
 *   - それ以外の失敗（通信など）→ 前の値を残して error にする（削除とはみなさない。取り直せる）
 */
export interface LoadState<D> {
  /** undefined: まだ取れていない / null: 見つからない（表示したことがない） */
  data: D | null | undefined;
  gone: boolean;
  error: string | null;
}

export type LoadResult<D> = { ok: true; data: D } | { ok: false; status?: number; message: string };

export const initialLoad = <D>(): LoadState<D> => ({ data: undefined, gone: false, error: null });

export function applyLoad<D>(prev: LoadState<D>, r: LoadResult<D>): LoadState<D> {
  if (r.ok) return { data: r.data, gone: false, error: null };
  if (r.status === 404) return prev.data ? { data: prev.data, gone: true, error: null } : { data: null, gone: false, error: null };
  return { ...prev, error: r.message || "読み込めませんでした" };
}
