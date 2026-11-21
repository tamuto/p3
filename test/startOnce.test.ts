import { describe, expect, it } from "vitest";
import { StartGate } from "../packages/shared/src/web/startOnce.ts";

/**
 * AI の実行を始める操作の開始待ち（packages/shared/src/web/startOnce.ts。Preflight・リリースノートの要約・観測の提案と候補が使う）:
 * 遅い応答の間は開始を1回だけ送る・実行中への切り替えは開始待ちを外す前・失敗したらもう一度始められる・対象が変わったら先の応答を当てない
 */
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

describe("開始待ち", () => {
  it("応答を待つ間は開始を1回だけ送り、実行中への切り替え（onDone）は開始待ちを外す前に行う", async () => {
    const events: string[] = [];
    const gate = new StartGate((s) => events.push(s === null ? "待ちを外す" : `待ち ${s}`));
    gate.scope = "261121-aaaaa";
    const d = deferred<string>();
    let sent = 0;
    const fn = () => (sent++, d.promise);
    const first = gate.start(fn, (r) => events.push(`実行中 ${r}`), () => events.push("失敗"));
    expect(await gate.start(fn, () => events.push("二回目"), () => events.push("失敗"))).toBe(false);
    expect([sent, events]).toEqual([1, ["待ち 261121-aaaaa"]]);
    d.resolve("PF-1");
    expect(await first).toBe(true);
    expect(events).toEqual(["待ち 261121-aaaaa", "実行中 PF-1", "待ちを外す"]);
  });

  it("開始を断られたら失敗を出して待ちを外し、もう一度始められる", async () => {
    const gate = new StartGate(() => {});
    const errors: string[] = [];
    await gate.start(() => Promise.reject(new Error("Codex を使えません")), () => {}, (e) => errors.push(e.message));
    let again = 0;
    await gate.start(async () => again++, () => {}, () => {});
    expect([errors, again]).toEqual([["Codex を使えません"], 1]);
  });

  it("開始待ちのまま対象が変わったら、先に送った応答・失敗は新しい対象に当てず、新しい対象の開始を受け付ける", async () => {
    const pending: (string | null)[] = [];
    const gate = new StartGate((s) => pending.push(s));
    gate.scope = "A";
    const a = deferred<string>();
    const done: string[] = [];
    const first = gate.start(() => a.promise, (r) => done.push(r), (e) => done.push(e.message));
    gate.scope = "B";
    gate.reset();
    const b = deferred<string>();
    const second = gate.start(() => b.promise, (r) => done.push(r), () => {});
    a.resolve("A の run");
    await first;
    expect(done).toEqual([]);
    b.resolve("B の run");
    await second;
    expect(done).toEqual(["B の run"]);
    expect(pending.at(-1)).toBeNull();
  });
});
