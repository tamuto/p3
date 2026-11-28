// 設定の「品質基準」: 項目は文・対象の参照先・確かめ方だけ。未設定の案内（続けられる・P3 はコマンドを実行しない）、基準の追加と
// 複数の参照先・全参照先の保存と再読み込み、CLI で同じ基準が残ること、編集と保存で既存の ID が変わらず番号を使い直さないこと、
// 編集中に外で変わったら入力を残して保存させないこと、幅 375 / 1280・明暗ではみ出さず、キーボードで保存と取消に届くこと。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { isDark, pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

type Standards = { quality: { state: string; config?: { standards: { id: string; text: string; repos?: string[]; how?: string }[] } } };
const read = async (env: UiEnv) => (JSON.parse(await env.p3(["quality", "--json"])) as Standards).quality;

describe.skipIf(!inject("chromium").available)("品質基準の設定", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質基準", {
      prepare: async (env) => {
        await env.p3(["repo", "add", "app"]);
        await env.p3(["repo", "add", "infra"]);
      },
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("未設定の案内 → 基準を足して2つの参照先で保存 → 再読み込みと CLI で読める → 編集しても ID は変わらない。外で変わったら入力を残して保存させない", async () => {
    const { page, step, env } = s;
    const save = page.getByRole("button", { name: "品質基準を保存" });

    await step("未設定から基準を足し、参照先を選んで保存する", async () => {
      await page.goto("/settings?tab=quality");
      await until.visible(page.getByText(/品質基準はありません（無くても作業は続けられます）/));
      await until.visible(page.getByText(/P3 は確かめ方のコマンドを実行しません/));
      await page.getByRole("button", { name: "基準を足す" }).click();
      const row = page.getByRole("group", { name: "新しい基準 1", exact: true });
      await row.getByLabel("新しい基準 1 の文").fill("API の変更は利用者向けの文書も直す");
      await row.getByLabel("確かめ方（任意）").fill("docs/how-to-use.md と照らす");
      // 文が空なら保存せず理由を出す
      await row.getByLabel("新しい基準 1 の文").fill(" ");
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: /文を書いてください/ }));
      await row.getByLabel("新しい基準 1 の文").fill("API の変更は利用者向けの文書も直す");
      const repos = row.getByRole("group", { name: "新しい基準 1 の対象の参照先" });
      await repos.getByLabel("app", { exact: true }).check();
      await repos.getByLabel("infra", { exact: true }).check();
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      expect((await read(env)).config!.standards).toEqual([{ id: "Q1", text: "API の変更は利用者向けの文書も直す", repos: ["app", "infra"], how: "docs/how-to-use.md と照らす" }]);
    });

    await step("再読み込みしても対象と確かめ方が残り、CLI で足した基準と一緒に並ぶ", async () => {
      await env.p3(["quality", "add", "--text", "lint を通す", "--how", "pnpm lint"]);
      await page.reload();
      const items = page.getByRole("list", { name: "保存済みの品質基準" }).getByRole("listitem");
      await until.count(items, 2);
      await until.visible(items.nth(0).getByText("対象: app, infra"));
      await until.visible(items.nth(0).getByText("確かめ方: docs/how-to-use.md と照らす"));
      await until.visible(items.nth(1).getByText("対象: 全参照先"));
    });

    await step("編集で Q1 を全参照先に戻し、Q2 を消して新しい基準を足しても、Q1 の ID は変わらず番号は使い直さない", async () => {
      await page.getByRole("button", { name: "品質基準を編集" }).click();
      // 参照先の選択を全部外すと全参照先
      const q1Repos = page.getByRole("group", { name: "Q1 の対象の参照先" });
      await q1Repos.getByLabel("app", { exact: true }).uncheck();
      await q1Repos.getByLabel("infra", { exact: true }).uncheck();
      await page.getByRole("group", { name: "Q2", exact: true }).getByRole("button", { name: "この基準を消す" }).click();
      await page.getByRole("button", { name: "基準を足す" }).click();
      await page.getByLabel("新しい基準 2 の文").fill("画面の文言は用語集に従う");
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      expect((await read(env)).config!.standards.map((x) => [x.id, x.repos ?? null])).toEqual([
        ["Q1", null],
        ["Q3", null],
      ]);
    });

    await step("編集中に外で変わったら入力を残して保存させず、元に戻すと最新を読む", async () => {
      await page.getByRole("button", { name: "品質基準を編集" }).click();
      await page.getByLabel(/^Q1 の文/).fill("画面で直した文");
      await env.p3(["quality", "rm", "Q3"]);
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: /品質基準が他で変わったので保存しませんでした/ }));
      await until.value(page.getByLabel(/^Q1 の文/), "画面で直した文");
      expect((await read(env)).config!.standards.map((x) => x.id)).toEqual(["Q1"]);
      await page.getByRole("button", { name: "元に戻す" }).click();
      await until.count(page.getByRole("list", { name: "保存済みの品質基準" }).getByRole("listitem"), 1);
    });
  });

  for (const [width, colorScheme] of [
    [375, "light"],
    [1280, "dark"],
  ] as const) {
    it(`幅 ${width}・${colorScheme === "dark" ? "暗い" : "明るい"}テーマ: 一覧・編集がはみ出さず、キーボードで保存と取消に届く`, async () => {
      const page: Page = await s.open({ width, height: 700, colorScheme });
      await s.step(
        `${width}`,
        async () => {
          await page.goto("/settings?tab=quality");
          const edit = page.getByRole("button", { name: "品質基準を編集" });
          await until.visible(edit);
          expect(await isDark(page)).toBe(colorScheme === "dark");
          expect(await pageOverflow(page)).toEqual([]);
          await edit.focus();
          await page.keyboard.press("Enter");
          const add = page.getByRole("button", { name: "基準を足す" });
          await until.visible(add);
          await add.focus();
          await page.keyboard.press("Enter");
          expect(await pageOverflow(page)).toEqual([]);
          expect(await reachable(page.getByRole("button", { name: "品質基準を保存" }), "保存")).toEqual([]);
          // 取消（元に戻す）もキーボードで押せて、編集をやめる
          const cancel = page.getByRole("button", { name: "元に戻す" });
          expect(await reachable(cancel, "元に戻す")).toEqual([]);
          await cancel.focus();
          await page.keyboard.press("Enter");
          await until.visible(edit);
        },
        page,
      );
      await page.context().close();
    });
  }
});
