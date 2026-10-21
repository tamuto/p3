/**
 * マイルストーンの表示の順: ID のバージョンの降順（新しいものが先）。CLI・API・画面のどの一覧・選ぶ欄でも使う。
 * 保存してある順（project.yaml）は変えない（表示のたびに並べる）。
 *
 *   - 比べるのは ID だけ（タイトル・期限・リリース済みかは見ない）
 *   - 先頭の v / V は比べるときだけ外す。数字の続きは数として比べる（0.10.0 > 0.9.0、v2.0 > v1.10 > v1.9）
 *   - バージョンでない ID も同じ規則で比べる（厳密な SemVer のプレリリースの順は持たない）
 *   - それでも同じなら、元の ID の文字列で決める（登録の順によらない）
 */
export function compareMilestoneIds(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const c = compareToken(ta[i], tb[i]);
    if (c) return -c;
  }
  if (ta.length !== tb.length) return tb.length - ta.length;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** ID の降順に並べた新しい配列（元の配列は変えない） */
export function sortMilestones<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((x, y) => compareMilestoneIds(x.id, y.id));
}

/** 数字の続きと、それ以外の続きに分ける（先頭の v / V は外す） */
function tokens(id: string): string[] {
  return id.replace(/^[vV]/, "").match(/\d+|\D+/g) ?? [];
}

/** 昇順の比較。数字どうしは数として（桁の多いほうが大きい。先頭の 0 は除く）、それ以外は文字列として */
function compareToken(a: string, b: string): number {
  const da = /^\d/.test(a);
  const db = /^\d/.test(b);
  if (da && db) {
    const na = a.replace(/^0+(?=\d)/, "");
    const nb = b.replace(/^0+(?=\d)/, "");
    if (na.length !== nb.length) return na.length - nb.length;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  // 数字の続きと文字の続きでは、数字を小さいとする（どちらかに決めて順を一意にする）
  if (da !== db) return da ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
