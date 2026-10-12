/**
 * 入力欄の下書き（要望のタイトル・タグ、タスク詳細）。データを取り直しても、編集中の入力は上書きしない。
 *
 *   - 編集していなければ（value が base と同じ）取り直した値に追従する
 *   - 編集中に外で変わったら（rev が違う）入力はそのままにし、external に最新を持って知らせる
 *   - 保存は編集を始めたときの rev（baseRev）で行う。外で変わっていれば競合になる（最新の rev に差し替えて通さない）
 *   - 古い応答（baseRev より古い rev）は無視する
 */
export interface Draft<V> {
  value: V;
  /** 編集を始めたときのサーバの値 */
  base: V;
  baseRev: number;
  /** 編集中に外で変わった最新の値 */
  external: { value: V; rev: number } | null;
}

export type Eq<V> = (a: V, b: V) => boolean;

export const draftOf = <V>(value: V, rev: number): Draft<V> => ({ value, base: value, baseRev: rev, external: null });

export const isDirty = <V>(d: Draft<V>, eq: Eq<V> = Object.is) => !eq(d.value, d.base);

export const editDraft = <V>(d: Draft<V>, value: V): Draft<V> => ({ ...d, value });

/** 取り直したサーバの値を取り込む */
export function syncDraft<V>(d: Draft<V>, value: V, rev: number, eq: Eq<V> = Object.is): Draft<V> {
  if (rev < d.baseRev) return d;
  if (!isDirty(d, eq)) return rev === d.baseRev && eq(value, d.base) ? d : draftOf(value, rev);
  if (rev === d.baseRev) return d;
  if (d.external && d.external.rev === rev) return d;
  return { ...d, external: { value, rev } };
}

/** 入力を捨てて、知っている最新の値に戻す */
export const discardDraft = <V>(d: Draft<V>): Draft<V> => (d.external ? draftOf(d.external.value, d.external.rev) : draftOf(d.base, d.baseRev));

/** 平らなオブジェクトの比較（タスク詳細の下書き） */
export const shallowEqual = <V extends object>(a: V, b: V) =>
  Object.keys({ ...a, ...b }).every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
