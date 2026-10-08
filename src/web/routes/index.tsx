import { createFileRoute, Link } from "@tanstack/react-router";
import { daysUntil, localToday } from "../../shared/dates.ts";
import type { Milestone, RequestProgress, StatusDef } from "../../shared/types.ts";
import { RequestStatusBadge } from "../components/RequestStatus.tsx";
import { buttonCls, cx, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";
import { fmtTime } from "../lib/format.ts";
import { optionalString } from "../lib/search.ts";

type Show = "open" | "closed" | "all";

/**
 * 進捗: 要望ごとの状況を横断して見る（タスクの中身は要望の画面で）。
 * 要望はマイルストーン（まとめてリリースする単位）ごとにまとめ、期限とタグを添える。
 */
export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { show?: Show; tag?: string } => ({
    show: s.show === "closed" || s.show === "all" ? s.show : undefined,
    tag: optionalString(s.tag),
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
function tally(ps: RequestProgress[], statuses: StatusDef[]) {
  const first = statuses[0]?.id;
  const sum = (f: (p: RequestProgress) => number) => ps.reduce((n, p) => n + f(p), 0);
  const total = sum((p) => p.total);
  const done = sum((p) => p.done);
  const doing = sum((p) => statuses.filter((s) => !s.done && s.id !== first).reduce((n, s) => n + (p.counts[s.id] ?? 0), 0));
  return { total, done, doing, todo: total - done - doing };
}

function ProgressBar({ t }: { t: ReturnType<typeof tally> }) {
  const pct = (n: number) => (t.total ? (n / t.total) * 100 : 0);
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
      <span className="bg-emerald-500" style={{ width: `${pct(t.done)}%` }} />
      <span className="bg-indigo-400" style={{ width: `${pct(t.doing)}%` }} />
    </div>
  );
}

/** 期限の表示。過ぎていれば赤、7日以内なら黄 */
function Due({ due, closed }: { due?: string; closed?: boolean }) {
  if (!due) return null;
  const days = daysUntil(due, localToday());
  const tone = closed ? "text-slate-400" : days < 0 ? "text-rose-600" : days <= 7 ? "text-amber-600" : "text-slate-500";
  const note = closed ? "" : days < 0 ? `（${-days}日超過）` : days === 0 ? "（今日）" : `（あと${days}日）`;
  return (
    <span className={tone}>
      期限 {due.slice(5).replace("-", "/")}
      {note}
    </span>
  );
}

function ProgressPage() {
  const ctx = useAppCtx();
  const { show = "open", tag } = Route.useSearch();
  const { statuses, milestones } = ctx.info.project;
  const list = ctx.requests
    .filter((p) => show === "all" || (show === "closed") === CLOSED.has(p.request.status))
    .filter((p) => !tag || p.request.tags.includes(tag));
  const open = ctx.requests.filter((p) => !CLOSED.has(p.request.status));
  const totals = tally(open, statuses);
  const tags = [...new Set(ctx.requests.flatMap((p) => p.request.tags))].sort();

  // マイルストーンごとにまとめる（定義の順。リリース済みは後ろ）。どれにも属さない要望は最後
  const groups: { m?: Milestone; ps: RequestProgress[] }[] = [
    ...[...milestones].sort((a, b) => Number(!!a.done) - Number(!!b.done)).map((m) => ({ m, ps: list.filter((p) => p.request.milestone === m.id) })),
    { ps: list.filter((p) => !p.request.milestone || !milestones.some((m) => m.id === p.request.milestone)) },
  ].filter((g) => g.ps.length);

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
              search={(prev) => ({ ...prev, show: v === "open" ? undefined : v })}
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500">
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
        {tags.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-1">
            タグ:
            {tags.map((t) => (
              <Link
                key={t}
                to="/"
                search={(prev) => ({ ...prev, tag: tag === t ? undefined : t })}
                className={cx(
                  "rounded px-1.5 py-0.5 ring-1 ring-inset",
                  tag === t
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700",
                )}
              >
                #{t}
              </Link>
            ))}
          </span>
        )}
      </div>

      {groups.length === 0 ? (
        <Empty>
          要望はありません。
          <Link to="/requests/new" className={buttonCls("ghost", "ml-2 underline")}>
            新しい要望を作る
          </Link>
        </Empty>
      ) : (
        groups.map((g) => {
          const t = tally(g.ps, statuses);
          return (
            <section key={g.m?.id ?? "-"} className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-slate-200 pb-2 dark:border-slate-800">
                <h2 className="text-lg font-semibold">{g.m ? g.m.title : "マイルストーンなし"}</h2>
                {g.m && <span className="font-mono text-sm text-slate-400">{g.m.id}</span>}
                {g.m?.done && <span className="text-sm text-emerald-600">リリース済み</span>}
                {g.m && (
                  <span className="text-sm">
                    <Due due={g.m.due} closed={g.m.done} />
                  </span>
                )}
                {g.m && t.total > 0 && (
                  <span className="ml-auto flex w-64 items-center gap-2 text-sm text-slate-500">
                    <span className="flex-1">
                      <ProgressBar t={t} />
                    </span>
                    {t.done}/{t.total}
                  </span>
                )}
              </div>
              <ul className="space-y-3">
                {g.ps.map((p) => (
                  <RequestRow key={p.request.id} p={p} statuses={statuses} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

function RequestRow({ p, statuses }: { p: RequestProgress; statuses: StatusDef[] }) {
  const r = p.request;
  const t = tally([p], statuses);
  const closed = CLOSED.has(r.status);
  const allDone = t.total > 0 && t.done === t.total && !closed;
  return (
    <li>
      <Link
        to="/requests/$requestId"
        params={{ requestId: r.id }}
        className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] dark:bg-slate-900 dark:ring-slate-800"
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-slate-500">{r.id}</span>
            <RequestStatusBadge status={r.status} />
            {r.tags.map((x) => (
              <span key={x} className="text-sm text-slate-500">
                #{x}
              </span>
            ))}
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
                  完了 {t.done}/{t.total}（{Math.round((t.done / t.total) * 100)}%）
                  {allDone && <span className="ml-2 font-normal text-emerald-600">全タスク完了</span>}
                </span>
                <span className="text-slate-500">
                  作業中 {t.doing} · 未着手 {t.todo}
                </span>
              </div>
              <ProgressBar t={t} />
            </>
          )}
        </div>

        <div className="row-start-1 space-y-0.5 text-right text-sm whitespace-nowrap md:row-start-auto">
          <p>
            <Due due={r.due} closed={closed} />
          </p>
          <p className="text-slate-400">更新 {fmtTime(p.updatedAt)}</p>
        </div>
      </Link>
    </li>
  );
}
