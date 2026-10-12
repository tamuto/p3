import { afterEach, describe, expect, it, vi } from "vitest";
import { createRefresher, onReturn, refetchOnEvent, type Events } from "../src/web/lib/refresh.ts";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

/** サーバの読み直しを1回ずつ手で終わらせられる refresher */
function setup() {
  const calls: string[] = [];
  const pending: ReturnType<typeof deferred>[] = [];
  const r = createRefresher({
    reloadServer: () => {
      calls.push("reload");
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    fetchAll: async () => void calls.push("fetch"),
  });
  const finish = async (fail?: string) => {
    const d = pending.shift()!;
    if (fail) d.reject(new Error(fail));
    else d.resolve();
    await new Promise((res) => setTimeout(res, 0));
  };
  return { r, calls, finish };
}

describe("再読み込み", () => {
  afterEach(() => vi.useRealTimers());

  it("サーバの読み直しが終わってから画面のデータを取り直す", async () => {
    const { r, calls, finish } = setup();
    const p = r.refresh();
    expect(r.state().running).toBe(true);
    expect(calls).toEqual(["reload"]);
    await finish();
    await p;
    expect(calls).toEqual(["reload", "fetch"]);
    expect(r.state()).toMatchObject({ running: false, error: null, lastAt: expect.any(String) });
  });

  it("連打・続けての復帰・手動と復帰が重なっても、実行中は走らせず、終わってからもう1回だけ", async () => {
    const { r, calls, finish } = setup();
    const first = r.refresh();
    const presses = [r.refresh(), r.refresh(), r.refresh(), r.refresh()];
    expect(presses.every((p) => p === first)).toBe(true);
    expect(calls).toEqual(["reload"]);
    await finish();
    expect(calls).toEqual(["reload", "fetch", "reload"]);
    await finish();
    await first;
    expect(calls).toEqual(["reload", "fetch", "reload", "fetch"]);
    expect(r.state().running).toBe(false);
  });

  it("サーバの読み直しに失敗したら取り直さずに知らせ、次の呼び出しでやり直せる", async () => {
    const { r, calls, finish } = setup();
    const p = r.refresh();
    await finish("project.yaml を読めません");
    await p;
    expect(calls).toEqual(["reload"]);
    expect(r.state()).toMatchObject({ running: false, error: "project.yaml を読めません", lastAt: null });
    const retry = r.refresh();
    await finish();
    await retry;
    expect(calls).toEqual(["reload", "reload", "fetch"]);
    expect(r.state().error).toBeNull();
  });

  it("取り直しに失敗しても知らせる", async () => {
    const r = createRefresher({ reloadServer: async () => undefined, fetchAll: async () => Promise.reject(new Error("Failed to fetch")) });
    await r.refresh();
    expect(r.state().error).toBe("Failed to fetch");
  });

  it("時間が経っても自分からは問い合わせない（定期的なポーリングはしない）", async () => {
    vi.useFakeTimers();
    const reloadServer = vi.fn(async () => undefined);
    const fetchAll = vi.fn(async () => undefined);
    const r = createRefresher({ reloadServer, fetchAll });
    const { win, doc } = fakeWindow();
    const off = onReturn(win, doc, () => void r.refresh());
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(reloadServer).not.toHaveBeenCalled();
    expect(fetchAll).not.toHaveBeenCalled();
    off();
  });
});

function fakeWindow() {
  const make = () => {
    const ls = new Map<string, Set<() => void>>();
    const t: Events & { fire(type: string): void; count(): number } = {
      addEventListener: (type, l) => void (ls.get(type) ?? ls.set(type, new Set()).get(type)!).add(l),
      removeEventListener: (type, l) => void ls.get(type)?.delete(l),
      fire: (type) => ls.get(type)?.forEach((l) => l()),
      count: () => [...ls.values()].reduce((n, s) => n + s.size, 0),
    };
    return t;
  };
  const win = make();
  const doc = Object.assign(make(), { visibilityState: "visible" });
  const hide = () => ((doc.visibilityState = "hidden"), doc.fire("visibilitychange"));
  const show = () => ((doc.visibilityState = "visible"), doc.fire("visibilitychange"));
  return { win, doc, hide, show };
}

describe("画面に戻ったとき", () => {
  it("タブが隠れて見えたら1回。フォーカスが戻るのと続けて起きても1回。離れていなければ呼ばない", () => {
    const { win, doc, hide, show } = fakeWindow();
    const back = vi.fn();
    const off = onReturn(win, doc, back);
    show(); // 離れていない
    win.fire("focus");
    expect(back).not.toHaveBeenCalled();
    win.fire("blur");
    hide();
    show();
    win.fire("focus");
    expect(back).toHaveBeenCalledTimes(1);
    // ウィンドウを切り替えただけ（タブは見えたまま）
    win.fire("blur");
    win.fire("focus");
    expect(back).toHaveBeenCalledTimes(2);
    // 続けて見える・フォーカスが来ても増えない
    show();
    win.fire("focus");
    expect(back).toHaveBeenCalledTimes(2);
    off();
    expect(win.count() + doc.count()).toBe(0);
    hide();
    show();
    expect(back).toHaveBeenCalledTimes(2);
  });

  it("戻るたびの読み直しが重なっても、refresher が1回にまとめる", async () => {
    const { win, doc, hide, show } = fakeWindow();
    const { r, calls, finish } = setup();
    const off = onReturn(win, doc, () => void r.refresh());
    hide();
    show();
    hide();
    show();
    win.fire("blur");
    win.fire("focus");
    expect(calls).toEqual(["reload"]);
    await finish();
    await finish();
    expect(calls).toEqual(["reload", "fetch", "reload", "fetch"]);
    off();
  });
});

describe("変更通知で取り直すか", () => {
  it("changed なら取り直す。自分の再読み込み中の reload は取り直さない（全件の読み直しはどの通知でも呼ばない）", () => {
    expect(refetchOnEvent({ type: "changed", kind: "task", request: "x" }, false)).toBe(true);
    expect(refetchOnEvent({ type: "changed", kind: "task", request: "x" }, true)).toBe(true);
    expect(refetchOnEvent({ type: "changed", kind: "reload" }, false)).toBe(true); // 別のタブの再読み込み
    expect(refetchOnEvent({ type: "changed", kind: "reload" }, true)).toBe(false);
    expect(refetchOnEvent({ type: "preflight-status", runId: "r", status: "running" }, false)).toBe(false);
  });
});
