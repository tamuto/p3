import type { RunPulse } from "../../shared/types.ts";

/**
 * 要望の「概要・Preflight」を開いている間だけ、最新の Preflight を軽く確かめる（GET /api/requests/:rid/preflight-status）。
 * CLI など外で始めた run は SSE に乗らず、監視も届かないことがあるため（docs/architecture.md）。
 *
 *   - 確かめるのは PULSE_INTERVAL_MS ごと。前の確かめが終わってから次を予約する（重ならない）
 *   - 隠れたタブでは止め（pause）、見えたらすぐ1回確かめて再開する（resume）。ページを離れたら stop
 *   - now(): SSE などで今すぐ確かめたいとき。確かめている最中なら、終わってからもう1回だけ（何度呼ばれても1回にまとめる）
 */
export const PULSE_INTERVAL_MS = 3000;

export interface PulsePoller {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  now(): void;
}

export function createPulsePoller(opts: {
  /** 1回確かめる（失敗は呼ぶ側で知らせる。投げても次は予約する） */
  check: () => Promise<void>;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): PulsePoller {
  const interval = opts.intervalMs ?? PULSE_INTERVAL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let active = false;
  let paused = false;
  let running = false;
  let again = false;
  let timer: unknown;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const schedule = () => {
    cancelTimer();
    if (active && !paused) timer = setTimer(() => void run(), interval);
  };
  const run = async (): Promise<void> => {
    if (!active || paused) return;
    if (running) {
      again = true;
      return;
    }
    cancelTimer();
    running = true;
    try {
      await opts.check();
    } catch {
      // 知らせるのは check の側。次の確かめは続ける
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      return run();
    }
    schedule();
  };

  return {
    start() {
      active = true;
      void run();
    },
    stop() {
      active = false;
      again = false;
      cancelTimer();
    },
    pause() {
      paused = true;
      again = false;
      cancelTimer();
    },
    resume() {
      if (!paused) return;
      paused = false;
      void run();
    },
    now() {
      void run();
    },
  };
}

/** run の状態の見せ方（実行中を評価済みに見せない） */
export function runStateLabel(p: RunPulse): { label: string; tone: "indigo" | "emerald" | "rose" | "amber" | "slate" } {
  if (p.state === "pending") return { label: "保存中", tone: "slate" };
  if (p.state === "broken") return { label: "読めません", tone: "amber" };
  if (p.state === "missing") return { label: "見つかりません", tone: "amber" };
  if (p.status === "running") return { label: "実行中", tone: "indigo" };
  if (p.status === "failed") return { label: "失敗", tone: "rose" };
  return { label: "評価済み", tone: "emerald" };
}

/**
 * 表示中の run と最新が違うときの知らせ。表示は変えず、開くかは人が決める。
 * fresh: 画面を開いたあとにできた run（「新しい Preflight があります」）。開いたときからあった最新（過去の run を ?run= で
 * 見ている）なら fresh ではない（「表示中の評価は最新ではありません」）
 */
export function latestNotice(shown: string | null, latest: RunPulse | null, knownAtOpen: ReadonlySet<string>): { run: RunPulse; fresh: boolean } | null {
  if (!latest || latest.id === shown || latest.state === "missing") return null;
  return { run: latest, fresh: !knownAtOpen.has(latest.id) };
}

/**
 * 表示中の run を取り直すか。確かめた run が今表示している run で（別の run の応答では取り直さない）、前に確かめた版から
 * 変わった、または初めて確かめたときに表示中の内容と状態が違う（実行中のまま開いた run が外で終わった）とき
 */
export function shownRunChanged(
  pulse: RunPulse | undefined,
  shownId: string | null,
  seen: { id: string; version?: string } | undefined,
  shown: { id: string; status: string } | undefined,
): boolean {
  if (!pulse || !shownId || pulse.id !== shownId || pulse.state !== "ready") return false;
  if (seen?.id === pulse.id) return seen.version !== pulse.version;
  return shown?.id === pulse.id && shown.status !== pulse.status;
}
