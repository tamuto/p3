import { useState } from "react";
import type { Task } from "../../shared/types.ts";
import type { AppCtx } from "../App.tsx";
import { Badge, cx, Id } from "../components/ui.tsx";
import { api, ApiError } from "../lib/api.ts";
import { streamColor } from "../lib/colors.ts";

export function Kanban({ ctx }: { ctx: AppCtx }) {
  const { statuses } = ctx.info.project;
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneIds = new Set(ctx.tasks.filter((t) => statuses.find((s) => s.id === t.status)?.done).map((t) => t.id));
  const tasks = ctx.stream ? ctx.tasks.filter((t) => t.request === ctx.stream) : ctx.tasks;

  // 逆方向のエッジ（自分に依存しているもの）はカードに件数だけ出す
  const blockedBy = (t: Task) => t.relations.filter((r) => r.type === "depends_on" && r.target.startsWith("TASK") && !doneIds.has(r.target));
  const dependents = (id: string) => ctx.tasks.filter((t) => t.relations.some((r) => r.type === "depends_on" && r.target === id)).length;

  async function move(id: string, status: string) {
    const t = ctx.tasks.find((x) => x.id === id);
    if (!t || t.status === status) return;
    try {
      await api.patchTask(id, { status, rev: t.rev });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? `${id} は他で更新されました。最新を読み込みました。` : String(e));
    }
    ctx.reload();
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
                      onClick={() => ctx.openTask(t.id)}
                      className={cx(
                        "cursor-pointer rounded-md border-l-4 bg-white p-3 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md dark:bg-slate-800 dark:ring-slate-700",
                        dragId === t.id && "opacity-50",
                      )}
                      style={{ borderLeftColor: t.request ? streamColor(t.request) : "transparent" }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Id id={t.id} />
                        {t.request && <span className="truncate font-mono text-sm text-slate-400">{t.request}</span>}
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
                      {(t.estimate !== undefined || t.assignee || (t.progress ?? 0) > 0) && (
                        <div className="mt-2 flex items-center gap-3 text-sm text-slate-500">
                          {t.estimate !== undefined && <span>{t.estimate}人日</span>}
                          {t.assignee && <span>@{t.assignee}</span>}
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
