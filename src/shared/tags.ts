/**
 * 要望のタグ（外部 ID・分類。例: jira:PROJ-123、group:顧客A）。README の「タグ（外部 ID・分類）」。
 *
 *   - 新しく入れる値は前後の空白を除く。空は付けない。完全に同じ値（大小文字も）は1つにまとめる
 *   - 値の中のカンマ・空白・記号・日本語はそのまま（分けない・変えない）
 *   - 既にある値は正規化しない（並びも値もそのまま。足す・外すときも他の値には触らない）
 */

/** 新しく入れる値。空なら null */
export function cleanTag(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

/** 値を1つ足す。空・既にある値なら元のまま（同じ配列）を返す */
export function addTag(tags: readonly string[], v: string): readonly string[] {
  const t = cleanTag(v);
  return t === null || tags.includes(t) ? tags : [...tags, t];
}

/** 値を1つ外す（完全一致） */
export const removeTag = (tags: readonly string[], v: string): string[] => tags.filter((t) => t !== v);

/** CLI の --tag の並び（新しく入れる値）をタグにする */
export const tagsFrom = (values: readonly string[]): string[] => [...values.reduce<readonly string[]>(addTag, [])];

export const sameTags = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);
