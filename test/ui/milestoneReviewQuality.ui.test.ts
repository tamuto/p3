// マイルストーンレビューの品質の欄: 材料のプレビューに品質基準（版・評価する件数・除外）が出る、結果の品質の欄が目的の判定とは別に出る
// （基準ごとの判定・除外）、品質基準を変えると評価した版と今の版の差と「材料が変わった」が出る、確かめた材料で実行できる、
// 品質基準が未設定のマイルストーンでは評価していないと出る、幅 375 ではみ出さない。Mock で動かす。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("マイルストーンレビューの品質", () => {
  let s: Scenario;
  const panel = (page: Page) => page.getByRole("tabpanel", { name: "レビュー" });
  const quality = (page: Page) => panel(page).getByRole("region", { name: "品質", exact: true });

  beforeAll(async () => {
    s = await openScenario("マイルストーンレビューの品質", {
      prepare: async (env) => {
        await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
        await env.p3(["milestone", "purpose", "v1", "--body", "経費の申請を紙からなくす"]);
        await env.p3(["milestone", "goal", "add", "v1", "申請の画面"]);
        const rid = (JSON.parse(await env.p3(["request", "new", "経費の申請", "--body", "申請できるようにする", "--milestone", "v1", "--json"])) as { id: string }).id;
        await env.p3(["new", "申請の画面", "--req", rid]);
        await env.p3(["quality", "add", "--text", "lint が通る", "--command", "pnpm lint", "--success", "終了コード 0"]);
        await env.p3(["quality", "add", "--text", "画面の文言は用語集に従う", "--reference", "docs/glossary.md"]);
        await env.p3(["quality", "exempt", "Q2", "--reason", "この製品には画面の用語集が無い"]);
        await env.p3(["milestone", "review", "v1", "--engine", "mock"]);
      },
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("品質の欄が目的の判定と別に出て、品質基準を変えると差と材料の変化を知らせ、確かめた材料で実行し直せる", async () => {
    const { page, step, env } = s;
    await step("プレビューの品質基準と、結果の品質の欄", async () => {
      await page.goto("/release-notes?tab=review&m=v1");
      await until.visible(panel(page).getByText(/品質基準: 版 .*・1 件を評価・除外 Q2/));
      await until.visible(quality(page).getByRole("listitem", { name: "品質 Q1" }).getByText("判断できない"));
      await until.visible(quality(page).getByText(/Q2 除外（この製品には画面の用語集が無い）/));
      // 目的・予定機能の判定は別に出る
      await until.visible(panel(page).getByText("判断材料不足").first());
      expect(await quality(page).getByRole("alert").count()).toBe(0);
    });

    await step("品質基準を変えると、評価した版と今の版の差と、材料が変わったことを出す", async () => {
      await env.p3(["quality", "set", "Q1", "--text", "lint が警告なしで通る"]);
      await until.visible(quality(page).getByText(/今の品質基準は版 .* に変わっています/));
      await until.visible(panel(page).getByText(/評価の後に材料が変わっています/).first());
    });

    await step("確かめた材料（変わった後の品質基準）で実行し直すと、新しい版で評価する", async () => {
      await panel(page).getByRole("button", { name: "今の内容でもう一度実行" }).click();
      await until.count(quality(page).getByText(/今の品質基準は版 .* に変わっています/), 0);
      await until.visible(quality(page).getByRole("listitem", { name: "品質 Q1" }).getByText("lint が警告なしで通る"));
      const runs = JSON.parse(await env.p3(["milestone", "reviews", "v1", "--json"])) as { run: { status: string } }[];
      expect(runs.map((r) => r.run.status)).toEqual(["completed", "completed"]);
    });
  });

  it("幅 375: 品質の欄がはみ出さない", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto("/release-notes?tab=review&m=v1");
        await until.visible(quality(page).getByRole("listitem", { name: "品質 Q1" }));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
