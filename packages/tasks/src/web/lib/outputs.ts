/**
 * タスクの成果物（outputs: string[]）。1項目は URL・文章・パスのどれでもよく、混ぜてよい。
 *
 *   - 1項目の全体（前後の空白を除いて）が絶対の http / https の URL ならリンクにする。それ以外は文章として出す
 *   - 文章の中の URL は拾わない。Markdown も解釈しない。javascript: / data: / file: などはリンクにしない
 *   - 保存する値は変えない（前後の空白を除くのはリンクにするかを決めるときだけ）
 */
export function outputHref(item: string): string | null {
  const t = item.trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return null;
  try {
    const u = new URL(t);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** リンクの見せ方（スキームと www. を省く） */
export const outputLabel = (href: string) => href.replace(/^https?:\/\/(www\.)?/i, "");
