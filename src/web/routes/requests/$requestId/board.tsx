import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { TASK_STATUS_LABEL, type Task, type TaskStatus } from "../../../../shared/types.ts";
import { DoingMark, DoneMark, TodoMark } from "../../../components/Marks.tsx";
import { Outputs } from "../../../components/Outputs.tsx";
import { useAppData } from "../../../lib/appData.tsx";
import { Badge, cx, Empty, Id } from "../../../components/ui.tsx";
import { api, failureOf } from "../../../lib/api.ts";
import { markText, warningText } from "../../../lib/supersede.ts";
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
 */
export const Route = createFileRoute("/requests/$requestId/board")({
  component: BoardPage,
});

function BoardPage() {
  const ctx = useAppCtx();
  const { request, tasks, reload, superseded } = useRequestData();
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const checked = tasks.filter((t) => t.status === "done" && t.checkedAt).length;

  async function patch(t: Task, p: { status?: TaskStatus; checked?: boolean }) {
    try {
      const res = await api.patchTask(t.ref, { ...p, rev: t.rev });
      // 置き換えられたタスクを作業中にしたときは、移したうえで知らせる
      const w = warningText(res);
      setError(w ? `警告: ${w}` : null);
    } catch (e) {
      setError(failureOf(e) === "rev_conflict" ? `${t.id} は他で更新されました。最新を読み込みました。` : String(e));
    }
    reload();
    ctx.reload();
  }
  const move = (id: string, status: TaskStatus) => {
    const t = tasks.find((x) => x.id === id);
    if (t && t.status !== status) void patch(t, { status });
  };

  if (!tasks.length) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Empty>タスクはまだありません。概要のタブから Preflight を実行してタスク化するか、CLI の `p3 new` で追加してください。</Empty>
      </div>
    );
  }

  const pane = (s: TaskStatus, aside?: ReactNode) => {
    // 完了は、人が済みにしたものを出さない（対応済みのタブで見る）
    const items = tasks.filter((t) => t.status === s && !t.checkedAt);
    return (
      <Pane
        status={s}
        count={items.length}
        aside={aside}
        onDrop={() => {
          if (dragId) move(dragId, s);
          setDragId(null);
        }}
      >
        {items.map((t) => (
          <Card
            key={t.id}
            task={t}
            done={s === "done"}
            tasks={tasks}
            doneIds={doneIds}
            replaced={markText(superseded[t.id], request.id)}
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
      {/* 広い画面は 未着手・完了 を横に並べ、その下に作業中（V 字）。狭い画面は縦に積んでページごとスクロールする */}
      <div className="grid gap-4 p-5 md:min-h-0 md:flex-1 md:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid gap-4 md:min-h-0 md:grid-cols-2">
          {pane("todo")}
          {pane(
            "done",
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
          )}
        </div>
        {pane("doing")}
      </div>
    </div>
  );
}

const MARK: Record<TaskStatus, ReactNode> = { todo: <TodoMark />, doing: <DoingMark />, done: <DoneMark checked={false} /> };

function Pane({
  status,
  count,
  aside,
  onDrop,
  children,
}: {
  status: TaskStatus;
  count: number;
  aside?: ReactNode;
  onDrop: () => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={() => (setOver(false), onDrop())}
      className={cx("flex min-h-0 min-w-0 flex-col rounded-lg bg-slate-100 dark:bg-slate-900", over && "ring-2 ring-indigo-400")}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {MARK[status]}
        <span className="font-semibold">{TASK_STATUS_LABEL[status]}</span>
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
  replaced,
  dragging,
  onDragStart,
  onOpen,
  onCheck,
}: {
  task: Task;
  done: boolean;
  tasks: Task[];
  doneIds: Set<string>;
  /** 置き換えられていれば印の文言 */
  replaced: string;
  dragging: boolean;
  onDragStart: () => void;
  onOpen: () => void;
  onCheck: () => void;
}) {
  // 同じ要望の中の依存だけを見る（別の要望への依存はタスク詳細で確認する）
  const blocking = t.relations.filter((r) => r.type === "depends_on" && !r.target.includes("/") && !doneIds.has(r.target));
  const deps = tasks.filter((x) => x.relations.some((r) => r.type === "depends_on" && r.target === t.id)).length;
  const aiRels = t.relations.filter((r) => r.origin === "ai" || r.origin === "preflight").length;
  const { info } = useAppData();
  // 共有の参照先があるときだけ作業先を出す
  const repo = info.project.repos.length ? t.repo : undefined;
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
        <span className="flex min-w-0 items-center gap-2">
          <Id id={t.id} />
          {repo !== undefined && (
            <Badge tone={repo ? "emerald" : "slate"} className="max-w-full" title="作業先">
              <span className="truncate">{repo ?? "作業先なし"}</span>
            </Badge>
          )}
        </span>
        {t.updatedBy && <span className="truncate text-sm text-slate-400">{t.updatedBy}</span>}
      </div>
      {/* 題はパスなど区切りの無い長い文字も多いので、どこでも折り返してカードに収める */}
      <p className="mt-1 leading-snug font-medium wrap-anywhere">{t.title}</p>
      {(blocking.length > 0 || deps > 0 || aiRels > 0 || t.labels.length > 0 || replaced) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {replaced && !done && (
            <Badge tone="rose" title="新しいタスクに置き換えられています。着手する前に確かめてください">
              {replaced}
            </Badge>
          )}
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
      {(t.outputs.length > 0 || !!t.repoOutputs?.length) && <Outputs outputs={t.outputs} repoOutputs={t.repoOutputs} compact />}
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
