import type { PreflightRun } from "./types.ts";

/**
 * Preflight を通さずにタスクを直接作る道（画面の「＋ タスクを追加」・CLI の p3 new）の案内。
 * 小さく内容のはっきりした要望ではふつうに選べる道で、Docker や ChatGPT の接続が無くて Preflight を使えないときにも案内する。
 */

/** 直接作るタスクに付かないもの（画面と CLI で同じ言い方にする） */
export const DIRECT_TASK_NOTE =
  "Preflight の評価・細分化・根拠の調査・画面イメージは付きません。必要な調査と完了条件を自分で整理して作成してください。";

/** 後から Preflight を使えるようになったとき（既にあるタスクとの関係） */
export const LATER_PREFLIGHT_NOTE =
  "後から Preflight を使えるようになったら、この要望に実行できます。実行しても既にあるタスクは変わらず、案をタスク化すると新しいタスクが増えるので、重複を確かめて採否を選んでください。";

/** 取り消した Preflight の記録のエラー（失敗とは扱わない） */
export const PREFLIGHT_CANCELLED = "中止しました";

/** Preflight が失敗した（取消は含まない）。直接作る道を案内する */
export const preflightFailed = (run: Pick<PreflightRun, "status" | "error">) => run.status === "failed" && run.error !== PREFLIGHT_CANCELLED;
