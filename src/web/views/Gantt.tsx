import { useMemo, useState } from "react";
import { addDays, daysBetween, schedule } from "../../shared/schedule.ts";
import { RELATION_TYPES, type RelationType, type Task } from "../../shared/types.ts";
import type { AppCtx } from "../App.tsx";
import { cx, Id } from "../components/ui.tsx";
import { streamColor } from "../lib/colors.ts";

const DAY_W = 34;
const ROW_H = 40;
const HEAD_H = 52;

const EDGE_STYLES: Partial<Record<RelationType, { color: string; dash?: string }>> = {
  depends_on: { color: "#64748b" },
  impacts: { color: "#f59e0b", dash: "5 4" },
  relates_to: { color: "#8b5cf6", dash: "2 4" },
};

const today = () => new Date().toISOString().slice(0, 10);

type Row = { kind: "group"; id: string; title: string } | { kind: "task"; task: Task };

export function Gantt({ ctx }: { ctx: AppCtx }) {
  const [shown, setShown] = useState<Set<RelationType>>(new Set(["depends_on"]));
  const now = today();
  const doneStatuses = new Set(ctx.info.project.statuses.filter((s) => s.done).map((s) => s.id));

  const { rows, bars, origin, span } = useMemo(() => {
    const tasks = ctx.stream ? ctx.tasks.filter((t) => t.request === ctx.stream) : ctx.tasks;
    // スケジュール計算は全タスクで行う（絞り込み外の依存も日付に効くため）
    const bars = schedule(ctx.tasks, now);
    const groups = new Map<string, Task[]>();
    for (const t of tasks) {
      const k = t.request ?? "(要望なし)";
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
    }
    const rows: Row[] = [];
    for (const [k, ts] of groups) {
      rows.push({ kind: "group", id: k, title: ctx.requests.find((r) => r.id === k)?.title ?? "" });
      ts.sort((a, b) => bars.get(a.id)!.start.localeCompare(bars.get(b.id)!.start));
      for (const t of ts) rows.push({ kind: "task", task: t });
    }
    const starts = tasks.map((t) => bars.get(t.id)!.start);
    const ends = tasks.map((t) => bars.get(t.id)!.end);
    const origin = addDays([now, ...starts].sort()[0], -2);
    const last = addDays([now, ...ends].sort().at(-1)!, 7);
    return { rows, bars, origin, span: daysBetween(origin, last) + 1 };
  }, [ctx.tasks, ctx.requests, ctx.stream, now]);

  const rowIndex = new Map<string, number>();
  rows.forEach((r, i) => r.kind === "task" && rowIndex.set(r.task.id, i));
  const x = (d: string) => daysBetween(origin, d) * DAY_W;

  const edges = rows.flatMap((r) =>
    r.kind === "task"
      ? r.task.relations
          .filter((rel) => shown.has(rel.type) && rowIndex.has(rel.target))
          // depends_on は「依存先 → 自分」、それ以外は「自分 → 相手」の向きに描く
          .map((rel) =>
            rel.type === "depends_on"
              ? { from: rel.target, to: r.task.id, type: rel.type, origin: rel.origin }
              : { from: r.task.id, to: rel.target, type: rel.type, origin: rel.origin },
          )
      : [],
  );

  const days = Array.from({ length: span }, (_, i) => addDays(origin, i));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-slate-200 px-5 py-2 dark:border-slate-800">
        <span className="text-sm text-slate-500">関係の表示</span>
        {(Object.keys(EDGE_STYLES) as RelationType[]).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={shown.has(t)}
              onChange={() => {
                const n = new Set(shown);
                if (n.has(t)) n.delete(t);
                else n.add(t);
                setShown(n);
              }}
            />
            <svg width="22" height="6">
              <line x1="0" y1="3" x2="22" y2="3" stroke={EDGE_STYLES[t]!.color} strokeWidth="2" strokeDasharray={EDGE_STYLES[t]!.dash} />
            </svg>
            {RELATION_TYPES[t].label}
          </label>
        ))}
        <span className="ml-auto flex items-center gap-3 text-sm text-slate-500">
          <span className="flex items-center gap-1">
            <span className="bar-inferred inline-block h-3 w-6 rounded bg-slate-400" /> 推定（日付未設定）
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-6 rounded bg-slate-400 ring-2 ring-rose-500" /> 依存と矛盾
          </span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-auto">
        {/* 左: タスク名 */}
        <div className="sticky left-0 z-20 w-80 shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div style={{ height: HEAD_H }} className="border-b border-slate-200 dark:border-slate-800" />
          {rows.map((r) =>
            r.kind === "group" ? (
              <div key={`g-${r.id}`} style={{ height: ROW_H }} className="flex items-center gap-2 bg-slate-50 px-3 dark:bg-slate-950">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: streamColor(r.id) }} />
                <span className="shrink-0 font-mono text-sm whitespace-nowrap text-slate-500">{r.id}</span>
                <span className="truncate font-semibold">{r.title}</span>
              </div>
            ) : (
              <div
                key={r.task.id}
                style={{ height: ROW_H }}
                className="flex cursor-pointer items-center gap-2 px-3 pl-6 hover:bg-slate-50 dark:hover:bg-slate-800"
                onClick={() => ctx.openTask(r.task.id)}
              >
                <Id id={r.task.id} />
                <span className={cx("truncate", doneStatuses.has(r.task.status) && "text-slate-400 line-through")}>{r.task.title}</span>
              </div>
            ),
          )}
        </div>

        {/* 右: タイムライン */}
        <div className="relative" style={{ width: span * DAY_W, minHeight: HEAD_H + rows.length * ROW_H }}>
          <div className="sticky top-0 z-10 flex border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ height: HEAD_H }}>
            {days.map((d) => {
              const dt = new Date(`${d}T00:00:00Z`);
              const wd = dt.getUTCDay();
              return (
                <div
                  key={d}
                  style={{ width: DAY_W }}
                  className={cx("flex shrink-0 flex-col items-center justify-end pb-1 text-sm", (wd === 0 || wd === 6) && "text-slate-400", d === now && "font-bold text-indigo-600")}
                >
                  {(dt.getUTCDate() === 1 || d === origin) && <span className="text-xs text-slate-500">{dt.getUTCMonth() + 1}月</span>}
                  {dt.getUTCDate()}
                </div>
              );
            })}
          </div>

          {/* 週末の背景と今日線 */}
          {days.map((d, i) => {
            const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
            return wd === 0 || wd === 6 ? (
              <div key={d} className="absolute bg-slate-100/70 dark:bg-slate-900/60" style={{ left: i * DAY_W, width: DAY_W, top: HEAD_H, bottom: 0 }} />
            ) : null;
          })}
          <div className="absolute z-[1] w-0.5 bg-indigo-500/70" style={{ left: x(now) + DAY_W / 2, top: HEAD_H, bottom: 0 }} />

          {/* 幅の狭いバーはタイトルを右側に出す */}
          {rows.map((r, i) => {
            if (r.kind === "group") return null;
            const b = bars.get(r.task.id)!;
            const w = (daysBetween(b.start, b.end) + 1) * DAY_W - 6;
            return w < 110 ? (
              <span
                key={`l-${r.task.id}`}
                className="absolute z-[2] truncate text-sm text-slate-600 dark:text-slate-400"
                style={{ left: x(b.start) + w + 10, top: HEAD_H + i * ROW_H + 10, maxWidth: 220 }}
              >
                {r.task.title}
              </span>
            ) : null;
          })}
          {rows.map((r, i) => {
            if (r.kind === "group") return null;
            const b = bars.get(r.task.id)!;
            const done = doneStatuses.has(r.task.status);
            const w = (daysBetween(b.start, b.end) + 1) * DAY_W - 6;
            return (
              <button
                key={r.task.id}
                title={`${r.task.id} ${r.task.title}\n${b.start} 〜 ${b.end}${b.inferred ? "（推定）" : ""}`}
                onClick={() => ctx.openTask(r.task.id)}
                className={cx(
                  "absolute z-[2] flex items-center overflow-hidden rounded-md px-2 text-left text-sm text-white shadow-sm",
                  b.inferred && "bar-inferred opacity-80",
                  b.conflict && "ring-2 ring-rose-500",
                  done && "opacity-50",
                )}
                style={{
                  left: x(b.start) + 3,
                  width: w,
                  top: HEAD_H + i * ROW_H + 8,
                  height: ROW_H - 16,
                  background: r.task.request ? streamColor(r.task.request) : "#64748b",
                }}
              >
                {r.task.progress ? (
                  <span className="absolute inset-y-0 left-0 bg-black/15" style={{ width: `${r.task.progress}%` }} />
                ) : null}
                {w >= 110 && <span className="relative truncate">{r.task.title}</span>}
              </button>
            );
          })}

          <svg className="pointer-events-none absolute inset-0 z-[3]" width={span * DAY_W} height={HEAD_H + rows.length * ROW_H}>
            <defs>
              {Object.entries(EDGE_STYLES).map(([t, s]) => (
                <marker key={t} id={`arrow-${t}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill={s.color} />
                </marker>
              ))}
            </defs>
            {edges.map((e) => {
              const a = bars.get(e.from)!;
              const b = bars.get(e.to)!;
              const st = EDGE_STYLES[e.type]!;
              // depends_on: 依存先の終わり → 自分の始まり。その他は中央同士
              const x1 = e.type === "depends_on" ? x(a.end) + DAY_W - 3 : x(a.start) + ((daysBetween(a.start, a.end) + 1) * DAY_W) / 2;
              const y1 = HEAD_H + rowIndex.get(e.from)! * ROW_H + ROW_H / 2;
              const x2 = e.type === "depends_on" ? x(b.start) + 3 : x(b.start) + ((daysBetween(b.start, b.end) + 1) * DAY_W) / 2;
              const y2 = HEAD_H + rowIndex.get(e.to)! * ROW_H + ROW_H / 2;
              const mid = Math.max(x1 + 10, Math.min(x2 - 10, (x1 + x2) / 2));
              return (
                <path
                  key={`${e.from}-${e.to}-${e.type}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={st.color}
                  strokeWidth={1.6}
                  strokeDasharray={st.dash}
                  markerEnd={`url(#arrow-${e.type})`}
                  opacity={e.origin === "ai" || e.origin === "preflight" ? 0.65 : 0.9}
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
