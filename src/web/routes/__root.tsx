import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { buttonCls, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";

/**
 * 全画面の共通部分。ページは src/web/routes/ にファイルを置けば足りる（ルート一覧 routeTree.gen.ts は自動生成）。
 *
 *   /                                   進捗（全要望の横断）
 *   /requests/new                       新しい要望
 *   /requests/$requestId                要望の概要と Preflight（?run=）
 *   /requests/$requestId/board          要望のタスクボード（V 字: 未着手 → 作業中 → 完了）
 *   /requests/$requestId/done           要望の対応済み（済みにしたタスク）
 *   /settings                           プロジェクト設定
 *
 * 要望の中のページでは ?task=T003 でタスク詳細を重ねて開く。URL を共有すれば同じ画面が開ける。
 */
export const Route = createRootRoute({
  component: Layout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl p-10">
      <Empty>ページが見つかりません</Empty>
    </div>
  ),
});

const NAV = [
  { to: "/", label: "進捗", hint: "要望ごとの状況" },
  { to: "/settings", label: "設定", hint: "プロジェクト名・ドキュメント・列" },
] as const;

const navCls = "rounded-md px-3 py-1.5 font-medium transition";
const navActive = "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300";
const navIdle = "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800";

function Layout() {
  const ctx = useAppCtx();
  const pathname = useLocation({ select: (l) => l.pathname });
  const errors = Object.keys(ctx.info.errors);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        <Link to="/" className="flex items-baseline gap-2" title="infodb p3">
          <span className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
            P<sup className="ml-px text-[0.6em]">3</sup>
          </span>
          <span className="font-medium">{ctx.info.project.name}</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              title={n.hint}
              className={navCls}
              activeOptions={{ exact: n.to === "/" }}
              activeProps={{ className: navActive }}
              inactiveProps={{ className: navIdle }}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <Link to="/requests/new" className={buttonCls("primary", "ml-auto")}>
          ＋ 新しい要望
        </Link>
        {errors.length > 0 && (
          <span className="text-sm text-rose-600" title={errors.map((f) => `${f}: ${ctx.info.errors[f]}`).join("\n")}>
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
    </div>
  );
}
