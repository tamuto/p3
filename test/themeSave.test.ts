import { describe, expect, it } from "vitest";
import type { Theme } from "../src/shared/types.ts";
import { createThemeSaver } from "../src/web/lib/themeSave.ts";

/** 保存を手で終わらせられる偽の API（応答の順を入れ替えられる） */
function fakeApi() {
  const calls: { theme: Theme; resolve: () => void; reject: (e: Error) => void }[] = [];
  const save = (theme: Theme) =>
    new Promise<Theme>((res, rej) => calls.push({ theme, resolve: () => res(theme), reject: rej }));
  return { save, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(initial: Theme = "system") {
  const api = fakeApi();
  const applied: Theme[] = [];
  const saver = createThemeSaver({ initial, save: api.save, apply: (t) => applied.push(t) });
  return { api, applied, saver };
}

describe("テーマの保存（設定画面）", () => {
  it("保存できてから反映し、保存中は「保存しています」", async () => {
    const { api, applied, saver } = setup();
    const done = saver.select("dark");
    expect(saver.state()).toMatchObject({ selected: "dark", saved: "system", saving: true });
    expect(applied).toEqual([]); // 保存が済むまでは画面を変えない
    api.calls[0].resolve();
    await done;
    expect(saver.state()).toEqual({ saved: "dark", selected: "dark", saving: false, error: null, failed: null });
    expect(applied).toEqual(["dark"]);
  });

  it("保存中に続けて選ぶと、終わってから最後の選択だけを保存する（古いテーマに戻らない）", async () => {
    const { api, applied, saver } = setup();
    const first = saver.select("dark");
    void saver.select("light");
    void saver.select("system");
    void saver.select("light");
    expect(api.calls.map((c) => c.theme)).toEqual(["dark"]); // 同時には1つだけ
    expect(saver.state().selected).toBe("light");
    api.calls[0].resolve();
    await tick();
    expect(api.calls.map((c) => c.theme)).toEqual(["dark", "light"]);
    expect(saver.state()).toMatchObject({ saving: true, selected: "light" });
    api.calls[1].resolve();
    await first;
    await tick();
    expect(saver.state()).toMatchObject({ saved: "light", selected: "light", saving: false });
    expect(applied).toEqual(["dark", "light"]);
  });

  it("保存中に今保存しているものを選び直しても、もう一度は保存しない", async () => {
    const { api, saver } = setup();
    const p = saver.select("dark");
    void saver.select("light");
    void saver.select("dark");
    api.calls[0].resolve();
    await p;
    await tick();
    expect(api.calls.map((c) => c.theme)).toEqual(["dark"]);
    expect(saver.state()).toMatchObject({ saved: "dark", selected: "dark", saving: false });
  });

  it("失敗したら知らせて保存済みの表示に戻し、やり直せる", async () => {
    const { api, applied, saver } = setup("light");
    const p = saver.select("dark");
    void saver.select("system"); // 失敗したら、待っていた選択も保存しない
    api.calls[0].reject(new Error("この操作はローカルの P3 の画面からだけ行えます"));
    await p;
    await tick();
    expect(saver.state()).toEqual({ saved: "light", selected: "light", saving: false, error: "この操作はローカルの P3 の画面からだけ行えます", failed: "dark" });
    expect(applied).toEqual([]);
    expect(api.calls).toHaveLength(1);

    const again = saver.retry();
    expect(saver.state()).toMatchObject({ selected: "dark", saving: true, error: null });
    api.calls[1].resolve();
    await again;
    expect(saver.state()).toMatchObject({ saved: "dark", selected: "dark", error: null, failed: null });
    expect(applied).toEqual(["dark"]);
  });

  it("同じテーマを選んでも保存しない。ほかの画面・CLI の変更は保存中でなければ取り込む", async () => {
    const { api, applied, saver } = setup("dark");
    await saver.select("dark");
    expect(api.calls).toHaveLength(0);
    saver.sync("light");
    expect(saver.state()).toMatchObject({ saved: "light", selected: "light" });
    expect(applied).toEqual(["light"]);

    const p = saver.select("system");
    saver.sync("dark"); // 保存中は取り込まない（自分の保存が後から勝つ）
    expect(saver.state().selected).toBe("system");
    api.calls[0].resolve();
    await p;
    expect(saver.state()).toMatchObject({ saved: "system", selected: "system" });
  });
});
