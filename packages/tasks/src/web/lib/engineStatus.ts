import { useEffect, useRef, useState } from "react";
import { api, type EngineStatus } from "./api.ts";
import { latestOnly, STALE } from "./latest.ts";

/** 状態を取れなかったとき（通信の失敗）。使えると見せない */
export const unknownEngine = (message: string): EngineStatus => ({
  name: "codex",
  ok: false,
  unknown: true,
  detail: `Preflight のエンジンの状態を確かめられません（${message}）。「再読み込み」でもう一度確かめます`,
});

/**
 * Preflight のエンジンの状態（概要ページ）。個人設定はサーバが問い合わせのたびに読み直すので、
 * 画面を取り直すたび（tick: 変更通知・「再読み込み」・タブやウィンドウに戻ったとき）に取り直す。定期的には問い合わせない。
 * 古い応答で新しい状態を上書きしない。
 */
export function useEngineStatus(tick: number): EngineStatus | undefined {
  const [engine, setEngine] = useState<EngineStatus>();
  const latest = useRef(latestOnly());
  useEffect(() => {
    let live = true;
    latest.current
      .run(() => api.engine())
      .then(
        (s) => live && s !== STALE && setEngine(s),
        (e: Error) => live && setEngine(unknownEngine(e.message)),
      );
    return () => {
      live = false;
    };
  }, [tick]);
  return engine;
}
