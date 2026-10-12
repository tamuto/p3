import { createRootRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Logo } from "../components/Logo.tsx";
import { buttonCls, cx, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";

/**
 * 全画面の共通部分。ページは src/web/routes/ にファイルを置けば足りる（ルート一覧 routeTree.gen.ts は自動生成）。
 *
 *   /                                   進捗（全要望の横断）
 *   /requests/new                       新しい要望
 *   /requests/$requestId                要望の概要と Preflight（?run=）
 *   /requests/$requestId/board          要望のタスクボード（V 字: 未着手 → 作業中 → 完了）
 *   /requests/$requestId/done           要望の対応済み（済みにしたタスク）
 *   /settings?tab=                      設定（personal 個人 / project プロジェクトの基本 / repos 参照先）
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
  { to: "/settings", label: "設定", hint: "個人・プロジェクトの基本・参照先" },
] as const;

const navCls = "rounded-md px-3 py-1.5 font-medium whitespace-nowrap transition";
const navActive = "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300";
const navIdle = "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800";

function Layout() {
  const ctx = useAppCtx();
  const pathname = useLocation({ select: (l) => l.pathname });
  const errors = Object.keys(ctx.info.errors);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b sm:gap-6 border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        {/* 狭い画面ではプロジェクト名を省略して、見出しが画面の幅に収まるようにする */}
        <Link to="/" className="flex min-w-0 items-center gap-3" title={`infodb p3 · ${ctx.info.project.name}`}>
          <Logo />
          <span className="truncate font-medium">{ctx.info.project.name}</span>
        </Link>
        <nav className="flex shrink-0 gap-1">
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
        <RefreshButton running={ctx.refreshing.running} onClick={() => void ctx.refresh()} />
        <Link to="/requests/new" className={buttonCls("primary", "whitespace-nowrap")}>
          ＋ 新しい要望
        </Link>
        {errors.length > 0 && (
          <span className="text-sm text-rose-600" title={errors.map((f) => `${f}: ${ctx.info.errors[f]}`).join("\n")}>
            ⚠ 読めないファイル {errors.length} 件
          </span>
        )}
      </header>

      {ctx.refreshing.error && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-rose-50 px-5 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <span className="min-w-0 break-words">再読み込みできませんでした（表示は前の内容のまま）: {ctx.refreshing.error}</span>
          <button type="button" className={buttonCls("ghost", "underline")} onClick={() => void ctx.refresh()}>
            もう一度
          </button>
        </div>
      )}

      {!ctx.info.project.description && !pathname.startsWith("/settings") && (
        <div className="flex items-center gap-3 bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          プロジェクトの説明がまだありません。Preflight の前提になるので設定してください。
          <Link to="/settings" search={{ tab: "project" }} className={buttonCls("ghost", "underline")}>
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

/**
 * データのフォルダを全部読み直して画面を取り直す（CLI など外での変更を取り込む。ブラウザのリロードはしない）。
 * 読み直している間も押せる（終わってからもう1回だけ読む）。狭い画面ではアイコンだけ
 */
function RefreshButton({ running, onClick }: { running: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={running}
      title="データのフォルダを読み直して、外（CLI など）での変更を取り込みます"
      className={buttonCls("secondary", "ml-auto px-2 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none sm:px-3")}
    >
      <svg aria-hidden viewBox="0 0 16 16" className={cx("size-4", running && "animate-spin")} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2.5v3h-3" />
      </svg>
      <span className="sr-only sm:not-sr-only">{running ? "読み込み中…" : "再読み込み"}</span>
    </button>
  );
}
