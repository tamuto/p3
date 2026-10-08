import { createFileRoute, Link, Outlet, useParams } from "@tanstack/react-router";
import { RequestStatusBadge } from "../components/RequestStatus.tsx";
import { buttonCls, cx } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";
import { streamColor } from "../lib/colors.ts";

export const Route = createFileRoute("/preflight")({
  component: PreflightLayout,
});

/** /preflight 配下の共通の枠: 左に要望の一覧、右に子ルート（説明 / 新規作成 / 要望の詳細） */
function PreflightLayout() {
  const ctx = useAppCtx();
  const { requestId } = useParams({ strict: false });
  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-semibold">要望</h2>
          <Link to="/preflight/new" search={(prev) => prev} className={buttonCls("primary")}>
            ＋ 新しい要望
          </Link>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {[...ctx.requests].reverse().map((r) => (
            <li key={r.id}>
              <Link
                to="/preflight/$requestId"
                params={{ requestId: r.id }}
                search={(prev) => ({ stream: prev.stream })}
                className={cx(
                  "flex w-full flex-col gap-1 border-l-4 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800",
                  r.id === requestId ? "bg-indigo-50/60 dark:bg-indigo-950/40" : "",
                )}
                style={{ borderLeftColor: r.status === "accepted" ? streamColor(r.id) : "transparent" }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm text-slate-500">{r.id}</span>
                  <RequestStatusBadge status={r.status} />
                </div>
                <span className="leading-snug">{r.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
