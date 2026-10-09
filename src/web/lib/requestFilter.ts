import type { RequestStatus } from "../../shared/types.ts";

/**
 * 進捗の一覧の絞り込み（URL の ?show=）。
 *   open（既定）: 完了済・見送り以外。対応済（人の確認待ち）も含める
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
  return (show === "closed") === CLOSED_STATUSES.has(status);
}
