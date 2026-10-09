import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { localToday } from "../../shared/dates.ts";
import type { RequestProgress, TaskMark } from "../../shared/types.ts";
import { Hint, Picker } from "../components/Hint.tsx";
import { DoingMark, DoneMark, Flag, TodoMark } from "../components/Marks.tsx";
import { RequestStatusBadge } from "../components/RequestStatus.tsx";
import { TaskDrawer } from "../components/TaskDrawer.tsx";
import { buttonCls, cx, Empty } from "../components/ui.tsx";
import { useAppCtx } from "../lib/appCtx.ts";
import { RequestDataProvider, useRequestData } from "../lib/requestData.tsx";
import { CLOSED_STATUSES, matchesShow, parseShow, SHOW_OPTIONS, type Show } from "../lib/requestFilter.ts";
import { optionalString } from "../lib/search.ts";
import { addDays, bucketStart, daysBetween, groupMarks, PX_PER_DAY, ticks, timeRange, visibleRows, ZOOMS, type Zoom } from "../lib/timeline.ts";


/**
 * 進捗: 左に要望、右にスケジュール。
 *   完了 ○ / 済み ✓（完了にした日）、作業中 ◐（作業中にした日）、未着手 □（今日の右に残りの数）
 *   要望の期限 ⚑、マイルストーン ◆ と縦の破線、今日は縦の線
 * 期間に上限はなく、見えている範囲だけを描く（仮想スクロール）。ズーム（日 / 週 / 月）で幅を変える。
 */
export const Route = createFileRoute("/")({
  validateSearch: (s: Record<string, unknown>): { show?: Show; tag?: string; task?: string; zoom?: Zoom } => ({
    show: parseShow(s.show),
    tag: optionalString(s.tag),
    /** 詳細を開いているタスク（<要望ID>/T003） */
    task: optionalString(s.task),
    zoom: s.zoom === "week" || s.zoom === "month" ? s.zoom : undefined,
  }),
  component: ProgressPage,
});

const ROW_H = 52;
const HEAD_H = 64;
const LEFT_W = 380;
/** 見えている範囲の外にも少し余分に描く（スクロールしたとき端が欠けないように） */
const OVERSCAN_PX = 300;
const ZOOM_LABEL: Record<Zoom, string> = { day: "日", week: "週", month: "月" };

/** ISO 日時 → ローカルの日付 */
const dateOf = (iso: string) => localToday(new Date(iso));

type MarkKind = "checked" | "done" | "doing";

function ProgressPage() {
  const ctx = useAppCtx();
  const { show = "open", tag, task, zoom = "day" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const openTask = useCallback((ref: string) => void navigate({ search: (prev) => ({ ...prev, task: ref }) }), [navigate]);
  const closeTask = () => void navigate({ search: (prev) => ({ ...prev, task: undefined }) });
  const { milestones } = ctx.info.project;
  const today = localToday();
  const tags = [...new Set(ctx.requests.flatMap((p) => p.request.tags))].sort();

  // マイルストーンの順 → 期限の順。完了・見送りは既定で隠す（対応済は確認待ちなので出す）
  const rows = useMemo(() => {
    const order = (p: RequestProgress) => {
      const i = milestones.findIndex((m) => m.id === p.request.milestone);
      return [i < 0 ? milestones.length : i, p.request.due ?? "9999"] as const;
    };
    return ctx.requests
      .filter((p) => matchesShow(p.request.status, show))
      .filter((p) => !tag || p.request.tags.includes(tag))
      .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1].localeCompare(order(b)[1]));
  }, [ctx.requests, milestones, show, tag]);

  // 描く期間: データのある全期間（上限なし）
  const range = useMemo(() => {
    const dates = [
      ...rows.flatMap((p) => [
        dateOf(p.request.createdAt),
        p.request.due,
        ...p.tasks.flatMap((x) => [x.startedAt && dateOf(x.startedAt), x.doneAt && dateOf(x.doneAt)]),
      ]),
      ...milestones.map((m) => m.due),
    ].filter((d): d is string => !!d);
    return timeRange(dates, today, zoom);
  }, [rows, milestones, today, zoom]);
  const px = PX_PER_DAY[zoom];
  const x = useCallback((d: string) => daysBetween(range.from, d) * px, [range.from, px]);

  // 仮想スクロール: スクロール位置と大きさを見て、見えている範囲だけを描く
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, top: 0, width: 1200, height: 800 });
  const hasRows = rows.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setView({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [hasRows]);
  // データの期間が画面より短いときは、画面の右端まで日付を描く（何も無い帯を作らない）
  const shown = { from: range.from, to: [range.to, addDays(range.from, Math.ceil((view.width - LEFT_W) / px))].sort().at(-1)! };
  const width = (daysBetween(shown.from, shown.to) + 1) * px;
  const viewFrom = view.left - OVERSCAN_PX;
  const viewTo = view.left + view.width - LEFT_W + OVERSCAN_PX;
  const inView = useCallback((left: number, w = 0) => left + w >= viewFrom && left <= viewTo, [viewFrom, viewTo]);
  const { first, last } = visibleRows(view.top, view.height, HEAD_H, ROW_H, rows.length);

  // 今日へスクロール（最初に開いたとき・ボタン）。ズームを変えたら、画面の中央にあった日付を中央に保つ
  const scrollToDate = useCallback(
    (d: string, at = 0.4) => {
      const el = scroller.current;
      if (el) el.scrollLeft = Math.max(0, x(d) - (el.clientWidth - LEFT_W) * at);
    },
    [x],
  );
  const centerDate = useRef<string | null>(null);
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (!scroller.current) return;
    if (!initialized.current) {
      initialized.current = true;
      scrollToDate(today);
    } else if (centerDate.current) {
      scrollToDate(centerDate.current, 0.5);
      centerDate.current = null;
    }
  }, [zoom, scrollToDate, today, hasRows]);
  const changeZoom = (z: Zoom) => {
    const el = scroller.current;
    if (el) centerDate.current = addDays(range.from, Math.floor((el.scrollLeft + (el.clientWidth - LEFT_W) / 2) / px));
    void navigate({ search: (prev) => ({ ...prev, zoom: z === "day" ? undefined : z }) });
  };

  const visibleTicks = useMemo(
    () => ticks(shown, zoom, today, Math.max(0, viewFrom), viewTo),
    [shown.from, shown.to, zoom, today, viewFrom, viewTo], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const height = Math.max(HEAD_H + rows.length * ROW_H, view.height);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-bold">進捗</h1>
        <nav className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {SHOW_OPTIONS.map(([v, label]) => (
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
        <div className="flex items-center gap-2">
          <nav className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" aria-label="ズーム">
            {ZOOMS.map((z) => (
              <button
                key={z}
                onClick={() => changeZoom(z)}
                aria-pressed={zoom === z}
                className={cx("w-9 rounded-md py-0.5", zoom === z ? "bg-white shadow-sm dark:bg-slate-700" : "text-slate-500")}
              >
                {ZOOM_LABEL[z]}
              </button>
            ))}
          </nav>
          <button onClick={() => scrollToDate(today)} className={buttonCls("secondary", "py-1")}>
            今日
          </button>
        </div>
        <Legend />
      </div>

      {!hasRows ? (
        <div className="p-10">
          <Empty>
            {show === "open" ? "未完了の要望はありません。" : "該当する要望はありません。"}
            <Link to="/requests/new" className={buttonCls("ghost", "ml-2 underline")}>
              新しい要望を作る
            </Link>
          </Empty>
        </div>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-testid="schedule">
          <div className="flex" style={{ width: LEFT_W + width, height }}>
            {/* 左: 要望（見えている行だけ） */}
            <div className="sticky left-0 z-30 shrink-0 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ width: LEFT_W }}>
              <div className="sticky top-0 z-10 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ height: HEAD_H }} />
              {rows.slice(first, last).map((p, k) => (
                <RequestCell key={p.request.id} p={p} top={HEAD_H + (first + k) * ROW_H} />
              ))}
            </div>

            {/* 右: スケジュール（見えている範囲だけ） */}
            <div className="relative" style={{ width, height }}>
              <div className="sticky top-0 z-20 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" style={{ height: HEAD_H }}>
                {milestones
                  .filter((m) => m.due && inView(x(m.due)))
                  .map((m) => (
                    <span key={m.id} className="absolute top-1 -translate-x-1/2" style={{ left: x(m.due!) + px / 2 }}>
                      <Hint content={`${m.title}\n${m.due}${m.done ? "（リリース済み）" : ""}`}>
                        <span className={cx("text-sm whitespace-nowrap", m.done ? "text-slate-400" : "font-medium text-violet-600 dark:text-violet-400")}>◆ {m.id}</span>
                      </Hint>
                    </span>
                  ))}
                {visibleTicks.map((k) => (
                  <div key={k.start} className="absolute bottom-0 flex flex-col items-center pb-1 text-sm" style={{ left: k.x, width: k.width }}>
                    <span className="h-4 text-xs whitespace-nowrap text-slate-400">{k.group ?? ""}</span>
                    <span
                      className={cx(
                        "flex h-6 min-w-6 items-center justify-center rounded-full px-1 whitespace-nowrap",
                        k.today ? "bg-indigo-600 font-bold text-white" : k.weekend ? "text-slate-400" : "text-slate-600 dark:text-slate-300",
                      )}
                    >
                      {k.label}
                    </span>
                  </div>
                ))}
              </div>
              {visibleTicks
                .filter((k) => k.weekend)
                .map((k) => (
                  <div key={k.start} className="absolute bg-slate-100/70 dark:bg-slate-800/40" style={{ left: k.x, width: k.width, top: HEAD_H, bottom: 0 }} />
                ))}
              {zoom !== "day" &&
                visibleTicks.map((k) => (
                  <div key={`l${k.start}`} className="absolute border-l border-slate-100 dark:border-slate-800" style={{ left: k.x, top: HEAD_H, bottom: 0 }} />
                ))}
              {milestones
                .filter((m) => m.due && inView(x(m.due)))
                .map((m) => (
                  <div
                    key={m.id}
                    className={cx("absolute z-[1] border-l-2 border-dashed", m.done ? "border-slate-300 dark:border-slate-600" : "border-violet-400")}
                    style={{ left: x(m.due!) + px / 2 - 1, top: HEAD_H, bottom: 0 }}
                  />
                ))}
              <div className="absolute z-[2] w-0.5 bg-indigo-500" style={{ left: x(today) + px / 2 - 1, top: 0, bottom: 0 }} />
              {rows.slice(first, last).map((p, k) => (
                <RequestLane
                  key={p.request.id}
                  p={p}
                  top={HEAD_H + (first + k) * ROW_H}
                  today={today}
                  x={x}
                  px={px}
                  zoom={zoom}
                  inView={inView}
                  onOpen={openTask}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {task && <ProgressTaskDrawer ctx={ctx} taskRef={task} onClose={closeTask} />}
    </div>
  );
}

/** 進捗の画面に重ねるタスク詳細（その要望のデータを読んで、要望の画面と同じドロワーを出す） */
function ProgressTaskDrawer({ ctx, taskRef, onClose }: { ctx: ReturnType<typeof useAppCtx>; taskRef: string; onClose: () => void }) {
  const [requestId, taskId] = taskRef.split("/");
  return (
    <RequestDataProvider requestId={requestId} fallback={null}>
      <DrawerFor ctx={ctx} taskId={taskId} onClose={onClose} />
    </RequestDataProvider>
  );
}

function DrawerFor({ ctx, taskId, onClose }: { ctx: ReturnType<typeof useAppCtx>; taskId: string; onClose: () => void }) {
  const data = useRequestData();
  return <TaskDrawer ctx={ctx} data={data} id={taskId} onClose={onClose} />;
}

/** 凡例（記号だけ） */
function Legend() {
  const item = (icon: ReactNode, label: string) => (
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

function RequestCell({ p, top }: { p: RequestProgress; top: number }) {
  const r = p.request;
  return (
    <Link
      to="/requests/$requestId"
      params={{ requestId: r.id }}
      className="absolute inset-x-0 flex items-center gap-2 border-b border-slate-200 px-4 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
      style={{ top, height: ROW_H }}
    >
      <RequestStatusBadge status={r.status} />
      <Hint content={`${r.title}\n${r.id}`} className="min-w-0">
        <span className="block truncate font-medium">{r.title}</span>
      </Hint>
    </Link>
  );
}

function RequestLane({
  p,
  top,
  today,
  x,
  px,
  zoom,
  inView,
  onOpen,
}: {
  p: RequestProgress;
  top: number;
  today: string;
  x: (d: string) => number;
  px: number;
  zoom: Zoom;
  inView: (left: number, width?: number) => boolean;
  /** 印をクリックしたらタスクの詳細を開く（どの印でも同じ。まとまっていれば一覧から選ぶ） */
  onOpen: (ref: string) => void;
}) {
  const r = p.request;
  const closed = CLOSED_STATUSES.has(r.status);
  const [picker, setPicker] = useState<{ anchor: DOMRect; items: TaskMark[] } | null>(null);

  // 印を、ズームのまとまり（日 / 週 / 月）ごと・種類ごとにまとめる
  const groups = useMemo(() => {
    const marks: { date: string; kind: MarkKind; item: TaskMark }[] = [];
    for (const task of p.tasks) {
      if (task.status === "done" && task.doneAt) marks.push({ date: dateOf(task.doneAt), kind: task.checkedAt ? "checked" : "done", item: task });
      else if (task.status === "doing") marks.push({ date: task.startedAt ? dateOf(task.startedAt) : today, kind: "doing", item: task });
    }
    return groupMarks(marks, zoom);
  }, [p.tasks, zoom, today]);
  const todo = p.tasks.filter((m) => m.status === "todo");
  const overdue = !closed && !!r.due && r.due < today && p.tasks.some((m) => m.status !== "done");
  const cy = top + ROW_H / 2;
  const icon = (kind: string) => (kind === "doing" ? <DoingMark /> : <DoneMark checked={kind === "checked"} />);

  // 同じまとまりに種類の違う印が並ぶときは横にずらす（件数の丸が付くぶん広めに）
  const slot = new Map<string, number>();
  const placed = groups.map((g) => {
    const offset = slot.get(g.start) ?? 0;
    const w = g.items.length > 1 ? 30 : 18;
    slot.set(g.start, offset + w);
    return { g, left: x(g.start) + (zoom === "day" ? px / 2 - 7 : 4) + offset, w };
  });
  // 未着手の □ は今日の線の右、今日を含むまとまりの印より右に並べる（週・月のズームで重ならないように）
  const todayBucket = bucketStart(today, zoom);
  const pileLeft = Math.max(x(today) + px / 2 + 6, ...placed.filter((p) => p.g.start === todayBucket).map((p) => p.left + p.w + 2));

  return (
    <>
      {/* 行の区切り（左の一覧の線とそろえる） */}
      <div className="absolute inset-x-0 border-b border-slate-200 dark:border-slate-700" style={{ top, height: ROW_H }} />
      {r.due && inView(x(r.due)) && (
        <span className="absolute z-[4]" style={{ left: x(r.due) + px / 2 - 2, top: cy - 20 }}>
          <Hint content={`期限 ${r.due}${overdue ? "（過ぎています）" : ""}`}>
            <Flag overdue={overdue} />
          </Hint>
        </span>
      )}
      {placed.map(({ g, left }) => {
        if (!inView(left, 40)) return null;
        return (
          <span key={`${g.start}|${g.kind}`} className="absolute z-[5]" style={{ left, top: cy - 7 }}>
            <Hint content={g.items.map((m) => `${m.id} ${m.title}`).join("\n")}>
              <button
                className="relative block transition hover:scale-125"
                onClick={(e) =>
                  g.items.length === 1
                    ? onOpen(g.items[0].ref)
                    : setPicker({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items: g.items })
                }
              >
                {icon(g.kind)}
                {g.items.length > 1 && (
                  <span className="absolute -top-2 -right-2.5 rounded-full bg-slate-700 px-1 text-[10px] leading-4 text-white">{g.items.length}</span>
                )}
              </button>
            </Hint>
          </span>
        );
      })}
      {todo.length > 0 && inView(pileLeft, 120) && (
        <div
          className="absolute z-[5] flex flex-wrap content-center items-center gap-[3px]"
          style={{ left: pileLeft, top, height: ROW_H, width: Math.min(8, Math.ceil(todo.length / 2)) * 13 }}
        >
          {todo.map((m) => (
            <Hint key={m.ref} content={`${m.id} ${m.title}`}>
              <button onClick={() => onOpen(m.ref)} className="block transition hover:scale-125">
                <TodoMark />
              </button>
            </Hint>
          ))}
        </div>
      )}
      {picker && (
        <Picker
          anchor={picker.anchor}
          items={picker.items.map((m) => ({
            key: m.ref,
            label: (
              <>
                {icon(m.status === "done" ? (m.checkedAt ? "checked" : "done") : "doing")}
                <span className="font-mono text-sm text-slate-500">{m.id}</span>
                <span className="truncate">{m.title}</span>
              </>
            ),
          }))}
          onPick={(ref) => {
            setPicker(null);
            onOpen(ref);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
