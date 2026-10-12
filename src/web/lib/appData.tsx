import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RequestProgress } from "../../shared/types.ts";
import { api, type ProjectInfo } from "./api.ts";
import { latestOnly, STALE } from "./latest.ts";
import { useServerEvents } from "./live.ts";
import { createRefresher, onReturn, refetchOnEvent, type RefreshState } from "./refresh.ts";

/**
 * 画面全体で共有するデータ（設定と、要望の一覧・進捗）。ファイルが正なので、変更通知（SSE）で読み直す。
 *
 *   reload  画面のデータを API から取り直す（変更通知・保存の後）。サーバのメモリ上の内容を読む
 *   refresh サーバにデータのフォルダを全部読み直させてから取り直す（ヘッダーの「再読み込み」・画面に戻ったとき）。
 *           CLI など外での変更はファイル監視では届かないことがあるので、こちらで取り込む
 */
export interface AppData {
  info: ProjectInfo;
  requests: RequestProgress[];
  reload: () => void;
  refresh: () => Promise<void>;
  refreshing: RefreshState;
  /** 取り直した回数（要望ごとのデータを読み直すきっかけ） */
  tick: number;
}

const Ctx = createContext<AppData | undefined>(undefined);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ProjectInfo>();
  const [requests, setRequests] = useState<RequestProgress[]>([]);
  const [tick, setTick] = useState(0);
  const latest = useRef(latestOnly());

  /** 取り直す。古い取得の応答は使わない。失敗は投げる（refresh が知らせる） */
  const fetchAll = useCallback(async () => {
    const r = await latest.current.run(() => Promise.all([api.project(), api.requests()]));
    if (r === STALE) return;
    setInfo(r[0]);
    setRequests(r[1]);
    setTick((n) => n + 1);
  }, []);
  const reload = useCallback(() => void fetchAll().catch(() => undefined), [fetchAll]);

  const [refreshing, setRefreshing] = useState<RefreshState>({ running: false, error: null, lastAt: null });
  const refresher = useMemo(() => createRefresher({ reloadServer: api.reloadAll, fetchAll, onState: setRefreshing }), [fetchAll]);
  const refresh = useCallback(() => refresher.refresh(), [refresher]);

  useEffect(() => {
    reload();
  }, [reload]);

  // タブ・ウィンドウに戻ったら1回読み直す（定期的には問い合わせない）
  useEffect(() => onReturn(window, document, () => void refresher.refresh()), [refresher]);

  // 変更通知: 画面からの保存・Preflight・ファイル監視（届けば）。連続する変更はまとめる。
  // 自分の再読み込みの通知（kind: reload）は、その再読み込みが取り直すので読まない（全件の読み直しは呼ばない）
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useServerEvents((e) => {
    if (!refetchOnEvent(e, refresher.state().running)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 120);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!info) return <div className="p-8 text-slate-500">Loading…</div>;
  return <Ctx.Provider value={{ info, requests, reload, refresh, refreshing, tick }}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppDataProvider の外で useAppData が呼ばれました");
  return v;
}
