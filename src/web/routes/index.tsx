import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { localToday } from "../../shared/dates.ts";
import type { Milestone, RequestProgress, StatusDef, TaskMark } from "../../shared/types.ts";
import { DoingMark, DoneMark, Flag, TodoMark } from "../components/Marks.tsx";
import { RequestStatusBadge } from "../components/RequestStatus.tsx";
import { buttonCls, cx, Empty } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useAppCtx } from "../lib/appCtx.ts";
import { optionalString } from "../lib/search.ts";

type Show = "open" | "closed" | "all";

/**
 * 進捗: 左に要望、右にスケジュール。
 *   完了したタスクは完了にした日に ○（人が確認して「済み」にすると ✓。印をクリックで切り替え）
 *   作業中のタスクは作業中にした日に ◐、未着手のタスクは今日の右に □ を残りの数だけ
 *   要望の期限は ⚑、マイルストーンは ◆ と縦の破線、今日は縦の線
 */
export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { show?: Show; tag?: string } => ({
    show: s.show === "closed" || s.show === "all" ? s.show : undefined,
    tag: optionalString(s.tag),
  }),
  component: ProgressPage,
});

const CLOSED = new Set(["done", "rejected"]);
const DAY = 86_400_000;
const DAY_W = 30;
const ROW_H = 52;
const HEAD_H = 64;
const LEFT_W = 380;

/** ISO 日時 → ローカルの日付 */
const dateOf = (iso: string) => localToday(new Date(iso));
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => new Date(t(d) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);

function ProgressPage() {
  const ctx = useAppCtx();
  const { show = "open", tag } = Route.useSearch();
  const { statuses, milestones } = ctx.info.project;
  const today = localToday();
  const tags = [...new Set(ctx.requests.flatMap((p) => p.request.tags))].sort();

  // マイルストーンの順 → 期限の順。完了・見送りは既定で隠す
  const order = (p: RequestProgress) => {
    const i = milestones.findIndex((m) => m.id === p.request.milestone);
    return [i < 0 ? milestones.length : i, p.request.due ?? "9999"] as const;
  };
  const rows = ctx.requests
    .filter((p) => show === "all" || (show === "closed") === CLOSED.has(p.request.status))
    .filter((p) => !tag || p.request.tags.includes(tag))
    .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1].localeCompare(order(b)[1]));

  // 表示する期間: 過去の出来事・期限・マイルストーンが入り、今日の前後に余白がある範囲
  const dates = [
    today,
    ...rows.flatMap((p) => [dateOf(p.request.createdAt), p.request.due, ...p.tasks.flatMap((x) => [x.startedAt && dateOf(x.startedAt), x.doneAt && dateOf(x.doneAt)])]),
    ...milestones.map((m) => m.due),
  ].filter((d): d is string => !!d);
  const origin = addDays([addDays(today, -14), ...dates].sort()[0], -3);
  const last = addDays([addDays(today, 21), ...dates].sort().at(-1)!, 7);
  const span = daysBetween(origin, last) + 1;
  const days = Array.from({ length: span }, (_, i) => addDays(origin, i));
  const x = (d: string) => daysBetween(origin, d) * DAY_W;
  const height = HEAD_H + Math.max(rows.length, 1) * ROW_H;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-bold">進捗</h1>
        <nav className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
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
              className={cx("rounded-md px-3 py-0.5", show === v ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}
            >
              {label}
            </Link>
          ))}
        </nav>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((x) => (
              <Link
                key={x}
                to="/"
                search={(prev) => ({ ...prev, tag: tag === x ? undefined : x })}
                className={cx(
                  "rounded px-1.5 py-0.5 text-sm ring-1 ring-inset",
                  tag === x ? "bg-indigo-600 text-white ring-indigo-600" : "text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-700",
                )}
              >
                #{x}
              </Link>
            ))}
          </div>
        )}
        <Legend />
      </div>

      {rows.length === 0 ? (
        <div className="p-10">
          <Empty>
            要望はありません。
            <Link to="/requests/new" className={buttonCls("ghost", "ml-2 underline")}>
              新しい要望を作る
            </Link>
          </Empty>
        </div>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
          // 開いたとき今日が見える位置へ（左の一覧の右、少し過去が見えるくらい）
          ref={(el) => {
            if (el && !el.dataset.scrolled) {
              el.dataset.scrolled = "1";
              el.scrollLeft = Math.max(0, x(today) - (el.clientWidth - LEFT_W) * 0.4);
            }
          }}
        >
          <div className="flex" style={{ width: LEFT_W + span * DAY_W, minHeight: "100%" }}>
            {/* 左: 要望 */}
            <div className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ width: LEFT_W }}>
              <div className="sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ height: HEAD_H }} />
              {rows.map((p) => (
                <RequestCell key={p.request.id} p={p} statuses={statuses} milestones={milestones} />
              ))}
            </div>

            {/* 右: スケジュール */}
            <div className="relative" style={{ width: span * DAY_W, height }}>
              <DaysHeader days={days} today={today} milestones={milestones} x={x} />
              {days.map((d, i) => {
                const wd = new Date(t(d)).getUTCDay();
                return wd === 0 || wd === 6 ? (
                  <div key={d} className="absolute bg-slate-100/70 dark:bg-slate-800/40" style={{ left: i * DAY_W, width: DAY_W, top: HEAD_H, bottom: 0 }} />
                ) : null;
              })}
              {milestones
                .filter((m) => m.due)
                .map((m) => (
                  <div
                    key={m.id}
                    className={cx("absolute z-[1] border-l-2 border-dashed", m.done ? "border-slate-300 dark:border-slate-600" : "border-violet-400")}
                    style={{ left: x(m.due!) + DAY_W / 2 - 1, top: HEAD_H, bottom: 0 }}
                  />
                ))}
              <div className="absolute z-[2] w-0.5 bg-indigo-500" style={{ left: x(today) + DAY_W / 2 - 1, top: 0, bottom: 0 }} />
              {rows.map((p, i) => (
                <RequestLane key={p.request.id} p={p} top={HEAD_H + i * ROW_H} today={today} x={x} statuses={statuses} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 凡例（記号だけ） */
function Legend() {
  const item = (icon: React.ReactNode, label: string) => (
    <span className="flex items-center gap-1">
      {icon}
      {label}
    </span>
  );
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3 text-sm text-slate-500">
      {item(<DoneMark checked={false} />, "完了")}
      {item(<DoneMark checked />, "済み")}
      {item(<DoingMark />, "作業中")}
      {item(<TodoMark />, "未着手")}
      {item(<span className="text-violet-500">◆</span>, "マイルストーン")}
      {item(<Flag overdue={false} />, "期限")}
      {item(<span className="inline-block h-3.5 w-0.5 bg-indigo-500" />, "今日")}
    </div>
  );
}

function DaysHeader({ days, today, milestones, x }: { days: string[]; today: string; milestones: Milestone[]; x: (d: string) => number }) {
  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ height: HEAD_H }}>
      {/* マイルストーン */}
      {milestones
        .filter((m) => m.due)
        .map((m) => (
          <span
            key={m.id}
            title={`${m.title}（${m.due}）`}
            className={cx("absolute top-1 -translate-x-1/2 text-sm whitespace-nowrap", m.done ? "text-slate-400" : "font-medium text-violet-600 dark:text-violet-400")}
            style={{ left: x(m.due!) + DAY_W / 2 }}
          >
            ◆ {m.id}
          </span>
        ))}
      {/* 日付 */}
      <div className="absolute inset-x-0 bottom-0 flex">
        {days.map((d) => {
          const dt = new Date(`${d}T00:00:00Z`);
          const wd = dt.getUTCDay();
          const isToday = d === today;
          return (
            <div key={d} style={{ width: DAY_W }} className="flex shrink-0 flex-col items-center pb-1 text-sm">
              <span className="h-4 text-xs text-slate-400">{dt.getUTCDate() === 1 || d === days[0] ? `${dt.getUTCMonth() + 1}月` : ""}</span>
              <span
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded-full",
                  isToday ? "bg-indigo-600 font-bold text-white" : wd === 0 || wd === 6 ? "text-slate-400" : "text-slate-600 dark:text-slate-300",
                )}
              >
                {dt.getUTCDate()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RequestCell({ p, statuses, milestones }: { p: RequestProgress; statuses: StatusDef[]; milestones: Milestone[] }) {
  const r = p.request;
  const c = count(p, statuses);
  const m = milestones.find((x) => x.id === r.milestone);
  return (
    <Link
      to="/requests/$requestId"
      params={{ requestId: r.id }}
      className="flex flex-col justify-center gap-0.5 border-b border-slate-100 px-4 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
      style={{ height: ROW_H }}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-slate-400">{r.id}</span>
        <RequestStatusBadge status={r.status} />
        {m && <span className="text-violet-600 dark:text-violet-400">◆ {m.id}</span>}
        <span className="ml-auto flex items-center gap-2 text-slate-500">
          {c.checked > 0 && (
            <span className="flex items-center gap-0.5">
              <DoneMark checked /> {c.checked}
            </span>
          )}
          {c.done > 0 && (
            <span className="flex items-center gap-0.5">
              <DoneMark checked={false} /> {c.done}
            </span>
          )}
          {c.doing > 0 && (
            <span className="flex items-center gap-0.5">
              <DoingMark /> {c.doing}
            </span>
          )}
          {c.todo > 0 && (
            <span className="flex items-center gap-0.5">
              <TodoMark /> {c.todo}
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{r.title}</span>
        {r.tags.map((x) => (
          <span key={x} className="shrink-0 text-sm text-slate-400">
            #{x}
          </span>
        ))}
      </div>
    </Link>
  );
}

/** 完了（済みでない）・済み・作業中・未着手の数 */
function count(p: RequestProgress, statuses: StatusDef[]) {
  const done = new Set(statuses.filter((s) => s.done).map((s) => s.id));
  const first = statuses[0]?.id;
  const c = { done: 0, checked: 0, doing: 0, todo: 0 };
  for (const x of p.tasks) {
    if (done.has(x.status)) x.checkedAt ? c.checked++ : c.done++;
    else if (x.status === first) c.todo++;
    else c.doing++;
  }
  return c;
}

function RequestLane({
  p,
  top,
  today,
  x,
  statuses,
}: {
  p: RequestProgress;
  top: number;
  today: string;
  x: (d: string) => number;
  statuses: StatusDef[];
}) {
  const ctx = useAppCtx();
  const [busy, setBusy] = useState<string | null>(null);
  const r = p.request;
  const done = new Set(statuses.filter((s) => s.done).map((s) => s.id));
  const first = statuses[0]?.id;
  const closed = CLOSED.has(r.status);

  // 日ごとの印
  const byDay = new Map<string, { task: TaskMark; kind: "done" | "doing" }[]>();
  const put = (d: string, task: TaskMark, kind: "done" | "doing") => (byDay.get(d) ?? byDay.set(d, []).get(d)!).push({ task, kind });
  for (const task of p.tasks) {
    if (done.has(task.status) && task.doneAt) put(dateOf(task.doneAt), task, "done");
    else if (!done.has(task.status) && task.status !== first) put(task.startedAt ? dateOf(task.startedAt) : today, task, "doing");
  }
  const todo = p.tasks.filter((x) => x.status === first);

  // 要望の線: 作った日から、期限（無ければ今日・最後の出来事）まで
  const start = dateOf(r.createdAt);
  const end = [r.due ?? today, ...[...byDay.keys()]].sort().at(-1)!;
  const cy = top + ROW_H / 2;

  async function toggle(task: TaskMark) {
    setBusy(task.ref);
    try {
      await api.patchTask(task.ref, { checked: !task.checkedAt });
      ctx.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="absolute border-b border-slate-100 dark:border-slate-800" style={{ top, height: ROW_H, left: 0, right: 0 }} />
      <div
        className={cx("absolute z-[3] h-0.5 rounded", closed ? "bg-slate-200 dark:bg-slate-700" : "bg-slate-300 dark:bg-slate-600")}
        style={{ top: cy - 1, left: x(start) + DAY_W / 2, width: Math.max(0, x(end) - x(start)) }}
      />
      {r.due && (
        <span
          className="absolute z-[4] -translate-x-1/2 -translate-y-full"
          style={{ left: x(r.due) + DAY_W / 2 + 4, top: cy + 2 }}
          title={`期限 ${r.due}`}
        >
          <Flag overdue={!closed && r.due < today && todo.length + [...byDay.values()].flat().filter((m) => m.kind === "doing").length > 0} />
        </span>
      )}
      {[...byDay].map(([d, marks]) => (
        <div
          key={d}
          className="absolute z-[5] flex flex-wrap content-center items-center justify-center gap-0.5"
          style={{ left: x(d), width: DAY_W, top, height: ROW_H }}
        >
          {marks.map(({ task, kind }) =>
            kind === "done" ? (
              <button
                key={task.ref}
                disabled={busy === task.ref}
                onClick={() => void toggle(task)}
                title={`${task.id} ${task.title}\n${task.checkedAt ? "済み（クリックで外す）" : "完了（クリックで済みにする）"}`}
                className="rounded-full transition hover:scale-125"
              >
                <DoneMark checked={!!task.checkedAt} />
              </button>
            ) : (
              <button key={task.ref} onClick={() => ctx.open(task.ref)} title={`${task.id} ${task.title}（作業中）`} className="transition hover:scale-125">
                <DoingMark />
              </button>
            ),
          )}
        </div>
      ))}
      {todo.length > 0 && (
        <div
          className="absolute z-[5] flex flex-wrap content-center items-center gap-[3px]"
          style={{ left: x(today) + DAY_W / 2 + 6, top, height: ROW_H, width: Math.min(8, Math.ceil(todo.length / 2)) * 13 }}
          title={`未着手 ${todo.length}`}
        >
          {todo.map((task) => (
            <button key={task.ref} onClick={() => ctx.open(task.ref)} title={`${task.id} ${task.title}（未着手）`} className="transition hover:scale-125">
              <TodoMark />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
