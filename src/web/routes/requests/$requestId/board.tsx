import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { Task } from "../../../../shared/types.ts";
import { Badge, cx, Empty, Id } from "../../../components/ui.tsx";
import { api, ApiError } from "../../../lib/api.ts";
import { useAppCtx } from "../../../lib/appCtx.ts";
import { useRequestData } from "../../../lib/requestData.tsx";

/**
 * 要望のかんばん。列は少なくてよい（既定: 未着手 / 作業中 / 完了）。
 * 完了は「AI の処理が終わり、成果物（PR・MR・ドキュメント）が出た」状態で、レビューは成果物の側で行う。
 */
export const Route = createFileRoute("/requests/$requestId/board")({
  component: BoardPage,
});

function BoardPage() {
  const ctx = useAppCtx();
  const { tasks, reload } = useRequestData();
  const { statuses } = ctx.info.project;
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneIds = new Set(tasks.filter((t) => statuses.find((s) => s.id === t.status)?.done).map((t) => t.id));

  // 同じ要望の中の依存だけを見る（別の要望への依存はタスク詳細で確認する）
  const blockedBy = (t: Task) => t.relations.filter((r) => r.type === "depends_on" && !r.target.includes("/") && !doneIds.has(r.target));
  const dependents = (id: string) => tasks.filter((t) => t.relations.some((r) => r.type === "depends_on" && r.target === id)).length;

  async function move(id: string, status: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    try {
      await api.patchTask(t.ref, { status, rev: t.rev });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${id} は他で更新されました。最新を読み込みました。` : String(e));
    }
    reload();
    ctx.reload();
  }

  if (!tasks.length) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <Empty>タスクはまだありません。概要のタブから Preflight を実行してタスク化するか、CLI の `pcube new` で追加してください。</Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {error && <div className="bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">{error}</div>}
      <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-5">
        {statuses.map((s) => {
          const col = tasks.filter((t) => t.status === s.id);
          return (
            <div
              key={s.id}
              onDragOver={(e) => (e.preventDefault(), setOver(s.id))}
              onDragLeave={() => setOver(null)}
              onDrop={() => {
                if (dragId) void move(dragId, s.id);
                setDragId(null);
                setOver(null);
              }}
              className={cx(
                "flex w-80 shrink-0 flex-col rounded-lg bg-slate-100 dark:bg-slate-900",
                over === s.id && "ring-2 ring-indigo-400",
              )}
            >
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="font-semibold">{s.label}</span>
                <span className="text-sm text-slate-500">{col.length}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3">
                {col.map((t) => {
                  const blocking = blockedBy(t);
                  const deps = dependents(t.id);
                  const aiRels = t.relations.filter((r) => r.origin === "ai" || r.origin === "preflight").length;
                  return (
                    <article
                      key={t.id}
                      draggable
                      onDragStart={() => setDragId(t.id)}
                      onClick={() => ctx.open(t.ref)}
                      className={cx(
                        "cursor-pointer rounded-md bg-white p-3 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md dark:bg-slate-800 dark:ring-slate-700",
                        dragId === t.id && "opacity-50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Id id={t.id} />
                        {t.updatedBy && <span className="truncate text-sm text-slate-400">{t.updatedBy}</span>}
                      </div>
                      <p className="mt-1 leading-snug font-medium">{t.title}</p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {blocking.length > 0 && !s.done && (
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
                      {t.outputs.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {t.outputs.map((o) => (
                            <li key={o} className="truncate text-sm">
                              {/^https?:/.test(o) ? (
                                <a href={o} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-indigo-600 hover:underline dark:text-indigo-400">
                                  ↗ {o.replace(/^https?:\/\/(www\.)?/, "")}
                                </a>
                              ) : (
                                <span className="font-mono text-slate-500">{o}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {(t.estimate !== undefined || (t.progress ?? 0) > 0) && (
                        <div className="mt-2 flex items-center gap-3 text-sm text-slate-500">
                          {t.estimate !== undefined && <span>{t.estimate}人日</span>}
                          {(t.progress ?? 0) > 0 && !s.done && (
                            <span className="ml-auto flex items-center gap-1.5">
                              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                                <span className="block h-full bg-indigo-500" style={{ width: `${t.progress}%` }} />
                              </span>
                              {t.progress}%
                            </span>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
