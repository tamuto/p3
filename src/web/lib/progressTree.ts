import type { Request, RequestProgress } from "../../shared/types.ts";

/**
 * 進捗の親子の木（routes/index.tsx）と、親を選ぶ欄の候補。木の形は要望の parent から作る（サーバの progress は平らな一覧）。
 *   - 絞り込みに合う要望（matched）を数え、その祖先は位置を示す文脈（context）として出すが、数えない
 *   - 親が一覧に無い（孤児・アーカイブ・絞り込みの外でも文脈で出す）・循環している要望は根に出す（訪れた ID を覚えて止まる）
 *   - 畳んだ親（collapsed）の子孫は出さない
 */
export interface TreeRow {
  p: RequestProgress;
  depth: number;
  /** 絞り込みに合わないが、合う子孫の位置を示すために出す祖先（件数に数えない） */
  context: boolean;
  /** 出している子があるか（畳む・開くの印を出す） */
  hasChildren: boolean;
  collapsed: boolean;
}

export function progressTree(all: readonly RequestProgress[], matched: readonly RequestProgress[], collapsed: ReadonlySet<string>): TreeRow[] {
  const byId = new Map(all.map((p) => [p.request.id, p]));
  const hit = new Set(matched.map((p) => p.request.id));
  // 出す要望: 合うものと、その祖先（循環しても止まる）
  const shown = new Map<string, RequestProgress>();
  for (const p of matched) {
    shown.set(p.request.id, p);
    const seen = new Set([p.request.id]);
    for (let cur = p.request.parent; cur && !seen.has(cur); cur = byId.get(cur)?.request.parent) {
      seen.add(cur);
      const a = byId.get(cur);
      if (!a) break;
      shown.set(cur, a);
    }
  }
  // 並び: 合うものは渡された順、文脈の祖先は最初に出てくる子孫の位置
  const rank = new Map<string, number>();
  matched.forEach((p, i) => rank.set(p.request.id, i));
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    // 循環で戻ってきても止まるよう、先に仮の値を入れる
    rank.set(id, Number.MAX_SAFE_INTEGER);
    const kids = [...shown.values()].filter((x) => x.request.parent === id).map((x) => rankOf(x.request.id));
    const r = kids.length ? Math.min(...kids) : Number.MAX_SAFE_INTEGER;
    rank.set(id, r);
    return r;
  };
  for (const id of shown.keys()) rankOf(id);
  const order = [...shown.values()].sort((a, b) => rank.get(a.request.id)! - rank.get(b.request.id)!);
  const kidsOf = new Map<string, RequestProgress[]>();
  const roots: RequestProgress[] = [];
  for (const p of order) {
    const parent = p.request.parent;
    if (parent && shown.has(parent) && !inCycle(byId, p.request.id)) (kidsOf.get(parent) ?? kidsOf.set(parent, []).get(parent)!).push(p);
    else roots.push(p);
  }
  const out: TreeRow[] = [];
  const visited = new Set<string>();
  const walk = (p: RequestProgress, depth: number) => {
    if (visited.has(p.request.id)) return;
    visited.add(p.request.id);
    const kids = kidsOf.get(p.request.id) ?? [];
    const folded = collapsed.has(p.request.id);
    out.push({ p, depth, context: !hit.has(p.request.id), hasChildren: kids.length > 0, collapsed: folded });
    if (!folded) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** 親を辿ると自分に戻る */
function inCycle(byId: Map<string, RequestProgress>, id: string): boolean {
  const seen = new Set<string>();
  for (let cur = byId.get(id)?.request.parent; cur && !seen.has(cur); cur = byId.get(cur)?.request.parent) {
    if (cur === id) return true;
    seen.add(cur);
  }
  return false;
}

/** 親に選べる要望（自分と自分の子孫は除く。選べるかの最後の判断はサーバ） */
export function parentChoices(all: readonly Pick<Request, "id" | "title" | "parent">[], self?: string): Pick<Request, "id" | "title">[] {
  if (!self) return [...all];
  const below = new Set<string>([self]);
  // 子孫を集める（循環しても止まる）
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of all) {
      if (r.parent && below.has(r.parent) && !below.has(r.id)) {
        below.add(r.id);
        grew = true;
      }
    }
  }
  return all.filter((r) => !below.has(r.id));
}
