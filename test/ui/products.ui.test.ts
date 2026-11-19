// serve の製品の選び方（p3 serve --products）の画面: tasks だけ・observer だけ・両方（通常の serve とプロジェクトを跨ぐ serve）。
// ナビゲーションの導線、observer のページの直リンクと再読み込み、選んでいない製品のページ、observer の画面が tasks の API を要求しないこと。
import { afterEach, describe, expect, inject, it } from "vitest";
import type { Page } from "playwright-core";
import { openScenario, until, type Scenario } from "./scenario.ts";

/** 画面が要求した /api の道（重複なし） */
function apiRequests(page: Page) {
  const seen = new Set<string>();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api")) seen.add(u.pathname);
  });
  return () => [...seen];
}

/** tasks のデータ・設定・イベントの API か */
const isTasksApi = (p: string) => !["/api/mode", "/api/user-theme.js"].includes(p) && !p.startsWith("/api/observer/");

const observerNav = (page: Page) => page.getByRole("navigation").getByRole("link", { name: "観測基盤" });

describe.skipIf(!inject("chromium").available)("serve の製品の選び方", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("tasks だけ（既定）: 今までの画面で observer の導線が無く、/observer を直接開いても無効と出て observer の API を読まない", async () => {
    s = await openScenario("tasks だけ");
    const { page, step } = s;
    await step("進捗が開き、ナビゲーションに観測基盤が無い", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "進捗" }));
      expect(await observerNav(page).count()).toBe(0);
    });
    await step("/observer を直接開くと無効と出る", async () => {
      const requests = apiRequests(page);
      await page.goto("/observer");
      await until.visible(page.getByRole("heading", { name: /観測基盤（observer）はこの起動では使えません/ }));
      expect(requests().filter((p) => p.startsWith("/api/observer"))).toEqual([]);
    });
  });

  it("observer だけ: どの URL からも起動確認のページに移り、共通の版を出し、tasks の API を要求しない", async () => {
    s = await openScenario("observer だけ", { serveArgs: ["--products", "observer"] });
    const { page, step } = s;
    const requests = apiRequests(page);
    await step("/ を開くと /observer に移り、起動状態と共通の版が出る", async () => {
      await page.goto("/");
      await until.url(page, /\/observer$/);
      await until.visible(page.getByRole("heading", { name: "観測基盤", exact: true }));
      await until.visible(page.getByText("起動中"));
      await until.visible(page.getByText(await s!.env.p3(["observer", "status", "--json"]).then((o) => JSON.parse(o).version as string), { exact: true }));
      await until.visible(page.getByText("p3-observer", { exact: true }));
    });
    await step("tasks の導線は無い", async () => {
      expect(await page.getByRole("link", { name: "進捗" }).count()).toBe(0);
      expect(await page.getByRole("link", { name: /新しい要望/ }).count()).toBe(0);
    });
    await step("tasks のプロジェクト情報・設定・イベントを要求していない", async () => {
      expect(requests().filter(isTasksApi)).toEqual([]);
      expect(requests()).toContain("/api/observer/status");
    });
  });

  it("両方（通常の serve）: ナビゲーションで行き来でき、/observer を直リンクで開いて再読み込みしても起動確認のページが出る", async () => {
    s = await openScenario("両方", { serveArgs: ["--products", "tasks,observer"] });
    const { page, step } = s;
    await step("tasks の進捗から観測基盤へ移る", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "進捗" }));
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByText("p3-tasks、p3-observer"));
    });
    await step("直リンクで開き、再読み込みしても起動確認のページ。observer の画面は tasks の API を読まない", async () => {
      const fresh = await s!.open({ width: 1280 });
      const requests = apiRequests(fresh);
      await fresh.goto("/observer");
      await until.visible(fresh.getByText("起動中"));
      await fresh.reload();
      await until.visible(fresh.getByText("起動中"));
      expect(requests().filter(isTasksApi)).toEqual([]);
    });
    await step("観測基盤から tasks の設定と進捗へ戻る", async () => {
      await page.getByRole("navigation").getByRole("link", { name: "設定" }).click();
      await until.url(page, /\/settings$/);
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await page.getByRole("navigation").getByRole("link", { name: "進捗" }).click();
      await until.url(page, /\/$/);
      await until.visible(page.getByRole("link", { name: /新しい要望/ }).first());
    });
  });

  it("両方（プロジェクトを跨ぐ serve）: プロジェクトの画面から観測基盤へ移り、戻る導線で今までのプロジェクトの選択が使える", async () => {
    s = await openScenario("両方・プロジェクトを跨ぐ", { serveArgs: ["--all-projects", "--products", "tasks,observer"] });
    const { page, step } = s;
    await step("プロジェクトを開き（登録が1つなら一覧を飛ばす）、観測基盤へ移る", async () => {
      await page.goto("/");
      await until.url(page, /\/projects\/uitest\/$/);
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByText("起動中"));
    });
    await step("「タスク管理」でプロジェクトの選択（入口）に戻り、プロジェクトの画面が開く", async () => {
      await page.getByRole("navigation").getByRole("link", { name: "タスク管理" }).click();
      await until.url(page, /\/projects\/uitest\/$/);
      await until.visible(page.getByRole("link", { name: /新しい要望/ }).first());
    });
    await step("一覧（?list）からも選べる", async () => {
      await page.goto("/?list");
      await until.visible(page.getByRole("link", { name: "uitest" }));
      expect(new URL(page.url()).pathname).toBe("/");
    });
  });
});
