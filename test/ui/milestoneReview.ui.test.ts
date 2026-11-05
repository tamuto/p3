// リリースノートの「マイルストーンレビュー」タブ: 未設定の案内 → 目的・予定機能を書く → 任意実行 → 結果 → 履歴、目的だけ、材料の変更の知らせと再実行、
// 実行中の取消、失敗（壊れた記録）を隠さないこと、URL（?tab=review&m=&run=）で開けること、タブを往復しても入力が残ること、
// レビューの状態にかかわらずリリースノートの保存ができること、幅 1280 / 375 での収まりを確かめる。Mock で動かす（Codex は使わない）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("マイルストーンレビューのタブ", () => {
  let s: Scenario;
  const panel = (page: Page) => page.getByRole("tabpanel", { name: "マイルストーンレビュー" });
  const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}(?!レビュー)`) });
  const reload = (page: Page) => page.getByRole("button", { name: "再読み込み" }).click();

  beforeAll(async () => {
    s = await openScenario("マイルストーンレビューのタブ", {
      prepare: async (env) => {
        await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
        await env.p3(["milestone", "add", "v2", "--title", "目的だけ"]);
        await env.p3(["milestone", "purpose", "v2", "--body", "申請の手間を減らす"]);
        const rid = (JSON.parse(await env.p3(["request", "new", "経費の申請", "--body", "経費を申請できるようにする", "--milestone", "v1", "--json"])) as { id: string }).id;
        await env.p3(["new", "申請の画面", "--req", rid]);
      },
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("目的も予定機能も無ければ案内して実行させない。書いて保存すると実行でき、結果と履歴が出る。URL で開ける", async () => {
    const { page, step } = s;
    await step("未設定の案内", async () => {
      await page.goto("/release-notes?tab=review&m=v1");
      expect(await tab(page, "マイルストーンレビュー").getAttribute("aria-selected")).toBe("true");
      await until.visible(panel(page).getByText(/目的も予定機能もまだありません/));
      expect(await panel(page).getByRole("button", { name: "レビューを実行" }).isDisabled()).toBe(true);
      await until.visible(panel(page).getByText(/所属する要望 1 件/));
      // 確かめるコード（参照先）を出す
      await until.visible(panel(page).getByText(/確かめるコード/).first());
    });
    await step("マイルストーンのタブで予定機能を書いて保存し、レビューのタブに戻ると実行できる", async () => {
      await panel(page).getByRole("link", { name: /目的・予定機能を書く・直す/ }).click();
      await until.url(page, /tab=milestones/);
      const mpanel = page.getByRole("tabpanel", { name: "マイルストーン" });
      const ids = await mpanel.getByLabel("ID", { exact: true }).evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value));
      const row = mpanel.getByRole("listitem").nth(ids.indexOf("v1"));
      await row.getByRole("button", { name: /目的・予定機能/ }).click();
      await row.getByLabel("目的").fill("経費の申請を紙からなくす");
      await row.getByRole("button", { name: "＋ 予定機能を追加" }).click();
      await row.getByLabel("予定機能 G1", { exact: true }).fill("申請の画面");
      // 保存する前は、レビューのタブに書きかけを使わないと出る
      await tab(page, "マイルストーンレビュー").click();
      await until.visible(panel(page).getByText(/保存していない変更があります/));
      await tab(page, "マイルストーン").click();
      await mpanel.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(mpanel.getByRole("status").filter({ hasText: "保存しました" }));
      await tab(page, "マイルストーンレビュー").click();
      await until.visible(panel(page).getByText("申請の画面").first());
      await until.enabled(panel(page).getByRole("button", { name: "レビューを実行" }));
    });
    await step("実行すると実行中が出て、終わると結果（4 区分のどれか・理由・範囲）と履歴が出る", async () => {
      await panel(page).getByRole("button", { name: "レビューを実行" }).click();
      await until.visible(panel(page).getByText(/実行中です/));
      await until.visible(panel(page).getByText("判断材料不足").first());
      await until.visible(panel(page).getByText(/（Mock）評価していません/).first());
      await until.visible(panel(page).getByText(/テストやアプリを実際に動かしてはいません|実装・実際の動作・公開されたかは確かめていません/).first());
      await until.count(panel(page).getByRole("list", { name: "レビューの履歴" }).getByRole("listitem"), 1);
      await until.visible(panel(page).getByRole("button", { name: "もう一度実行", exact: true }));
    });
    await step("履歴の run を選ぶと URL に入り、その URL で開ける。評価したときの材料を読める", async () => {
      await panel(page).getByRole("list", { name: "レビューの履歴" }).getByRole("button").first().click();
      await until.url(page, /run=MR-/);
      const url = page.url();
      await page.goto(url);
      await until.visible(panel(page).getByRole("heading", { name: /選んだ記録/ }));
      await panel(page).getByText(/評価したときの材料/).click();
      await until.visible(panel(page).getByText("経費を申請できるようにする"));
    });
  });

  it("材料が変わると知らせ、もう一度実行できる。実行中は取り消せ、取消の後も前の成功結果を読める", async () => {
    const { page, step } = s;
    await step("予定機能を CLI で足すと、評価の後に変わったと出る", async () => {
      await page.goto("/release-notes?tab=review&m=v1");
      await until.visible(panel(page).getByRole("heading", { name: /最後の成功結果/ }));
      await s.env.p3(["milestone", "goal", "add", "v1", "承認の画面"]);
      await reload(page);
      await until.visible(panel(page).getByText(/評価した後に、目的・予定機能か要望・タスク、参照先のコードが変わっています/));
    });
    await step("もう一度実行してすぐ取り消すと取消になり、前の成功結果は残る", async () => {
      await panel(page).getByRole("button", { name: "もう一度実行", exact: true }).click();
      await panel(page).getByRole("button", { name: "取消" }).click();
      await until.visible(panel(page).getByRole("heading", { name: /最新の実行: 取消/ }));
      await until.visible(panel(page).getByRole("heading", { name: /最後の成功結果/ }));
      await until.visible(panel(page).getByText("判断材料不足").first());
      const runs = JSON.parse(await s.env.p3(["milestone", "reviews", "v1", "--json"])) as { run: { status: string } }[];
      expect(runs.map((r) => r.run.status)).toEqual(["cancelled", "completed"]);
    });
  });

  it("目的だけのマイルストーンは目的を評価する。壊れた記録は履歴に出す。レビューの状態にかかわらずリリースノートは保存できる。タブを往復しても入力が残る", async () => {
    const { page, step } = s;
    await step("目的だけ", async () => {
      await page.goto("/release-notes?tab=review&m=v2");
      await until.visible(panel(page).getByText(/目的そのものを評価します/));
      await panel(page).getByRole("button", { name: "レビューを実行" }).click();
      await until.visible(panel(page).getByRole("list", { name: "比較単位ごとの判定" }).getByText("目的", { exact: true }));
      const runs = JSON.parse(await s.env.p3(["milestone", "reviews", "v2", "--json"])) as { units: { id: string }[] }[];
      expect(runs[0].units.map((u) => u.id)).toEqual(["purpose"]);
    });
    await step("壊れた記録は読めない記録として出る", async () => {
      const dir = join(s.env.repo, ".p3", "milestone-reviews", "v2", "MR-20260101-000000-abcd");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.json"), "{ 壊れ");
      await reload(page);
      await until.visible(panel(page).getByText(/読めない記録/));
    });
    await step("ノートを書きかけてレビューのタブと往復しても残り、保存できる", async () => {
      await page.goto("/release-notes?m=v2");
      const body = page.locator("#rn-body");
      await body.fill("## 目的だけ\n");
      await tab(page, "マイルストーンレビュー").click();
      await tab(page, "リリースノート").click();
      await until.value(body, "## 目的だけ\n");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "保存しました" }));
    });
  });

  for (const width of [1280, 375]) {
    it(`幅 ${width} で、主な操作に届き、ページが横にはみ出さない`, async () => {
      const page = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await page.goto("/release-notes?tab=review&m=v1");
          await until.visible(panel(page).getByRole("button", { name: "もう一度実行", exact: true }));
          expect(await pageOverflow(page)).toEqual([]);
          const run = panel(page).getByRole("button", { name: "もう一度実行", exact: true });
          await run.scrollIntoViewIfNeeded();
          expect(await inViewport(page, run, "もう一度実行")).toEqual([]);
          const first = panel(page).getByRole("list", { name: "レビューの履歴" }).getByRole("button").first();
          await first.scrollIntoViewIfNeeded();
          expect(await inViewport(page, first, "履歴")).toEqual([]);
          // キーボードで履歴を選べる
          await first.focus();
          await page.keyboard.press("Enter");
          await until.url(page, /run=MR-/);
        },
        page,
      );
      await page.context().close();
    });
  }
});
