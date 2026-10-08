import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RequestProgress } from "../../shared/types.ts";
import { api, type ProjectInfo } from "./api.ts";
import { useServerEvents } from "./live.ts";

/** 画面全体で共有するデータ（設定と、要望の一覧・進捗）。ファイルが正なので、変更通知（SSE）で読み直す */
export interface AppData {
  info: ProjectInfo;
  requests: RequestProgress[];
  reload: () => void;
  /** 変更通知を受けた回数（要望ごとのデータを読み直すきっかけ） */
  tick: number;
}

const Ctx = createContext<AppData | undefined>(undefined);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ProjectInfo>();
  const [requests, setRequests] = useState<RequestProgress[]>([]);
  const [tick, setTick] = useState(0);

  const reload = useCallback(async () => {
    const [i, r] = await Promise.all([api.project(), api.requests()]);
    setInfo(i);
    setRequests(r);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 外部（CLI・AI・エディタ・git pull）からのファイル変更も含めて画面へ反映。連続する変更はまとめる
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents((e) => {
    if (e.type !== "changed") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void reload(), 120);
  });

  if (!info) return <div className="p-8 text-slate-500">Loading…</div>;
  return <Ctx.Provider value={{ info, requests, reload, tick }}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppDataProvider の外で useAppData が呼ばれました");
  return v;
}
