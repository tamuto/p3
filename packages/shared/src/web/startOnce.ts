import { useEffect, useRef, useState } from "react";

/**
 * AI の実行を始める操作（Preflight・リリースノートの要約・観測の提案など）の開始待ちの決まり（React に依らない。Vitest で確かめる）。
 * 押した瞬間に開始待ちを立て、開始の応答が返るまで開始を送らない（イメージの作り直しなどで応答が遅くても、押せたか分からない間を作らない）。
 * 応答の後の処理（onDone: 実行中の表示へ移す）は開始待ちを外す前に行うので、開始の操作が再び押せる間を挟まない。
 * 開始待ちのまま対象（scope）が変わったら、先に送った応答・失敗は新しい対象に当てない
 */
export class StartGate {
  private inFlight: string | null = null;
  /** 今の対象（画面が描くたびに入れ直す） */
  scope = "";
  constructor(private readonly onPending: (scope: string | null) => void) {}

  async start<T>(fn: () => Promise<T>, onDone: (r: T) => void, onError: (e: Error) => void): Promise<boolean> {
    if (this.inFlight !== null) return false;
    const s = this.scope;
    this.inFlight = s;
    this.onPending(s);
    try {
      const r = await fn();
      if (this.scope === s) onDone(r);
    } catch (e) {
      if (this.scope === s) onError(e as Error);
    } finally {
      if (this.inFlight === s) {
        this.inFlight = null;
        this.onPending(null);
      }
    }
    return true;
  }

  /** 対象が変わった（先に送ったものの結果は捨て、新しい対象の開始を受け付ける） */
  reset() {
    this.inFlight = null;
    this.onPending(null);
  }
}

/** 画面の開始待ち（StartGate を描画と結ぶ）。pending は今の対象の開始待ちか */
export function useStartOnce(scope: string) {
  const [pending, setPending] = useState<string | null>(null);
  const gate = useRef<StartGate>(null);
  gate.current ??= new StartGate(setPending);
  gate.current.scope = scope;
  useEffect(() => () => gate.current?.reset(), [scope]);
  return { pending: pending === scope, start: <T,>(fn: () => Promise<T>, onDone: (r: T) => void, onError: (e: Error) => void) => gate.current!.start(fn, onDone, onError).then(() => undefined) };
}

/** 開始待ちの表示（実行中とは別の言い方。画面原稿の待ちのラベル） */
export const STARTING_LABEL = "開始を待っています…";
