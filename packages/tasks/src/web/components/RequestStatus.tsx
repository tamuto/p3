import type { RequestStatus } from "../../shared/types.ts";
import { cx } from "@infodb/p3-shared/web/ui.tsx";

/** 要望のステータス。並べたときに位置がそろうよう、すべて3文字 */
const STATUS: Record<RequestStatus, { label: string; tone: string; hint: string }> = {
  draft: { label: "下書き", tone: "bg-surface-2 text-fg-3", hint: "Preflight 前" },
  preflight: { label: "評価中", tone: "bg-special-soft text-special", hint: "Preflight を実行中" },
  reviewed: { label: "開始前", tone: "bg-warn-soft text-warn-strong", hint: "評価が済み、タスク化の前" },
  active: { label: "進行中", tone: "bg-accent-soft text-accent", hint: "タスク化して作業中" },
  resolved: { label: "対応済", tone: "bg-info-soft text-info ring-1 ring-inset ring-info-line", hint: "作業は全部終わり、人の確認待ち（確認したら完了済にする）" },
  done: { label: "完了済", tone: "bg-ok-soft text-ok", hint: "要望が完了" },
  rejected: { label: "見送り", tone: "bg-danger-soft text-danger", hint: "やらないことにした" },
};

export const REQUEST_STATUS_LABEL = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])) as Record<RequestStatus, string>;

/** 要望のステータス（固定幅。一覧でタイトルの開始位置がそろう） */
export function RequestStatusBadge({ status, size = "md" }: { status: RequestStatus; size?: "sm" | "md" }) {
  const s = STATUS[status];
  return (
    <span data-aux title={s.hint} className={cx("inline-flex shrink-0 justify-center rounded", size === "sm" ? "w-11 text-sm leading-4" : "w-14 py-0.5 text-base", s.tone)}>
      {s.label}
    </span>
  );
}
