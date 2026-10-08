import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Request, Task } from "../shared/types.ts";
import { TaskDrawer } from "./components/TaskDrawer.tsx";
import { cx } from "./components/ui.tsx";
import { api, type ProjectInfo } from "./lib/api.ts";
import { useServerEvents } from "./lib/live.ts";
import { Gantt } from "./views/Gantt.tsx";
import { Kanban } from "./views/Kanban.tsx";
import { Preflight } from "./views/Preflight.tsx";
import { Settings } from "./views/Settings.tsx";

export type View = "board" | "schedule" | "preflight" | "settings";

export interface AppCtx {
  info: ProjectInfo;
  tasks: Task[];
  requests: Request[];
  /** 作業ツリー（要望）での絞り込み */
  stream: string | null;
  openTask: (id: string) => void;
  openRequest: (id: string) => void;
  reload: () => void;
  /** SSE で届いた最終変更時刻（子ビューの再取得トリガ） */
  tick: number;
}

const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: "preflight", label: "Preflight", hint: "要望の評価とタスク化" },
  { id: "board", label: "かんばん", hint: "ステータス別" },
  { id: "schedule", label: "スケジュール", hint: "依存を考慮したガント" },
  { id: "settings", label: "設定", hint: "プロジェクト名・メンバー・ドキュメント" },
];

export function App() {
  const [info, setInfo] = useState<ProjectInfo>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [view, setView] = useState<View>(() => (location.hash.slice(1) as View) || "board");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [stream, setStream] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    const [i, t, r] = await Promise.all([api.project(), api.tasks(), api.requests()]);
    setInfo(i);
    setTasks(t);
    setRequests(r);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    location.hash = view;
  }, [view]);
  useEffect(() => {
    const onHash = () => setView((location.hash.slice(1) as View) || "board");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 外部（AI・エディタ）からのファイル変更も含めて画面へ反映。連続する変更はまとめる
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents((e) => {
    if (e.type !== "changed") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void reload();
      setTick((n) => n + 1);
    }, 120);
  });

  const ctx = useMemo<AppCtx | undefined>(
    () =>
      info && {
        info,
        tasks,
        requests,
        stream,
        tick,
        reload,
        openTask: setTaskId,
        openRequest: (id) => {
          setRequestId(id);
          setView("preflight");
        },
      },
    [info, tasks, requests, stream, tick, reload],
  );

  if (!ctx) return <div className="p-8 text-slate-500">Loading…</div>;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-slate-200 bg-white px-5 py-2.5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold tracking-tight text-indigo-600 dark:text-indigo-400">pcube</span>
          <span className="font-medium">{ctx.info.project.name}</span>
        </div>
        <nav className="flex gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              title={v.hint}
              onClick={() => setView(v.id)}
              className={cx(
                "rounded-md px-3 py-1.5 font-medium transition",
                view === v.id
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
              )}
            >
              {v.label}
            </button>
          ))}
        </nav>
        {(view === "board" || view === "schedule") && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-slate-500">作業ツリー</span>
            <select
              value={stream ?? ""}
              onChange={(e) => setStream(e.target.value || null)}
              className="max-w-xs rounded-md bg-white px-2 py-1 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
            >
              <option value="">すべて</option>
              {requests
                .filter((r) => r.status === "accepted")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} {r.title}
                  </option>
                ))}
            </select>
          </div>
        )}
        {Object.keys(ctx.info.errors).length > 0 && (
          <span className="ml-2 text-sm text-rose-600" title={JSON.stringify(ctx.info.errors, null, 2)}>
            ⚠ 読めないファイル {Object.keys(ctx.info.errors).length} 件
          </span>
        )}
      </header>

      {!ctx.info.project.description && view !== "settings" && (
        <div className="flex items-center gap-3 bg-amber-50 px-5 py-2 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          プロジェクトの説明がまだありません。Preflight の前提になるので設定してください。
          <button className="font-medium underline" onClick={() => setView("settings")}>
            設定を開く
          </button>
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto">
        {view === "board" && <Kanban ctx={ctx} />}
        {view === "schedule" && <Gantt ctx={ctx} />}
        {view === "preflight" && <Preflight ctx={ctx} selected={requestId} onSelect={setRequestId} />}
        {view === "settings" && <Settings ctx={ctx} />}
      </main>

      {taskId && <TaskDrawer ctx={ctx} id={taskId} onClose={() => setTaskId(null)} />}
    </div>
  );
}
