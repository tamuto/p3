import { describe, expect, it } from "vitest";
import { apiBase, currentScope, fixScope, pageBase, projectFromPath, projectPath, scopeHeaders } from "../src/web/lib/scope.ts";
import { hasUnsaved, savesInFlight, savesSettled, trackSave } from "../src/web/lib/unsaved.ts";

describe("画面の対象（プロジェクトを跨ぐ serve）", () => {
  it("URL の /projects/<名前> から名前を取り出す（それ以外・壊れた符号は無し）", () => {
    expect(projectFromPath("/projects/alpha/requests/261021-abcde")).toBe("alpha");
    expect(projectFromPath("/projects/alpha")).toBe("alpha");
    expect(projectFromPath("/projects/a%2Eb/")).toBe("a.b");
    expect(projectFromPath("/requests/x")).toBeUndefined();
    expect(projectFromPath("/projects/%E0%A4%A/")).toBeUndefined();
    expect(projectPath("my.app")).toBe("/projects/my.app");
  });

  it("ページを開いたときに一度だけ決め、API の基点・登録世代・URL の基点に使う。決め直せない", () => {
    expect(() => currentScope()).toThrow("まだ決まっていません");
    fixScope({ mode: "all-projects", project: "alpha", generation: "g-1" });
    expect(apiBase()).toBe("/api/projects/alpha");
    expect(pageBase()).toBe("/projects/alpha");
    expect(scopeHeaders()).toEqual({ "x-p3-project-generation": "g-1" });
    expect(() => fixScope({ mode: "single" })).toThrow("もう決まっています");
    expect(pageBase({ mode: "single" })).toBe("/");
  });
});

describe("保存していない入力と送っている保存", () => {
  it("送っている保存は結果が決まるまで数え、全部終わったら待ちが解ける（失敗でも）", async () => {
    expect(hasUnsaved()).toBe(false);
    let ok!: () => void;
    let ng!: (e: Error) => void;
    const a = trackSave(new Promise<void>((r) => (ok = r)));
    const b = trackSave(new Promise<void>((_, j) => (ng = j))).catch(() => undefined);
    expect(savesInFlight()).toBe(2);
    let settled = false;
    const waiting = savesSettled().then(() => (settled = true));
    ok();
    await a;
    expect(settled).toBe(false);
    ng(new Error("x"));
    await b;
    await waiting;
    expect(savesInFlight()).toBe(0);
    await expect(savesSettled()).resolves.toBeUndefined();
  });
});
