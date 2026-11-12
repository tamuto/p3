// 品質の改善要望: 設定の「品質基準」（未設定）から「改善要望の案を確認」→ 不足と原稿 → 題を直して「要望を登録」→ 要望を開ける、
// もう一度開くと登録済みと出て、登録すると既存の要望へ案内する（作らない）、閉じるだけなら何も作らない、幅 375 ではみ出さない。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("品質の改善要望", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質の改善要望");
  });
  afterAll(async () => {
    await s?.close();
  });

  it("案を確認して題を直して登録し、二度目は既存の要望へ案内する。閉じるだけでは作らない", async () => {
    const { page, step, env } = s;
    const dialog = page.getByRole("dialog", { name: /品質の診断/ });
    const requests = async () => JSON.parse(await env.p3(["request", "ls", "--json"])) as { id: string; title: string }[];

    await step("閉じるだけなら何も作らない", async () => {
      await page.goto("/settings?tab=quality");
      await page.getByRole("button", { name: "改善要望の案を確認" }).click();
      await until.visible(dialog.getByRole("region", { name: "品質の不足" }).getByText(/プロジェクトの品質基準が未設定です/));
      await dialog.getByRole("button", { name: "閉じる（登録しない）" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await requests()).toEqual([]);
    });

    await step("原稿の題を直して登録し、要望を開ける", async () => {
      await page.getByRole("button", { name: "改善要望の案を確認" }).click();
      await until.value(dialog.getByLabel("要望の題"), "プロジェクトの品質基準を決める");
      await until.visible(dialog.getByText(/P3 は検査を実行していません/).first());
      await dialog.getByLabel("要望の題").fill("品質基準を決めて書く");
      await dialog.getByRole("button", { name: "要望を登録" }).click();
      await until.visible(dialog.getByRole("status").filter({ hasText: /要望を登録しました/ }));
      await until.visible(dialog.getByRole("link", { name: "要望を開く" }));
      expect((await requests()).map((r) => r.title)).toEqual(["品質基準を決めて書く"]);
    });

    await step("もう一度開くと登録済みと出て、登録すると既存の要望へ案内する", async () => {
      await dialog.getByRole("button", { name: "閉じる（登録しない）" }).click();
      await page.getByRole("button", { name: "改善要望の案を確認" }).click();
      await until.visible(dialog.getByText(/登録済み: .*品質基準を決めて書く/));
      await dialog.getByRole("button", { name: "要望を登録" }).click();
      await until.visible(dialog.getByRole("alert").filter({ hasText: /登録した要望があります/ }));
      await until.visible(dialog.getByRole("link", { name: "既存の要望を開く" }));
      expect(await requests()).toHaveLength(1);
      await dialog.getByRole("button", { name: "閉じる（登録しない）" }).click();
    });
  });

  it("幅 375: ダイアログがはみ出さず、登録に届く", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto("/settings?tab=quality");
        await page.getByRole("button", { name: "改善要望の案を確認" }).click();
        const dialog = page.getByRole("dialog", { name: /品質の診断/ });
        await until.visible(dialog.getByLabel("要望の題"));
        expect(await pageOverflow(page)).toEqual([]);
        expect(await reachable(dialog.getByRole("button", { name: "要望を登録" }), "要望を登録")).toEqual([]);
      },
      page,
    );
  });
});
