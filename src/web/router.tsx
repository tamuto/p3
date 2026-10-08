import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { buttonCls, Empty } from "./components/ui.tsx";
import { useAppCtx } from "./lib/appCtx.ts";
import { Gantt } from "./views/Gantt.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { Intro, NewRequest, PreflightLayout, RequestPanel } from "./views/Preflight.tsx";
import { Settings } from "./views/Settings.tsx";

/**
 * 画面のルート。
 *
 *   /board                 かんばん
 *   /schedule              スケジュール（ガント）
 *   /preflight             要望の一覧と説明
 *   /preflight/new         新しい要望
 *   /preflight/$requestId  要望の詳細（?run= で表示する preflight を選ぶ）
 *   /settings              プロジェクト設定
 *
 * どの画面でも ?task=TASK-0003 でタスク詳細を重ねて開き、?stream=REQ-0002 で作業ツリーに絞る。
 * URL を共有すれば同じ画面が開ける。
 */

interface RootSearch {
  task?: string;
  stream?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const rootRoute = createRootRoute({
  validateSearch: (s: Record<string, unknown>): RootSearch => ({ task: str(s.task), stream: str(s.stream) }),
  component: Layout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl p-10">
      <Empty>ページが見つかりません</Empty>
    </div>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/board" });
  },
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/board",
  component: () => <Kanban ctx={useAppCtx()} />,
});

const scheduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedule",
  component: () => <Gantt ctx={useAppCtx()} />,
});

const preflightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/preflight",
  component: () => (
    <PreflightLayout ctx={useAppCtx()}>
      <Outlet />
    </PreflightLayout>
  ),
});

const preflightIndexRoute = createRoute({
  getParentRoute: () => preflightRoute,
  path: "/",
  component: Intro,
});

const newRequestRoute = createRoute({
  getParentRoute: () => preflightRoute,
  path: "/new",
  component: function NewRequestPage() {
    const ctx = useAppCtx();
    const navigate = useNavigate();
    return (
      <NewRequest
        onCreated={(id) => {
          ctx.reload();
          void navigate({ to: "/preflight/$requestId", params: { requestId: id } });
        }}
      />
    );
  },
});

const requestRoute = createRoute({
  getParentRoute: () => preflightRoute,
  path: "/$requestId",
  validateSearch: (s: Record<string, unknown>): { run?: string } => ({ run: str(s.run) }),
  component: function RequestPage() {
    const ctx = useAppCtx();
    const { requestId } = requestRoute.useParams();
    const { run } = requestRoute.useSearch();
    const navigate = requestRoute.useNavigate();
    const request = ctx.requests.find((r) => r.id === requestId);
    if (!request) {
      return (
        <div className="p-10">
          <Empty>{requestId} は見つかりません</Empty>
        </div>
      );
    }
    return (
      <RequestPanel
        key={request.id}
        ctx={ctx}
        request={request}
        runId={run}
        onRunChange={(id) => void navigate({ search: (prev) => ({ ...prev, run: id }) })}
      />
    );
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => <Settings ctx={useAppCtx()} />,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  scheduleRoute,
  preflightRoute.addChildren([preflightIndexRoute, newRequestRoute, requestRoute]),
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

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
  const search = useSearch({ from: rootRoute.id });
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
