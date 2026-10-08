import { createRootRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { TaskDrawer } from "../components/TaskDrawer.tsx";
import { buttonCls, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";
import { optionalString } from "../lib/search.ts";

/**
 * 全画面の共通部分。どの画面でも ?task=TASK-0003 でタスク詳細を重ねて開き、
 * ?stream=REQ-0002 で作業ツリーに絞る。URL を共有すれば同じ画面が開ける。
 *
 * ページは src/web/routes/ にファイルを置けば足りる（ルート一覧 routeTree.gen.ts は自動生成）。
 */
export const Route = createRootRoute({
  validateSearch: (s: Record<string, unknown>): { task?: string; stream?: string } => ({
    task: optionalString(s.task),
    stream: optionalString(s.stream),
  }),
  component: Layout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl p-10">
      <Empty>ページが見つかりません</Empty>
    </div>
  ),
});

const NAV = [
  { to: "/preflight", label: "Preflight", hint: "要望の評価とタスク化" },
  { to: "/board", label: "かんばん", hint: "ステータス別" },
  { to: "/schedule", label: "スケジュール", hint: "依存を考慮したガント" },
  { to: "/settings", label: "設定", hint: "プロジェクト名・メンバー・ドキュメント" },
] as const;

const navCls = "rounded-md px-3 py-1.5 font-medium transition";
const navActive = "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300";
const navIdle = "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800";

/** 全画面共通: ヘッダ（ナビ・作業ツリーの絞り込み）、警告、タスク詳細のドロワー */
function Layout() {
  const ctx = useAppCtx();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const filterable = pathname.startsWith("/board") || pathname.startsWith("/schedule");
  const errors = Object.keys(ctx.info.errors);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-tight text-indigo-600 dark:text-indigo-400">pcube</span>
          <span className="font-medium">{ctx.info.project.name}</span>
        </div>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={n.hint}
              // 絞り込みは画面を移っても保つ。タスク詳細は閉じる
              search={(prev) => ({ stream: prev.stream })}
              className={navCls}
              activeProps={{ className: navActive }}
              inactiveProps={{ className: navIdle }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        {filterable && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-slate-500">作業ツリー</span>
            <select
              value={search.stream ?? ""}
              onChange={(e) => void navigate({ to: ".", search: (prev) => ({ ...prev, stream: e.target.value || undefined }) })}
              className="max-w-xs rounded-md bg-white px-2 py-1 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
            >
              <option value="">すべて</option>
              {ctx.requests
                .filter((r) => r.status === "accepted")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} {r.title}
                  </option>
                ))}
            </select>
          </div>
        )}
        {errors.length > 0 && (
          <span className="ml-2 text-sm text-rose-600" title={JSON.stringify(ctx.info.errors, null, 2)}>
            ⚠ 読めないファイル {errors.length} 件
          </span>
        )}
      </header>

      {!ctx.info.project.description && !pathname.startsWith("/settings") && (
        <div className="flex items-center gap-3 bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          プロジェクトの説明がまだありません。Preflight の前提になるので設定してください。
          <Link to="/settings" className={buttonCls("ghost", "underline")}>
            設定を開く
          </Link>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>

      {search.task && (
        <TaskDrawer
          ctx={ctx}
          id={search.task}
          onClose={() => void navigate({ to: ".", search: (prev) => ({ ...prev, task: undefined }) })}
        />
      )}
    </div>
  );
}
