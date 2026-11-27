// serve の製品の画面: serve は常に tasks と observer の両方を起動し、観測のページも tasks と同じ外枠（プロジェクト名・プロジェクトの切り替え）で出る。
// ナビゲーションの導線（進捗の次に「観測」）、観測のページの直リンクと再読み込み。
import { afterEach, describe, expect, inject, it } from "vitest";
import type { Page } from "playwright-core";
import { openScenario, until, type Scenario } from "./scenario.ts";

const observerNav = (page: Page) => page.getByRole("navigation").getByRole("link", { name: "観測", exact: true });

describe.skipIf(!inject("chromium").available)("serve の製品（常に両方）", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("通常の serve: 観測へ移ってもプロジェクト名が出たまま。直リンクで開いて再読み込みしても観測の一覧が出る", async () => {
    s = await openScenario("両方");
    const { page, step } = s;
    await step("進捗から観測へ移る。ヘッダーのプロジェクト名はそのまま", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "進捗" }));
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByRole("heading", { name: "観測", exact: true }));
      await until.visible(page.getByRole("banner").getByText("uitest"));
      expect(await page.getByRole("banner").getByRole("navigation").getByRole("link").allInnerTexts()).toEqual(["進捗", "観測", "リリースノート", "設定"]);
    });
    await step("直リンクで開き、再読み込みしても観測の一覧", async () => {
      const fresh = await s!.open({ width: 1280 });
      await fresh.goto("/observer");
      await until.visible(fresh.getByRole("heading", { name: "観測", exact: true }));
      await fresh.reload();
      await until.visible(fresh.getByRole("heading", { name: "観測", exact: true }));
    });
    await step("観測から設定と進捗へ戻る", async () => {
      await page.getByRole("navigation").getByRole("link", { name: "設定" }).click();
      await until.url(page, /\/settings$/);
      await observerNav(page).click();
      await until.url(page, /\/observer$/);
      await page.getByRole("navigation").getByRole("link", { name: "進捗" }).click();
      await until.url(page, /\/$/);
    });
  });

  it("プロジェクトを跨ぐ serve: 観測へ移ってもプロジェクトの切り替えの欄が出たまま", async () => {
    s = await openScenario("両方・プロジェクトを跨ぐ", { serveArgs: ["--all-projects"] });
    const { page, step } = s;
    await step("プロジェクトを開き、観測へ移る。切り替えの欄はそのまま", async () => {
      await page.goto("/");
      await until.url(page, /\/projects\/uitest\/$/);
      const picker = page.getByRole("banner").getByRole("combobox");
      await until.value(picker, "uitest");
      await observerNav(page).click();
      await until.url(page, /\/projects\/uitest\/observer$/);
      await until.visible(page.getByRole("heading", { name: "観測", exact: true }));
      await until.value(picker, "uitest");
      expect(await page.getByRole("banner").getByRole("link", { name: /新しい要望/ }).count()).toBe(1);
    });
    await step("観測のページを直リンクで開いても同じ", async () => {
      await page.goto("/projects/uitest/observer");
      await until.visible(page.getByRole("heading", { name: "観測", exact: true }));
      await until.value(page.getByRole("banner").getByRole("combobox"), "uitest");
    });
  });
});
