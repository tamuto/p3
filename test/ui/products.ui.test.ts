// serve の製品の画面: serve は常に tasks と observer の両方を起動する（通常の serve とプロジェクトを跨ぐ serve）。
// ナビゲーションの導線、observer のページの直リンクと再読み込み、observer の画面が tasks の API を要求しないこと。
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
const isTasksApi = (p: string) => !["/api/mode", "/api/user-theme.js", "/api/projects"].includes(p) && !p.startsWith("/api/observer/") && !/^\/api\/projects\/[^/]+\/observer\//.test(p);

const observerNav = (page: Page) => page.getByRole("navigation").getByRole("link", { name: "観測基盤" });

describe.skipIf(!inject("chromium").available)("serve の製品（常に両方）", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("両方（通常の serve）: ナビゲーションで行き来でき、/observer を直リンクで開いて再読み込みしても起動確認のページが出る", async () => {
    s = await openScenario("両方");
    const { page, step } = s;
    await step("tasks の進捗から観測基盤へ移る", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "進捗" }));
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByRole("heading", { name: "観測の定義" }));
      await until.visible(page.getByText("起動中・共通バージョン"));
    });
    await step("直リンクで開き、再読み込みしても起動確認のページ。observer の画面は tasks の API を読まない", async () => {
      const fresh = await s!.open({ width: 1280 });
      const requests = apiRequests(fresh);
      await fresh.goto("/observer");
      await until.visible(fresh.getByText("起動中・共通バージョン"));
      await fresh.reload();
      await until.visible(fresh.getByText("起動中・共通バージョン"));
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

  it("両方（プロジェクトを跨ぐ serve）: プロジェクトの画面からそのプロジェクトの観測へ移り、同じプロジェクトの tasks へ戻る。選んでいなければ選んでから", async () => {
    s = await openScenario("両方・プロジェクトを跨ぐ", { serveArgs: ["--all-projects"] });
    const { page, step } = s;
    await step("プロジェクトを開き（登録が1つなら一覧を飛ばす）、観測基盤へ移る", async () => {
      await page.goto("/");
      await until.url(page, /\/projects\/uitest\/$/);
      await observerNav(page).click();
      await until.url(page, /\/projects\/uitest\/observer$/);
      await until.visible(page.getByTestId("observer-target"));
      await until.text(page.getByTestId("observer-target"), /登録先: プロジェクト uitest/);
    });
    await step("「進捗」で同じプロジェクトの tasks に戻る", async () => {
      await page.getByRole("navigation").getByRole("link", { name: "進捗" }).click();
      await until.url(page, /\/projects\/uitest\/$/);
      await until.visible(page.getByRole("link", { name: /新しい要望/ }).first());
    });
    await step("プロジェクトを決めずに /observer を開くと、プロジェクトを選んでから観測の一覧へ移る", async () => {
      const requests = apiRequests(page);
      await page.goto("/observer");
      await until.visible(page.getByRole("heading", { name: "観測を登録するプロジェクトを選んでください" }));
      await page.getByRole("link", { name: "uitest" }).click();
      await until.url(page, /\/projects\/uitest\/observer$/);
      await until.visible(page.getByRole("heading", { name: "観測の定義" }));
      expect(requests().filter(isTasksApi)).toEqual([]);
    });
    await step("「タスク管理」（選んでいない観測の画面から）でプロジェクトの選択（入口）に戻る", async () => {
      await page.goto("/observer");
      await page.getByRole("navigation").getByRole("link", { name: "タスク管理" }).click();
      await until.url(page, /\/projects\/uitest\/$/);
    });
  });
});
