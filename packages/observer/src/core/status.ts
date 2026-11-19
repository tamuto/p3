import { appVersion } from "@infodb/p3-kit/appInfo.ts";
import type { ObserverStatus } from "../shared/status.ts";

/** 起動状態を返す。何も読み書きしない（個人設定・プロジェクトの登録・tasks のデータを使わない） */
export function observerStatus(): ObserverStatus {
  return { product: "observer", version: appVersion(), state: "ready", dataDir: null };
}
