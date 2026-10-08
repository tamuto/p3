import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Request, Task } from "../../shared/types.ts";
import { api, type ProjectInfo } from "./api.ts";
import { useServerEvents } from "./live.ts";

/** 画面全体で共有するデータ。ファイルが正なので、サーバからの変更通知（SSE）で読み直す */
export interface AppData {
  info: ProjectInfo;
  tasks: Task[];
  requests: Request[];
  reload: () => void;
  /** 変更通知を受けた回数（子ビューの再取得トリガ） */
  tick: number;
}

const Ctx = createContext<AppData | undefined>(undefined);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ProjectInfo>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
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

  // 外部（CLI・AI・エディタ）からのファイル変更も含めて画面へ反映。連続する変更はまとめる
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents((e) => {
    if (e.type !== "changed") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void reload();
      setTick((n) => n + 1);
    }, 120);
  });

  if (!info) return <div className="p-8 text-slate-500">Loading…</div>;
  return <Ctx.Provider value={{ info, tasks, requests, reload, tick }}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppDataProvider の外で useAppData が呼ばれました");
  return v;
}
