import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type RequestDetail } from "./api.ts";
import { useAppData } from "./appData.tsx";

/** 開いている要望のデータ（要望・タスク・Preflight の履歴・関係）。全体の変更通知で読み直す */
export interface RequestData extends RequestDetail {
  reload: () => void;
}

const Ctx = createContext<RequestData | undefined>(undefined);

export function RequestDataProvider({ requestId, children, fallback }: { requestId: string; children: ReactNode; fallback: ReactNode }) {
  const { tick } = useAppData();
  const [data, setData] = useState<RequestDetail | null>();

  const reload = useCallback(async () => {
    try {
      setData(await api.request(requestId));
    } catch {
      setData(null);
    }
  }, [requestId]);

  useEffect(() => {
    void reload();
  }, [reload, tick]);

  if (data === undefined) return <div className="p-8 text-slate-500">Loading…</div>;
  if (data === null) return <>{fallback}</>;
  return <Ctx.Provider value={{ ...data, reload }}>{children}</Ctx.Provider>;
}

export function useRequestData(): RequestData {
  const v = useContext(Ctx);
  if (!v) throw new Error("RequestDataProvider の外で useRequestData が呼ばれました");
  return v;
}
