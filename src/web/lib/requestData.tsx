import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type RequestDetail } from "./api.ts";
import { useAppData } from "./appData.tsx";
import { latestOnly, STALE } from "./latest.ts";
import { applyLoad, initialLoad, type LoadState } from "./requestLoad.ts";

/** 開いている要望のデータ（要望・タスク・Preflight の履歴・関係）。全体の変更通知で読み直す */
export interface RequestData extends RequestDetail {
  reload: () => void;
  /** 外で削除・アーカイブされた（表示は最後に取れた内容のまま。保存はしない） */
  gone: boolean;
  /** 取り直しに失敗した（表示は前の内容のまま） */
  loadError: string | null;
}

const Ctx = createContext<RequestData | undefined>(undefined);

/**
 * 要望ごとに作り直す（呼ぶ側で key に要望 ID を渡す）。取り直しに失敗しても、消えても、表示中の画面は外さない
 * （入力中のメモ・下書きを失わない。lib/requestLoad.ts）。
 */
export function RequestDataProvider({ requestId, children, fallback }: { requestId: string; children: ReactNode; fallback: ReactNode }) {
  const { tick } = useAppData();
  const [state, setState] = useState<LoadState<RequestDetail>>(initialLoad);
  const latest = useRef(latestOnly());

  const reload = useCallback(async () => {
    try {
      const d = await latest.current.run(() => api.request(requestId));
      if (d !== STALE) setState((s) => applyLoad(s, { ok: true, data: d }));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      setState((s) => applyLoad(s, { ok: false, status, message: (e as Error).message }));
    }
  }, [requestId]);

  useEffect(() => {
    void reload();
  }, [reload, tick]);

  const { data, gone, error } = state;
  if (data === undefined)
    return error ? (
      <div className="space-y-2 p-8">
        <p className="text-rose-600">読み込めませんでした: {error}</p>
        <button className="underline" onClick={() => void reload()}>
          もう一度読み込む
        </button>
      </div>
    ) : (
      <div className="p-8 text-slate-500">Loading…</div>
    );
  if (data === null) return <>{fallback}</>;
  return <Ctx.Provider value={{ ...data, reload, gone, loadError: error }}>{children}</Ctx.Provider>;
}

export function useRequestData(): RequestData {
  const v = useContext(Ctx);
  if (!v) throw new Error("RequestDataProvider の外で useRequestData が呼ばれました");
  return v;
}
