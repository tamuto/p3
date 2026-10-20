import { Link } from "@tanstack/react-router";
import { buttonCls } from "../ui.tsx";

/**
 * Preflight を使えない・失敗したときの、Preflight を通さずにタスクを作る道（タスクボードの「＋ タスクを追加」を開く）。
 * 止まった理由と直し方はそれぞれの表示に残し、これは並べて出す
 */
export function DirectTaskLink({ requestId }: { requestId: string }) {
  return (
    <p className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
      <span>
        Preflight を使えない間も、Preflight を通さずにタスクを作れます（評価・細分化・根拠の調査・画面イメージは付きません）。
      </span>
      <Link to="/requests/$requestId/board" params={{ requestId }} search={{ add: true }} className={buttonCls("secondary", "text-sm")}>
        Preflight を通さずにタスクを作成
      </Link>
    </p>
  );
}
