import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunPulse } from "../src/shared/types.ts";
import { createPulsePoller, latestNotice, PULSE_INTERVAL_MS, runStateLabel, shownRunChanged } from "../src/web/lib/preflightWatch.ts";

/** 1回ずつ手で終わらせられる確かめ */
function setup() {
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let calls = 0;
  const p = createPulsePoller({
    check: () =>
      new Promise<void>((resolve, reject) => {
        calls++;
        pending.push({ resolve, reject });
      }),
  });
  const finish = async (fail?: string) => {
    const d = pending.shift()!;
    if (fail) d.reject(new Error(fail));
    else d.resolve();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { p, finish, calls: () => calls, pending };
}

describe("開いている要望の最新の Preflight を確かめる間隔", () => {
  afterEach(() => vi.useRealTimers());

  it("始めたらすぐ1回、終わってから3秒ごと。終わる前に次は始めない", async () => {
    vi.useFakeTimers();
    const { p, finish, calls } = setup();
    p.start();
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS * 3); // 1回目が終わっていないので、次は予約しない
    expect(calls()).toBe(1);
    await finish();
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS - 1);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(2);
    // 失敗しても次は予約する
    await finish("通信の失敗");
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(calls()).toBe(3);
    p.stop();
  });

  it("今すぐ（SSE など）は、確かめている最中なら終わってから1回だけにまとめる", async () => {
    vi.useFakeTimers();
    const { p, finish, calls } = setup();
    p.start();
    for (let i = 0; i < 5; i++) p.now();
    expect(calls()).toBe(1);
    await finish();
    expect(calls()).toBe(2); // まとめた1回
    await finish();
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS);
    expect(calls()).toBe(3);
    p.stop();
  });

  it("隠れたタブでは止め、見えたらすぐ確かめて再開する。止めたらタイマーも残さない", async () => {
    vi.useFakeTimers();
    const { p, finish, calls } = setup();
    p.start();
    await finish();
    p.pause();
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS * 10);
    expect(calls()).toBe(1);
    p.now(); // 隠れている間は今すぐも確かめない
    expect(calls()).toBe(1);
    p.resume();
    expect(calls()).toBe(2);
    await finish();
    p.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS * 10);
    expect(calls()).toBe(2);
  });

  it("止めたあとに前の確かめが終わっても、次を予約しない（ページを離れた）", async () => {
    vi.useFakeTimers();
    const { p, finish, calls } = setup();
    p.start();
    p.stop();
    await finish();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PULSE_INTERVAL_MS * 3);
    expect(calls()).toBe(1);
  });
});

const pulse = (p: Partial<RunPulse> & { id: string }): RunPulse => ({ state: "ready", status: "completed", ...p });

describe("最新の Preflight の知らせ", () => {
  it("表示中と最新が同じ・最新が無い・最新の run が見つからないなら知らせない", () => {
    expect(latestNotice("PF-1", pulse({ id: "PF-1" }), new Set())).toBeNull();
    expect(latestNotice(null, null, new Set())).toBeNull();
    expect(latestNotice("PF-1", pulse({ id: "PF-2", state: "missing", status: undefined }), new Set())).toBeNull();
  });

  it("開いたあとにできた run は「新しい」、開いたときからあった最新（過去の run を見ている）はそうでない。未実行の画面でも知らせる", () => {
    const known = new Set(["PF-1", "PF-2"]);
    expect(latestNotice("PF-1", pulse({ id: "PF-3", status: "running" }), known)).toMatchObject({ fresh: true, run: { id: "PF-3" } });
    expect(latestNotice("PF-1", pulse({ id: "PF-2" }), known)).toMatchObject({ fresh: false, run: { id: "PF-2" } });
    expect(latestNotice(null, pulse({ id: "PF-9" }), new Set())).toMatchObject({ fresh: true });
  });

  it("実行中を評価済みに見せない", () => {
    expect(runStateLabel(pulse({ id: "a", status: "running" })).label).toBe("実行中");
    expect(runStateLabel(pulse({ id: "a", status: "completed" })).label).toBe("評価済み");
    expect(runStateLabel(pulse({ id: "a", status: "failed" })).label).toBe("失敗");
    expect(runStateLabel({ id: "a", state: "pending" }).label).toBe("保存中");
    expect(runStateLabel({ id: "a", state: "broken" }).label).toBe("読めません");
  });
});

describe("表示中の run を取り直すか", () => {
  it("版が変わったら取り直す。同じ版・別の run の応答・表示を替えたあとの応答では取り直さない", () => {
    const now = pulse({ id: "PF-1", version: "2" });
    expect(shownRunChanged(now, "PF-1", { id: "PF-1", version: "1" }, { id: "PF-1", status: "running" })).toBe(true);
    expect(shownRunChanged(now, "PF-1", { id: "PF-1", version: "2" }, { id: "PF-1", status: "completed" })).toBe(false);
    // 表示を PF-2 に替えたあとに届いた PF-1 の応答
    expect(shownRunChanged(now, "PF-2", { id: "PF-1", version: "1" }, { id: "PF-2", status: "running" })).toBe(false);
    expect(shownRunChanged(undefined, "PF-1", undefined, undefined)).toBe(false);
    expect(shownRunChanged({ id: "PF-1", state: "pending" }, "PF-1", undefined, { id: "PF-1", status: "running" })).toBe(false);
  });

  it("初めて確かめたときは、表示中の内容と状態が違えば取り直す（実行中のまま開いた run が外で終わった）", () => {
    expect(shownRunChanged(pulse({ id: "PF-1", status: "completed" }), "PF-1", undefined, { id: "PF-1", status: "running" })).toBe(true);
    expect(shownRunChanged(pulse({ id: "PF-1", status: "running" }), "PF-1", undefined, { id: "PF-1", status: "running" })).toBe(false);
    // 前に確かめたのは別の run（表示を替えた直後）
    expect(shownRunChanged(pulse({ id: "PF-2", status: "failed" }), "PF-2", { id: "PF-1", version: "9" }, { id: "PF-2", status: "running" })).toBe(true);
  });
});
