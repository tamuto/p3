import { cx } from "@infodb/p3-shared/web/ui.tsx";

/**
 * スケジュールの印。完了 ○ / 済み ✓（人が確認した）/ 作業中 ◐ / 未着手 □ / 期限 ⚑
 */
export const DoneMark = ({ checked }: { checked: boolean }) =>
  checked ? (
    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-ok-solid text-[9px] leading-none font-bold text-white">✓</span>
  ) : (
    <span className="block h-3.5 w-3.5 rounded-full border-2 border-ok-solid bg-surface" />
  );
export const DoingMark = () => (
  <span className="block h-3.5 w-3.5 rounded-full border-2 border-accent-solid bg-linear-to-r from-accent-solid from-50% to-transparent to-50%" />
);
/** 作業中で止まっている（色だけに頼らず、一時停止の形にする） */
export const BlockedMark = () => (
  <span role="img" aria-label="停止中" className="flex h-3.5 w-3.5 items-center justify-center gap-[2px] rounded-full border-2 border-warn-solid bg-warn-muted">
    <span className="block h-1.5 w-[2px] bg-warn-solid" />
    <span className="block h-1.5 w-[2px] bg-warn-solid" />
  </span>
);
export const TodoMark = () => <span className="block h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-line-strong" />;
export const Flag = ({ overdue }: { overdue: boolean }) => <span className={cx("text-base leading-none", overdue ? "text-danger" : "text-fg-4")}>⚑</span>;
