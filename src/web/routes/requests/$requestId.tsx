import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { TaskDrawer } from "../../components/TaskDrawer.tsx";
import { Empty } from "../../components/ui.tsx";
import { useAppCtx } from "../../lib/appCtx.ts";
import { RequestDataProvider, useRequestData } from "../../lib/requestData.tsx";
import { optionalString } from "../../lib/search.ts";

/**
 * 要望の枠: 見出し（タイトルとタスクの完了数。状態・ID は概要・Preflight の管理情報に出す）・タブ（概要と Preflight / タスクボード / 対応済み）・タスク詳細（?task=T003）。
 * 要望は作業の単位で、ここから下はすべてこの要望の中だけを扱う。
 */
export const Route = createFileRoute("/requests/$requestId")({
  validateSearch: (s: Record<string, unknown>): { task?: string } => ({ task: optionalString(s.task) }),
  component: RequestLayout,
});

function RequestLayout() {
  const { requestId } = Route.useParams();
  return (
    <RequestDataProvider
      key={requestId}
      requestId={requestId}
      fallback={
        <div className="p-10">
          <Empty>{requestId} は見つかりません</Empty>
        </div>
      }
    >
      <RequestFrame />
    </RequestDataProvider>
  );
}

const TABS = [
  { to: "/requests/$requestId", label: "概要・Preflight", exact: true },
  { to: "/requests/$requestId/board", label: "タスクボード", exact: false },
  { to: "/requests/$requestId/done", label: "対応済み", exact: false, hint: "人が「済み」にしたタスクの一覧（要望のステータスの「対応済」とは別）" },
] as const;

function RequestFrame() {
  const ctx = useAppCtx();
  const data = useRequestData();
  const { request, tasks } = data;
  const { task } = Route.useSearch();
  const navigate = useNavigate();
  const finished = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 pt-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-xl font-bold break-words">{request.title}</h1>
          {tasks.length > 0 && (
            <span className="text-sm whitespace-nowrap text-slate-500">
              タスク {finished}/{tasks.length} 完了
            </span>
          )}
        </div>
        {data.gone && (
          <p role="alert" className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            この要望は見つかりません（外で削除・アーカイブされました）。表示は最後に読み込めた内容で、保存はしません。
            入力中の内容は残っているので、必要なら写してから{" "}
            <Link to="/" className="underline">
              進捗へ戻って
            </Link>
            ください。
          </p>
        )}
        {data.loadError && !data.gone && (
          <p role="alert" className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            最新の内容を読み込めませんでした（表示は前の内容のまま）: {data.loadError}{" "}
            <button type="button" className="underline" onClick={() => data.reload()}>
              もう一度読み込む
            </button>
          </p>
        )}
        <nav className="mt-3 flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <Link
              key={t.to}
              title={"hint" in t ? t.hint : undefined}
              to={t.to}
              params={{ requestId: request.id }}
              activeOptions={{ exact: t.exact, includeSearch: false }}
              className="-mb-px border-b-2 px-3 py-2 font-medium whitespace-nowrap"
              activeProps={{ className: "border-indigo-600 text-indigo-700 dark:text-indigo-300" }}
              inactiveProps={{ className: "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>

      {task && (
        <TaskDrawer
          ctx={ctx}
          data={data}
          id={task}
          onClose={() => void navigate({ to: ".", search: (prev) => ({ ...prev, task: undefined }) })}
        />
      )}
    </div>
  );
}
