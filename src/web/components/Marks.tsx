import { cx } from "./ui.tsx";

/**
 * スケジュールの印。完了 ○ / 済み ✓（人が確認した）/ 作業中 ◐ / 未着手 □ / 期限 ⚑
 */
export const DoneMark = ({ checked }: { checked: boolean }) =>
  checked ? (
    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-[9px] leading-none font-bold text-white">✓</span>
  ) : (
    <span className="block h-3.5 w-3.5 rounded-full border-2 border-emerald-500 bg-white dark:bg-slate-900" />
  );
export const DoingMark = () => (
  <span className="block h-3.5 w-3.5 rounded-full border-2 border-indigo-500" style={{ background: "linear-gradient(90deg, rgb(99 102 241) 50%, transparent 50%)" }} />
);
export const TodoMark = () => <span className="block h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-slate-400 dark:border-slate-500" />;
export const Flag = ({ overdue }: { overdue: boolean }) => <span className={cx("text-sm leading-none", overdue ? "text-rose-600" : "text-slate-500")}>⚑</span>;
