import { createFileRoute, Link } from "@tanstack/react-router";
import type { RequestProgress, StatusDef } from "../../shared/types.ts";
import { RequestStatusBadge } from "../components/RequestStatus.tsx";
import { buttonCls, cx, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";

type Show = "open" | "closed" | "all";

/** 進捗: 要望ごとの状況を横断して見る（タスクの中身は要望の画面で） */
export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { show?: Show } => ({
    show: s.show === "closed" || s.show === "all" ? s.show : undefined,
  }),
  component: ProgressPage,
});

const CLOSED = new Set(["done", "rejected"]);

/**
 * 要望の進捗をタスクの件数で表す。
 *   完了   = 完了扱いの列のタスク        （緑で塗る。％はこれ）
 *   作業中 = 最初の列と完了以外の列のタスク（青で塗る）
 *   未着手 = 最初の列のタスク            （塗らない）
 */
function tally(p: RequestProgress, statuses: StatusDef[]) {
  const first = statuses[0]?.id;
  const doing = statuses.filter((s) => !s.done && s.id !== first).reduce((n, s) => n + (p.counts[s.id] ?? 0), 0);
  return { done: p.done, doing, todo: p.total - p.done - doing, total: p.total };
}

function ProgressPage() {
  const ctx = useAppCtx();
  const show = Route.useSearch().show ?? "open";
  const { statuses } = ctx.info.project;
  const list = ctx.requests.filter((p) => show === "all" || (show === "closed") === CLOSED.has(p.request.status));
  const open = ctx.requests.filter((p) => !CLOSED.has(p.request.status));
  const totals = open.map((p) => tally(p, statuses)).reduce((a, t) => ({ total: a.total + t.total, done: a.done + t.done, doing: a.doing + t.doing }), {
    total: 0,
    done: 0,
    doing: 0,
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8">
      <header className="flex flex-wrap items-end gap-6">
        <div>
          <h1 className="text-2xl font-bold">進捗</h1>
          <p className="mt-1 text-slate-500">
            進行中の要望 {open.length} 件 · タスク {totals.done}/{totals.total} 完了 · 作業中 {totals.doing}
          </p>
        </div>
        <nav className="ml-auto flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
          {(
            [
              ["open", "進行中"],
              ["closed", "完了・見送り"],
              ["all", "すべて"],
            ] as const
          ).map(([v, label]) => (
            <Link
              key={v}
              to="/"
              search={{ show: v === "open" ? undefined : v }}
              className={cx(
                "rounded-md px-3 py-1",
                show === v ? "bg-white shadow-sm dark:bg-slate-800" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="flex flex-wrap gap-4 text-sm text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-emerald-500" /> 完了
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-indigo-400" /> 作業中
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-slate-200 dark:bg-slate-700" /> 未着手
        </span>
        <span>％は全タスクのうち完了した割合</span>
      </div>

      {list.length === 0 ? (
        <Empty>
          要望はありません。
          <Link to="/requests/new" className={buttonCls("ghost", "ml-2 underline")}>
            新しい要望を作る
          </Link>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {list.map((p) => (
            <RequestRow key={p.request.id} p={p} statuses={statuses} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RequestRow({ p, statuses }: { p: RequestProgress; statuses: StatusDef[] }) {
  const r = p.request;
  const t = tally(p, statuses);
  const pct = (n: number) => (t.total ? (n / t.total) * 100 : 0);
  const allDone = t.total > 0 && t.done === t.total && !CLOSED.has(r.status);
  return (
    <li>
      <Link
        to="/requests/$requestId"
        params={{ requestId: r.id }}
        className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] dark:bg-slate-900 dark:ring-slate-800"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-slate-500">{r.id}</span>
            <RequestStatusBadge status={r.status} />
            {allDone && <span className="text-sm text-emerald-600">全タスク完了</span>}
          </div>
          <p className="truncate font-semibold">{r.title}</p>
          {r.workstream && <p className="truncate font-mono text-sm text-slate-400">⎇ {r.workstream.branch}</p>}
        </div>

        <div className="col-span-2 space-y-1.5 self-center md:col-span-1">
          {t.total === 0 ? (
            <p className="text-sm text-slate-400">{r.status === "draft" ? "Preflight 前" : "タスクはまだありません"}</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  完了 {t.done}/{t.total}（{Math.round(pct(t.done))}%）
                </span>
                <span className="text-slate-500">
                  作業中 {t.doing} · 未着手 {t.todo}
                </span>
              </div>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <span className="bg-emerald-500" style={{ width: `${pct(t.done)}%` }} />
                <span className="bg-indigo-400" style={{ width: `${pct(t.doing)}%` }} />
              </div>
            </>
          )}
        </div>

        <div className="row-start-1 text-right text-sm whitespace-nowrap text-slate-500 md:row-start-auto">
          {p.start && (
            <p>
              {p.start.slice(5)} 〜 {p.end!.slice(5)}
            </p>
          )}
          {p.conflicts > 0 && <p className="text-rose-600">依存と矛盾 {p.conflicts}</p>}
          <p className="text-slate-400">更新 {new Date(p.updatedAt).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
        </div>
      </Link>
    </li>
  );
}
