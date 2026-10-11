import type { RequestStatus } from "../../shared/types.ts";
import { cx } from "./ui.tsx";

/** 要望のステータス。並べたときに位置がそろうよう、すべて3文字 */
const STATUS: Record<RequestStatus, { label: string; tone: string; hint: string }> = {
  draft: { label: "下書き", tone: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", hint: "Preflight 前" },
  preflight: { label: "評価中", tone: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300", hint: "Preflight を実行中" },
  reviewed: { label: "開始前", tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300", hint: "評価が済み、タスク化の前" },
  active: { label: "進行中", tone: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300", hint: "タスク化して作業中" },
  resolved: { label: "対応済", tone: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800", hint: "作業は全部終わり、人の確認待ち（確認したら完了済にする）" },
  done: { label: "完了済", tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300", hint: "要望が完了" },
  rejected: { label: "見送り", tone: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300", hint: "やらないことにした" },
};

export const REQUEST_STATUS_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])) as Record<RequestStatus, string>;

/** 要望のステータス（固定幅。一覧でタイトルの開始位置がそろう） */
export function RequestStatusBadge({ status, size = "md" }: { status: RequestStatus; size?: "sm" | "md" }) {
  const s = STATUS[status];
  return (
    <span title={s.hint} className={cx("inline-flex shrink-0 justify-center rounded", size === "sm" ? "w-11 text-xs leading-4" : "w-14 py-0.5 text-sm", s.tone)}>
      {s.label}
    </span>
  );
}
