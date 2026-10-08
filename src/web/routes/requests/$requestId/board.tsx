import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import type { StatusDef as Status, Task } from "../../../../shared/types.ts";
import { DoingMark, DoneMark, TodoMark } from "../../../components/Marks.tsx";
import { Outputs } from "../../../components/Outputs.tsx";
import { Badge, cx, Empty, Id } from "../../../components/ui.tsx";
import { api, ApiError } from "../../../lib/api.ts";
import { useAppCtx } from "../../../lib/appCtx.ts";
import { fmtTime } from "../../../lib/format.ts";
import { useRequestData } from "../../../lib/requestData.tsx";

/**
 * 要望のタスクボード（V 字）。
 *
 *   ┌ 未着手 ──────┐ ┌ 完了 ────────┐
 *   │              │ │（済みは消える）│
 *   └──────┐       │ │       ┌──────┘
 *          └ 作業中 ┴─┴───────┘
 *
 * 未着手から下りて作業中、上がって完了。完了に人が「済み」を付けると消えるので、画面に残るのは要対応のものだけ。
 * 済みのタスクは「対応済み」のタブで一覧する。
 * 列の設定が増えても、最初の列を左上、完了扱いの列を右上、残りを下段に並べる。
 */
export const Route = createFileRoute("/requests/$requestId/board")({
  component: BoardPage,
});

function BoardPage() {
  const ctx = useAppCtx();
  const { request, tasks, reload } = useRequestData();
  const { statuses } = ctx.info.project;
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneIds = new Set(tasks.filter((t) => statuses.find((s) => s.id === t.status)?.done).map((t) => t.id));

  const first = statuses[0];
  const doneStatuses = statuses.filter((s) => s.done && s !== first);
  const middle = statuses.filter((s) => s !== first && !s.done);
  const checked = tasks.filter((t) => doneIds.has(t.id) && t.checkedAt).length;

  async function patch(t: Task, p: { status?: string; checked?: boolean }) {
    try {
      await api.patchTask(t.ref, { ...p, rev: t.rev });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${t.id} は他で更新されました。最新を読み込みました。` : String(e));
    }
    reload();
    ctx.reload();
  }
  const move = (id: string, status: string) => {
    const t = tasks.find((x) => x.id === id);
    if (t && t.status !== status) void patch(t, { status });
  };

  if (!tasks.length) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Empty>タスクはまだありません。概要のタブから Preflight を実行してタスク化するか、CLI の `pcube new` で追加してください。</Empty>
      </div>
    );
  }

  const pane = (s: Status, kind: keyof typeof MARK, extra?: { aside?: ReactNode; className?: string }) => {
    const items = tasks.filter((t) => t.status === s.id && !(s.done && t.checkedAt));
    return (
      <Pane
        key={s.id}
        status={s}
        kind={kind}
        count={items.length}
        className={extra?.className}
        aside={extra?.aside}
        onDrop={() => {
          if (dragId) move(dragId, s.id);
          setDragId(null);
        }}
      >
        {items.map((t) => (
          <Card
            key={t.id}
            task={t}
            done={!!s.done}
            tasks={tasks}
            doneIds={doneIds}
            dragging={dragId === t.id}
            onDragStart={() => setDragId(t.id)}
            onOpen={() => ctx.open(t.ref)}
            onCheck={() => void patch(t, { checked: true })}
          />
        ))}
      </Pane>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {error && <div className="bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">{error}</div>}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] gap-4 p-5">
        <div className="grid min-h-0 grid-cols-2 gap-4">
          {pane(first, "todo")}
          <div className="flex min-h-0 gap-4">
            {doneStatuses.map((s) =>
              pane(s, "done", {
                className: "flex-1",
                aside:
                  checked > 0 ? (
                    <Link
                      to="/requests/$requestId/done"
                      params={{ requestId: request.id }}
                      className="text-sm text-slate-500 hover:text-indigo-600 hover:underline"
                      title="済みにしたタスクの一覧"
                    >
                      済み {checked} 件 →
                    </Link>
                  ) : null,
              }),
            )}
          </div>
        </div>
        <div className="flex min-h-0 gap-4">{middle.map((s) => pane(s, "doing", { className: "flex-1" }))}</div>
      </div>
    </div>
  );
}

const MARK = { todo: <TodoMark />, doing: <DoingMark />, done: <DoneMark checked={false} /> };

function Pane({
  status,
  kind,
  count,
  aside,
  className,
  onDrop,
  children,
}: {
  status: Status;
  kind: keyof typeof MARK;
  count: number;
  aside?: ReactNode;
  className?: string;
  onDrop: () => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={() => (setOver(false), onDrop())}
      className={cx("flex min-h-0 min-w-0 flex-col rounded-lg bg-slate-100 dark:bg-slate-900", over && "ring-2 ring-indigo-400", className)}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {MARK[kind]}
        <span className="font-semibold">{status.label}</span>
        <span className="text-sm text-slate-500">{count}</span>
        <span className="ml-auto">{aside}</span>
      </header>
      <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2 overflow-y-auto px-2 pb-3">{children}</div>
    </section>
  );
}

function Card({
  task: t,
  done,
  tasks,
  doneIds,
  dragging,
  onDragStart,
  onOpen,
  onCheck,
}: {
  task: Task;
  done: boolean;
  tasks: Task[];
  doneIds: Set<string>;
  dragging: boolean;
  onDragStart: () => void;
  onOpen: () => void;
  onCheck: () => void;
}) {
  // 同じ要望の中の依存だけを見る（別の要望への依存はタスク詳細で確認する）
  const blocking = t.relations.filter((r) => r.type === "depends_on" && !r.target.includes("/") && !doneIds.has(r.target));
  const deps = tasks.filter((x) => x.relations.some((r) => r.type === "depends_on" && r.target === t.id)).length;
  const aiRels = t.relations.filter((r) => r.origin === "ai" || r.origin === "preflight").length;
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className={cx(
        "cursor-pointer rounded-md bg-white p-3 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md dark:bg-slate-800 dark:ring-slate-700",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Id id={t.id} />
        {t.updatedBy && <span className="truncate text-sm text-slate-400">{t.updatedBy}</span>}
      </div>
      <p className="mt-1 leading-snug font-medium">{t.title}</p>
      {(blocking.length > 0 || deps > 0 || aiRels > 0 || t.labels.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {blocking.length > 0 && !done && (
            <Badge tone="amber" title={blocking.map((b) => b.target).join(", ")}>
              待ち {blocking.length}
            </Badge>
          )}
          {deps > 0 && <Badge tone="violet" title="このタスクに依存しているタスク数">後続 {deps}</Badge>}
          {aiRels > 0 && <Badge tone="indigo" title="AI / preflight が張った関係">AI関係 {aiRels}</Badge>}
          {t.labels.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
        </div>
      )}
      {t.outputs.length > 0 && <Outputs outputs={t.outputs} />}
      <div className="mt-2 flex items-center gap-2">
        {(t.doneAt || t.startedAt) && (
          <span className="text-sm text-slate-400" title="ステータスを変えたときに記録された日時">
            {t.doneAt ? `完了 ${fmtTime(t.doneAt)}` : `作業中にした ${fmtTime(t.startedAt)}`}
          </span>
        )}
        {done && (
          <button
            onClick={(e) => (e.stopPropagation(), onCheck())}
            title="成果物を確認したら済みにする（このボードから消え、対応済みの一覧に移る）"
            className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:ring-emerald-800 dark:hover:bg-emerald-950"
          >
            ✓ 済み
          </button>
        )}
      </div>
    </article>
  );
}
