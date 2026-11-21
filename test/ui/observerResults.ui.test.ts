// 観測の実行と結果の画面: 詳細の「実行を記録する」→ 実行の指示を見ながら段（前処理・手順・後処理）を記録 → 途中で閉じても続きから →
// 完了して判定 → 詳細と一覧に最後の結果 → 同じ版で期待どおりでない結果が混ざると不安定 → 期待を変えると古い結果と分かる。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

const AI = { kind: "ai-instruction", target: "一覧", steps: ["開く"], judge: "1秒以内", record: "ms に書く" };

describe.skipIf(!inject("chromium").available)("観測の実行と結果", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("画面で実行を記録して判定し、一覧と詳細に最後の結果・不安定・古さが出る", async () => {
    s = await openScenario("観測の結果");
    const { page, step, env } = s;
    const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
    const prep = (await j(["observer", "prep", "add", "--input", "-"], JSON.stringify({ name: "データ", setup: { run: AI }, teardown: { run: AI }, exclusive: [] }))).id;
    const def = { title: "一覧の速さ", description: "x", expected: "1秒以内", preparations: [prep], measures: [{ name: "ms", type: "number", unit: "ms" }], procedures: [{ title: "開く", measures: ["ms"], run: AI }] };
    const id = (await j(["observer", "add", "--input", "-"], JSON.stringify(def))).id;
    let ng = "";
    const stage = () => page.getByRole("combobox", { name: /^段/ });

    await step("詳細の「実行を記録する」で始めると、実行の指示と、最初の段（前処理）を選んだ記録の欄が出る", async () => {
      await page.goto(`/observer/${id}`);
      await until.visible(page.getByText("まだ実行した結果がありません。"));
      await page.getByLabel("環境のメモ（任意）").fill("Chrome");
      await page.getByRole("button", { name: "実行を記録する" }).click();
      await until.url(page, /\/runs\/res-/);
      await until.text(page.locator("pre"), /1\. 準備「データ」の前処理[\s\S]*2\. 手順 P1 開く[\s\S]*4\. 準備「データ」の後処理/);
      await until.value(stage(), `setup:${prep}`);
    });
    await step("前処理を記録すると次の段（手順）に移り、測定値と根拠を入れて記録できる。誤りは知らせる", async () => {
      await page.getByRole("button", { name: "記録する" }).click();
      await until.text(page.getByRole("alert"), /basis\.reference/);
      await page.getByLabel("確かめた内容").fill("画面でデータを確かめた");
      await page.getByRole("button", { name: "記録する" }).click();
      await until.text(page.getByRole("list", { name: "記録した段" }), /前処理 prep-.*: 期待どおり/);
      await until.value(stage(), "procedure:P1");
      await page.getByLabel("測定値 ms（数値・ms）").fill("700");
      await page.getByRole("button", { name: "記録する" }).click();
      await until.text(page.getByRole("list", { name: "記録した段" }), /手順 P1: 期待どおり　ms=700/);
    });
    await step("途中で閉じても続きから記録でき、後処理の失敗は判定を変えずに残り、完了で期待どおりになる", async () => {
      await page.goto(`/observer/${id}`);
      await page.getByRole("link", { name: /実行中の結果の続きを記録する/ }).click();
      await until.value(stage(), `teardown:${prep}`);
      await page.getByRole("combobox", { name: /^判定/ }).selectOption("failed");
      await page.getByLabel("確かめた内容").fill("片付けのスクリプトが無かった");
      await page.getByRole("button", { name: "記録する" }).click();
      await until.text(page.getByRole("list", { name: "記録した段" }), /後処理 .*: 実行できなかった/);
      await page.getByRole("button", { name: "完了して判定する" }).click();
      await until.text(page.getByRole("heading", { level: 1 }), /期待どおり/);
      await until.text(page.getByRole("alert"), /準備「データ」の後処理が実行できなかった（判定は変えません）/);
      await until.visible(page.getByText("理由: すべての手順が期待どおり"));
    });
    await step("同じ版で期待どおりでない結果が混ざると、詳細に不安定、一覧に最後の結果と不安定が出る", async () => {
      const r = (ng = (await j(["observer", "run", id])).id);
      for (const st of [{ phase: "setup", ref: prep }, { phase: "procedure", ref: "P1", result: "unmet" }])
        await env.p3(["observer", "record", id, r, "--input", "-"], JSON.stringify({ result: "met", basis: { kind: "declaration" }, ...st }));
      await env.p3(["observer", "finish", id, r]);
      await page.goto(`/observer/${id}`);
      await until.text(page.getByRole("region", { name: "結果", exact: true }), /不安定: 今の版の結果に「期待どおり」と「期待どおりでない」が混ざっています/);
      await page.goto("/observer");
      const row = page.getByRole("row").filter({ hasText: "一覧の速さ" });
      await until.text(row, /期待どおりでない/);
      await until.text(row, /不安定/);
    });
    await step("期待どおりでなかった結果から、原因の種類を選んで下書きの要望を作ると、結果と要望の詳細が相互にリンクする", async () => {
      await page.goto(`/observer/${id}/runs/${ng}`);
      const panel = page.getByRole("region", { name: "要望を作る" });
      await until.text(panel, /不具合: 観測「一覧の速さ」が期待どおりでない/);
      await panel.getByRole("combobox", { name: /^原因の種類/ }).selectOption("spec");
      await until.text(panel, /仕様のずれ: 観測「一覧の速さ」が期待どおりでない[\s\S]*の期待を〜に変える/);
      await panel.getByRole("button", { name: "下書きの要望を作る" }).click();
      const link = page.getByRole("link", { name: /仕様のずれ: 観測「一覧の速さ」/ });
      await until.visible(link);
      await link.click();
      await until.url(page, /\/requests\/\d{6}-/);
      await page.getByRole("link", { name: new RegExp(`一覧の速さ の結果 ${ng}`) }).click();
      await until.url(page, new RegExp(`/runs/${ng}$`));
    });
    await step("期待を変えると、前の版の結果は古いと分かる（不安定は今の版だけで数える）", async () => {
      await env.p3(["observer", "update", id, "--rev", "1", "--expected", "0.5秒以内", "--reason", "速さを上げた"]);
      await page.goto("/observer");
      const row = page.getByRole("row").filter({ hasText: "一覧の速さ" });
      await until.text(row, /古い（版 1 で実行）/);
      await page.goto(`/observer/${id}`);
      await until.visible(page.getByRole("region", { name: "結果", exact: true }).getByText("古い（版 1 で実行）").first());
    });
    // 画面で記録した結果も CLI と同じ記録（2件・定義は期待の変更で版 2 だけ）
    const listed = JSON.parse(await env.p3(["observer", "results", id, "--json"])) as { results: { verdict: string; rev: number }[] };
    expect(listed.results.map((x) => [x.verdict, x.rev])).toEqual([["unmet", 1], ["met", 1]]);
    expect(JSON.parse(await env.p3(["observer", "followup", id, ng, "--json"])).existing.title).toBe("仕様のずれ: 観測「一覧の速さ」が期待どおりでない");
  });
});
