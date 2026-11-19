import type { Request, RequestStatus } from "../../shared/types.ts";

/**
 * 進捗の一覧の絞り込み（URL の ?show=）。
 *   open（既定）: まだ作業が残るもの（下書き・Preflight・レビュー済・進行中）。対応済は含めない
 *     （リリース前のものは対応済のまましばらく残るので、確認待ち・すべてで見る）
 *   resolved: 対応済だけ（確認待ちを拾う）
 *   closed: 完了済・見送り（対応済は含めない）
 *   all: すべて
 */
export type Show = "open" | "resolved" | "closed" | "all";

export const SHOW_OPTIONS: readonly (readonly [Show, string])[] = [
  ["open", "未完了"],
  ["resolved", "確認待ち（対応済）"],
  ["closed", "完了・見送り"],
  ["all", "すべて"],
];

/** 人が閉じたステータス */
export const CLOSED_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>(["done", "rejected"]);

/** URL の値 → 絞り込み。既定（open）と不正な値は undefined（URL に載せない） */
export function parseShow(v: unknown): Exclude<Show, "open"> | undefined {
  return v === "resolved" || v === "closed" || v === "all" ? v : undefined;
}

export function matchesShow(status: RequestStatus, show: Show): boolean {
  if (show === "all") return true;
  if (show === "resolved") return status === "resolved";
  if (show === "closed") return CLOSED_STATUSES.has(status);
  return status !== "resolved" && !CLOSED_STATUSES.has(status);
}

/**
 * 進捗の行の絞り込み。状態（show）と、タグ（選んだもののどれかが付いている。OR）の両方を満たすもの（AND）。
 * タグは大小文字を区別する完全一致。何も選んでいなければタグでは絞らない。show を省いたら既定（未完了）
 */
export function filterRequests<T extends { request: Pick<Request, "status" | "tags"> }>(items: readonly T[], show: Show = "open", tags: readonly string[] = []): T[] {
  return items.filter((p) => matchesShow(p.request.status, show) && (!tags.length || tags.some((t) => p.request.tags.includes(t))));
}

/**
 * URL のタグの選択。?tags= は JSON の配列（ルーターが読んだ値）。以前の ?tag=値 は1つ選んだものとして読む（tags があればそちら）。
 * 文字列でない要素・空の値は捨て、重複はまとめる。選んでいなければ undefined（URL に載せない）
 */
export function parseTagsSearch(tags: unknown, legacyTag?: unknown): string[] | undefined {
  const raw = Array.isArray(tags) ? tags : tags === undefined ? (legacyTag === undefined || legacyTag === null ? [] : [legacyTag]) : [];
  // 以前の ?tag=123 のように数に見える値は、ルーターが数として読むので文字に戻す
  const vals = raw.map((v) => (typeof v === "number" && !Array.isArray(tags) ? String(v) : v)).filter((v): v is string => typeof v === "string" && v !== "");
  const out = [...new Set(vals)];
  return out.length ? out : undefined;
}

export interface TagCandidate {
  tag: string;
  /** 付いている要望の数（状態によらない） */
  count: number;
}

/** 候補のタグ（すべての要望から。名前の順）。query は部分一致で大小文字を区別しない */
export function tagCandidates(items: readonly { request: Pick<Request, "tags"> }[], query = ""): TagCandidate[] {
  const counts = new Map<string, number>();
  for (const p of items) for (const t of new Set(p.request.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const q = query.trim().toLowerCase();
  return [...counts]
    .filter(([t]) => !q || t.toLowerCase().includes(q))
    .sort(([a], [b]) => a.localeCompare(b, "ja"))
    .map(([tag, count]) => ({ tag, count }));
}

/** 選んだタグを足す・外す（並びは選んだ順） */
export const toggleTag = (selected: readonly string[], tag: string): string[] =>
  selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag];
