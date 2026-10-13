import { describe, expect, it, vi } from "vitest";
import { runAction } from "../src/web/lib/action.ts";

// 画面の操作から待たずに走らせる処理（済みを外す・Preflight の中止）。失敗を未処理の拒否にせず、画面に文言で渡す
describe("runAction", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("失敗したら onError に文言を渡す（競合などを知らせて読み直せるように）", async () => {
    const onError = vi.fn();
    runAction(() => Promise.reject(new Error("rev が違います")), onError);
    await settle();
    expect(onError).toHaveBeenCalledWith("rev が違います");
  });

  it("Promise を返す前に投げても、Error でない値で拒否しても受け止める", async () => {
    const onError = vi.fn();
    runAction(() => {
      throw new Error("同期の失敗");
    }, onError);
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Error でない拒否を受け止めるかを確かめる
    runAction(() => Promise.reject("文字列"), onError);
    await settle();
    expect(onError.mock.calls).toEqual([["同期の失敗"], ["文字列"]]);
  });

  it("成功したら onError を呼ばない", async () => {
    const onError = vi.fn();
    const done = vi.fn();
    runAction(async () => done(), onError);
    await settle();
    expect(done).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
});
