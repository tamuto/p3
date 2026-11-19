// 開発の指標の画面: 共通のナビゲーションから開き、プロジェクト全体と登録済みのマイルストーンを切り替えられること、値・単位・対象・欠損・算出方法を
// 読めること、読み込み失敗・対象なし・記録なし・観測できたゼロを見分けられること、人の記録の期間・出典と CLI の記録のしかた、狭い画面とキーボードでの
// 範囲の選択・再読み込み・算出方法の閲覧を確かめる。状態は CLI で用意し、値は CLI（p3 metrics --json）と同じものを出すことを照らす。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";
import type { MetricsReport } from "../../packages/tasks/src/features/metrics/shared/metrics.ts";

const ids = { a: "" };

async function prepare(env: UiEnv) {
  await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
  await env.p3(["milestone", "add", "v2", "--title", "まだ空"]);
  ids.a = (JSON.parse(await env.p3(["request", "new", "請求書の書き出し", "--milestone", "v1", "--json"])) as { id: string }).id;
  await env.p3(["add", "PDF で保存する", "--req", ids.a, "--criterion", "PDF を保存できる"]);
  await env.p3(["move", "T001", "done", "--req", ids.a, "--record", "PDF の保存を足した", "--evidence", "A1=met:テストを通した"]);
  await env.p3(["request", "set", ids.a, "status=resolved"]);
  await env.p3(["metrics", "record", "cost", "12000", "--unit", "JPY", "--from", "2026-11-01", "--to", "2026-11-17", "--source", "利用明細", "--milestone", "v1"]);
  await env.p3(["metrics", "record", "post_release_defects", "0", "--from", "2026-11-01", "--to", "2026-11-30", "--source", "不具合の管理表"]);
}

describe.skipIf(!inject("chromium").available)("開発の指標", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("開発の指標", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  const card = (p: Scenario["page"], id: string) => p.getByTestId(`metric-${id}`);

  it("ナビゲーションから開き、範囲を切り替えると CLI と同じ値・単位・対象・欠損を出す", async () => {
    const { page, step, env } = s;
    await step("共通のナビゲーションから開く（プロジェクト全体）", async () => {
      await page.goto("/");
      await page.getByRole("link", { name: "開発の指標" }).click();
      await until.url(page, /\/metrics/);
      await until.visible(page.getByTestId("metrics-scope").getByText("表示中: プロジェクト全体"));
      expect(await page.getByLabel("集計範囲").inputValue()).toBe("");
    });
    await step("マイルストーンに切り替えると、URL と表示中の範囲が変わる", async () => {
      await page.getByLabel("集計範囲").selectOption("v1");
      await until.url(page, /m=v1/);
      await until.visible(page.getByTestId("metrics-scope").getByText("表示中: v1 最初のリリース"));
      const cli = JSON.parse(await env.p3(["metrics", "--milestone", "v1", "--json"])) as MetricsReport;
      const met = cli.metrics.find((m) => m.id === "acceptance_met")!;
      expect(met).toMatchObject({ value: 1, denominator: 1, targets: 1, missing: 0 });
      await until.text(card(page, "acceptance_met").getByTestId("metric-value"), "1 件 / 基準 1 件");
      await until.visible(card(page, "acceptance_met").getByText("対象 1・値に入れた 1・欠損 0"));
      const resolved = cli.metrics.find((m) => m.id === "request_to_resolved")!;
      expect(resolved.state).toBe("ok");
      await until.text(card(page, "request_to_resolved").getByTestId("metric-value"), `${resolved.value!.toLocaleString()} 時間`);
    });
  });

  it("読み込み失敗・対象なし・記録なし・観測できたゼロを見分け、人の記録の期間・出典と CLI の記録のしかたを読める", async () => {
    const { page, step } = s;
    await step("観測できたゼロと記録なし", async () => {
      await page.goto("/metrics?m=v1");
      await until.text(card(page, "acceptance_unmet").getByTestId("metric-value"), "0 件 / 基準 1 件");
      await until.visible(card(page, "acceptance_unmet").getByText("値あり"));
      await until.text(card(page, "review_missing").getByTestId("metric-value"), "記録なし");
      const cli = JSON.parse(await s.env.p3(["metrics", "--milestone", "v1", "--json"])) as MetricsReport;
      expect(cli.metrics.find((m) => m.id === "acceptance_unmet")).toMatchObject({ state: "ok", value: 0 });
      expect(cli.metrics.find((m) => m.id === "review_missing")).toMatchObject({ state: "unrecorded", value: null });
      await until.text(card(page, "post_release_defects").getByTestId("metric-value"), "記録なし");
    });
    await step("人の記録は期間・出典と記録のしかたを出す（0 の記録は 0）", async () => {
      const cost = card(page, "cost");
      await until.visible(cost.getByText(/2026-11-01〜2026-11-17・12,000 JPY・出典: 利用明細/));
      await cost.getByText("CLI での記録のしかた").click();
      await until.visible(cost.getByText(/p3 metrics record cost <金額> --unit JPY/));
      await page.getByLabel("集計範囲").selectOption("");
      await until.text(card(page, "post_release_defects").getByTestId("metric-value"), "0 件");
      await until.text(card(page, "cost").getByTestId("metric-value"), "記録なし");
    });
    await step("対象なし（要望の無いマイルストーン）", async () => {
      await page.getByLabel("集計範囲").selectOption("v2");
      await until.text(card(page, "acceptance_unmet").getByTestId("metric-value"), "対象なし");
      await until.text(card(page, "request_to_resolved").getByTestId("metric-value"), "対象なし");
    });
    await step("読み込み失敗（登録に無いマイルストーン）は知らせ、全体へ戻れる", async () => {
      await page.goto("/metrics?m=nope");
      await until.visible(page.getByRole("alert").getByText(/指標を読み込めませんでした: .*登録されていません/));
      await page.getByRole("alert").getByRole("link", { name: "プロジェクト全体を開く" }).click();
      await until.visible(page.getByTestId("metrics-scope").getByText("表示中: プロジェクト全体"));
    });
  });

  it("算出方法と内訳を開ける。再読み込みで CLI の新しい記録を取り込む", async () => {
    const { page, step, env } = s;
    await step("算出方法・欠損の扱い・内訳", async () => {
      await page.goto("/metrics?m=v1");
      const c = card(page, "acceptance_met");
      await c.getByText("算出方法と内訳").click();
      await until.visible(c.getByText(/算出: 今の基準のうち/));
      await until.visible(c.getByText(/欠損の扱い: /));
      await until.visible(c.getByRole("list", { name: "満たしたと申告した受け入れ基準の内訳" }).getByText(/根拠: 申告のみ: 1/));
    });
    await step("CLI で記録した値を再読み込みで出す", async () => {
      await env.p3(["metrics", "record", "post_release_defects", "3", "--from", "2026-11-01", "--to", "2026-11-30", "--source", "不具合の管理表", "--milestone", "v1"]);
      await page.getByRole("button", { name: "指標を読み込み直す" }).click();
      await until.text(card(page, "post_release_defects").getByTestId("metric-value"), "3 件");
      const cli = JSON.parse(await env.p3(["metrics", "--milestone", "v1", "--json"])) as MetricsReport;
      expect(cli.metrics.find((m) => m.id === "post_release_defects")?.rows?.map((r) => r.value)).toEqual([3]);
    });
  });

  it("幅 375: 横にはみ出さず、キーボードで範囲の選択・再読み込み・算出方法の閲覧ができる", async () => {
    const p = await s.open({ width: 375, height: 800 });
    await s.step(
      "幅 375",
      async () => {
        await p.goto("/metrics");
        await until.visible(p.getByTestId("metrics-scope"));
        expect(await pageOverflow(p)).toEqual([]);
        const select = p.getByLabel("集計範囲");
        expect(await reachable(select, "集計範囲")).toEqual([]);
        await select.focus();
        await select.selectOption("v1");
        await until.url(p, /m=v1/);
        await p.keyboard.press("Tab");
        await until.text(p.locator(":focus"), "指標を読み込み直す");
        await p.keyboard.press("Enter");
        await until.visible(p.getByTestId("metrics-scope").getByText("表示中: v1 最初のリリース"));
        const summary = card(p, "request_to_resolved").getByText("算出方法と内訳");
        await summary.focus();
        await p.keyboard.press("Enter");
        await until.visible(card(p, "request_to_resolved").getByText(/算出: 到達した要望の経過時間の中央値/));
        await card(p, "cost").getByText("CLI での記録のしかた").click();
        expect(await pageOverflow(p)).toEqual([]);
      },
      p,
    );
  });
});
