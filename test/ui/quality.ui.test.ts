// 設定の「品質基準」: 未設定の案内、テンプレートの中身を確かめて編集中の一覧へ足す、対象・確認の方法・除外の理由を直して保存、
// CLI で同じ基準が残ること、編集中に外で変わったら入力を残して保存させないこと、幅 375 ではみ出さずキーボードで届くこと。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("品質基準の設定", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質基準");
  });
  afterAll(async () => {
    await s?.close();
  });

  it("未設定の案内 → テンプレートを確かめて足す → 編集して保存 → CLI でも同じ。外で変わったら入力を残して保存させない", async () => {
    const { page, step, env } = s;
    const save = page.getByRole("button", { name: "品質基準を保存" });

    await step("未設定の案内とテンプレート", async () => {
      await page.goto("/settings?tab=quality");
      await until.visible(page.getByText(/品質基準は未設定です/));
      await page.getByRole("button", { name: "採用する前に中身を確かめる" }).first().click();
      await until.visible(page.getByText("プロジェクトのコーディング規約（命名・書式・エラーの扱い）に従う"));
      await page.getByRole("button", { name: "編集中の一覧へ足す" }).click();
      await until.visible(page.getByText("保存していない変更があります"));
    });

    await step("対象・確認の方法・除外の理由を直して保存する", async () => {
      const second = page.getByRole("group").nth(1);
      await second.getByLabel(/確認の方法/).selectOption("machine");
      await second.getByLabel("コマンド").fill("pnpm lint");
      await second.getByLabel("成功の条件").fill("終了コード 0");
      await second.getByLabel(/適用から除外する/).check();
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: /空の欄があります/ }));
      await second.getByLabel("除外の理由").fill("小さい CLI なので層が無い");
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      const q = JSON.parse(await env.p3(["quality", "--json"])) as { quality: { config: { standards: { id: string; check: { kind: string }; exempt?: { reason: string } }[]; templates: unknown[] } } };
      expect(q.quality.config.standards).toHaveLength(4);
      expect(q.quality.config.standards[1]).toMatchObject({ id: "Q2", check: { kind: "machine" }, exempt: { reason: "小さい CLI なので層が無い" } });
      expect(q.quality.config.templates).toEqual([{ id: "basic", version: 1 }]);
    });

    await step("編集中に外で変わったら入力を残して、保存させない", async () => {
      await page.getByRole("button", { name: "品質基準を編集" }).click();
      await page.getByLabel("Q1 の文", { exact: true }).fill("画面で直した規約");
      await env.p3(["quality", "rm", "Q4"]);
      await until.visible(page.getByText(/編集中に品質基準が他で変わりました/));
      await until.disabled(save);
      await until.value(page.getByLabel("Q1 の文", { exact: true }), "画面で直した規約");
      await page.getByRole("button", { name: "元に戻す" }).click();
      await until.visible(page.getByText(/保存済み: 3 件/));
    });
  });

  it("幅 375: はみ出さず、編集と保存にキーボードで届く", async () => {
    const page: Page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto("/settings?tab=quality");
        const edit = page.getByRole("button", { name: "品質基準を編集" });
        await until.visible(edit);
        expect(await pageOverflow(page)).toEqual([]);
        await edit.focus();
        await page.keyboard.press("Enter");
        const add = page.getByRole("button", { name: "基準を足す" });
        await until.visible(add);
        await add.focus();
        await page.keyboard.press("Enter");
        expect(await pageOverflow(page)).toEqual([]);
        expect(await reachable(page.getByRole("button", { name: "品質基準を保存" }), "保存")).toEqual([]);
      },
      page,
    );
  });
});
