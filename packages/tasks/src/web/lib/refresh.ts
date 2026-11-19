import type { ServerEvent } from "../../shared/types.ts";

/**
 * 画面の「再読み込み」と、タブ・ウィンドウに戻ったときの読み直し（ファイル監視に頼らずに外の変更を取り込む）。
 *
 *   - サーバにデータのフォルダを全部読み直させ（POST /api/reload）、それが終わってから画面のデータを取り直す
 *     （読み直しより前に始めた取得の結果は使わない。取得は lib/latest.ts で最後のものだけを使う）
 *   - 同時には走らせない。実行中にまた頼まれたら、終わってからもう1回だけ（何度頼まれても1回にまとめる）
 *   - 失敗したら error に出す。次の呼び出しでやり直せる
 *   - 定期的な問い合わせはしない
 */
export interface RefreshState {
  running: boolean;
  error: string | null;
  /** 最後に読み直し終えた日時 */
  lastAt: string | null;
}

export interface Refresher {
  refresh(): Promise<void>;
  state(): RefreshState;
}

export function createRefresher(opts: {
  reloadServer: () => Promise<unknown>;
  fetchAll: () => Promise<void>;
  onState?: (s: RefreshState) => void;
  now?: () => Date;
}): Refresher {
  let s: RefreshState = { running: false, error: null, lastAt: null };
  let running: Promise<void> | null = null;
  let again = false;
  const set = (patch: Partial<RefreshState>) => {
    s = { ...s, ...patch };
    opts.onState?.(s);
  };

  const cycle = async () => {
    do {
      again = false;
      try {
        await opts.reloadServer();
        await opts.fetchAll();
        set({ error: null, lastAt: (opts.now?.() ?? new Date()).toISOString() });
      } catch (e) {
        set({ error: (e as Error).message || "再読み込みできませんでした" });
      }
    } while (again);
  };

  return {
    refresh() {
      if (running) {
        again = true;
        return running;
      }
      set({ running: true });
      running = cycle().finally(() => {
        running = null;
        set({ running: false });
      });
      return running;
    },
    state: () => s,
  };
}

/** addEventListener / removeEventListener を持つもの（window・document。テストでは偽物） */
export interface Events {
  addEventListener(type: string, l: () => void): void;
  removeEventListener(type: string, l: () => void): void;
}

/**
 * 画面に戻ったら onBack を1回呼ぶ。離れた（タブが隠れた・ウィンドウからフォーカスが外れた）後に、
 * 戻った（タブが見えた・フォーカスが戻った）ときだけ。両方が続けて起きても1回。返り値で購読をやめる。
 */
export function onReturn(win: Events, doc: Events & { visibilityState: string }, onBack: () => void): () => void {
  let away = false;
  const leave = () => {
    away = true;
  };
  const back = () => {
    if (!away) return;
    away = false;
    onBack();
  };
  const visibility = () => (doc.visibilityState === "hidden" ? leave() : back());
  doc.addEventListener("visibilitychange", visibility);
  win.addEventListener("blur", leave);
  win.addEventListener("focus", back);
  return () => {
    doc.removeEventListener("visibilitychange", visibility);
    win.removeEventListener("blur", leave);
    win.removeEventListener("focus", back);
  };
}

/**
 * 変更通知（SSE）で画面を取り直すか。自分の再読み込み中に届いた kind: reload は、その再読み込みが取り直すので読まない。
 * どの通知でも全件の読み直し（POST /api/reload）は呼ばない（通知 → 読み直し → 通知 … と回らないように）
 */
export const refetchOnEvent = (e: ServerEvent, refreshing: boolean) => e.type === "changed" && !(e.kind === "reload" && refreshing);
