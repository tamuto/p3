import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { REQUEST_STATUSES, type RequestStatus } from "../../../shared/types.ts";
import { REQUEST_STATUS_LABEL } from "../../components/RequestStatus.tsx";
import { TaskDrawer } from "../../components/TaskDrawer.tsx";
import { Badge, Empty } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { useAppCtx } from "../../lib/appCtx.ts";
import { RequestDataProvider, useRequestData } from "../../lib/requestData.tsx";
import { optionalString } from "../../lib/search.ts";

/**
 * 要望の枠: 見出し・タブ（概要と Preflight / かんばん）・タスク詳細（?task=T003）。
 * 要望は作業の単位で、ここから下はすべてこの要望の中だけを扱う。
 */
export const Route = createFileRoute("/requests/$requestId")({
  validateSearch: (s: Record<string, unknown>): { task?: string } => ({ task: optionalString(s.task) }),
  component: RequestLayout,
});

function RequestLayout() {
  const { requestId } = Route.useParams();
  return (
    <RequestDataProvider
      requestId={requestId}
      fallback={
        <div className="p-10">
          <Empty>{requestId} は見つかりません</Empty>
        </div>
      }
    >
      <RequestFrame />
    </RequestDataProvider>
  );
}

const TABS = [
  { to: "/requests/$requestId", label: "概要・Preflight", exact: true },
  { to: "/requests/$requestId/board", label: "かんばん", exact: false },
] as const;

function RequestFrame() {
  const ctx = useAppCtx();
  const data = useRequestData();
  const { request, tasks } = data;
  const { task } = Route.useSearch();
  const navigate = useNavigate();
  const done = new Set(ctx.info.project.statuses.filter((s) => s.done).map((s) => s.id));
  const finished = tasks.filter((t) => done.has(t.status)).length;

  async function setStatus(status: RequestStatus) {
    await api.patchRequest(request.id, { status, rev: request.rev });
    ctx.reload();
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 pt-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-slate-500">{request.id}</span>
          <select
            value={request.status}
            onChange={(e) => void setStatus(e.target.value as RequestStatus)}
            title="要望のステータス"
            className="rounded-md bg-white px-2 py-0.5 text-sm ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
          >
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REQUEST_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {request.workstream && (
            <Badge tone="emerald" title={request.workstream.worktree}>
              ⎇ {request.workstream.branch}
            </Badge>
          )}
          {tasks.length > 0 && (
            <span className="text-sm text-slate-500">
              タスク {finished}/{tasks.length} 完了
            </span>
          )}
        </div>
        <h1 className="mt-1 text-xl font-bold">{request.title}</h1>
        <nav className="mt-3 flex gap-1">
          {TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              params={{ requestId: request.id }}
              activeOptions={{ exact: t.exact, includeSearch: false }}
              className="-mb-px border-b-2 px-3 py-2 font-medium"
              activeProps={{ className: "border-indigo-600 text-indigo-700 dark:text-indigo-300" }}
              inactiveProps={{ className: "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>

      {task && (
        <TaskDrawer
          ctx={ctx}
          data={data}
          id={task}
          onClose={() => void navigate({ to: ".", search: (prev) => ({ ...prev, task: undefined }) })}
        />
      )}
    </div>
  );
}
