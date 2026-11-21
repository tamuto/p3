// リスクの振り返りの画面: 候補（採用根拠つき）を比べて振り返る評価を確定すること、Preflight の履歴を切り替えても対象が変わらないこと、
// 根拠（手戻り）を照合して確認結果を保存し再読み込み後も確認者・日時・訂正の履歴が読めること、保存の競合で入力を保つこと、候補なしの表示、
// 対象の訂正と過去の対象、幅 375 で横にはみ出さないことを確かめる。状態は CLI で用意する。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { a: "", b: "", run1: "", run2: "" };
const LONG_RISK = `既存の CSV の取り込みが壊れる（${"区切り文字・文字コード・改行コードの違い".repeat(3)}）`;

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  ids.a = (await j(["request", "new", "請求書の書き出し", "--body", "-"], "- PDF で保存する\n- CSV を取り込む\n")).id;
  // タスク化した後は再評価しないので、以前のデータ（同じ要望で2つの run をタスク化した）は、評価を2回してから順にタスク化して作る
  const runOf = async (risks: string[]) => {
    const r = JSON.parse(await env.p3(["preflight", ids.a, "--engine", "mock", "--json"])) as { run?: { id: string }; id?: string };
    const run = r.run?.id ?? r.id!;
    const file = join(env.repo, ".p3", "requests", ids.a, "preflight", run, "run.json");
    const data = JSON.parse(await readFile(file, "utf8")) as { assessment: { risks: string[] } };
    data.assessment.risks = risks;
    await writeFile(file, JSON.stringify(data, null, 2));
    return run;
  };
  ids.run1 = await runOf(["性能が落ちる", LONG_RISK]);
  ids.run2 = await runOf(["二番目の評価のリスク"]);
  await env.p3(["accept", ids.a, "--run", ids.run1]);
  await env.p3(["accept", ids.a, "--run", ids.run2]);
  // T001 を完了 → 済み → 再開（手戻り R1）
  await env.p3(["move", "T001", "done", "--req", ids.a]);
  await env.p3(["check", "T001", "--req", ids.a]);
  await env.p3(["move", "T001", "doing", "--req", ids.a]);
  ids.b = (await j(["request", "new", "まだ評価していない要望"])).id;
}

describe.skipIf(!inject("chromium").available)("リスクの振り返り", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("リスクの振り返り", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  const panelOf = (p: Scenario["page"]) => p.getByRole("region", { name: "リスクの振り返り" });

  it("候補と採用根拠を比べて確定し、Preflight の履歴を切り替えても対象は変わらない", async () => {
    const { page, step } = s;
    const panel = panelOf(page);
    await step("候補なしの要望は理由を出す", async () => {
      await page.goto(`/requests/${ids.b}`);
      await until.visible(panelOf(page).getByText(/振り返れる評価はありません/));
    });
    await step("候補（最新の採用済み・採用根拠・リスクの数）を比べて確定する", async () => {
      await page.goto(`/requests/${ids.a}`);
      await until.visible(panel.getByText("振り返る評価は未確定です。採用した内容を見て1つ選びます。"));
      await until.visible(panel.getByText("最新の採用済み"));
      await until.visible(panel.getByText(/タスク化・T001 .*リスク 2件/));
      await panel.getByRole("radio", { name: new RegExp(ids.run1) }).check();
      await panel.getByRole("button", { name: "この評価を振り返る" }).click();
      await until.visible(panel.getByText("起きた 0件・起きなかった 0件・未確認 2件"));
      await until.visible(panel.getByText(ids.run1, { exact: true }));
    });
    await step("Preflight の履歴で別の評価を開いても、振り返る評価は変わらない", async () => {
      await page.goto(`/requests/${ids.a}?run=${ids.run2}`);
      await until.visible(panel.getByText(ids.run1, { exact: true }));
      await until.visible(panel.getByText("選択外の採用済み評価 1 件"));
      const v = JSON.parse(await s.env.p3(["retro", ids.a, "--json"])) as { target: { run: string; by: string } };
      expect(v.target).toMatchObject({ run: ids.run1, by: "human:web" });
    });
  });

  it("根拠を照合して確認結果を保存し、再読み込みしても確認者・日時・訂正の履歴が読める", async () => {
    const { page, step } = s;
    const panel = panelOf(page);
    const risk2 = panel.getByTestId("risk-2");
    await step("手戻りを根拠に「起きた」と保存する", async () => {
      await page.goto(`/requests/${ids.a}`);
      await risk2.getByRole("button", { name: "根拠を照合して確認する" }).click();
      const form = risk2.getByRole("group", { name: "リスク 2 の確認結果" });
      await form.getByLabel("確認結果").selectOption("occurred");
      await until.visible(form.getByText("「起きた」には確認した事実と根拠が要ります"));
      await form.getByLabel("確認した範囲（対象の成果・時点・範囲）").fill("T001 の成果物で CSV を取り込んだ");
      await form.getByLabel("確認した事実").fill("取り込みが壊れ、T001 を再開して直した");
      await form.getByLabel("種類").selectOption("rework");
      await form.getByLabel("手戻りの履歴").selectOption("R1");
      await form.getByRole("button", { name: "根拠に加える" }).click();
      await form.getByRole("button", { name: "確認結果を保存する" }).click();
      await until.visible(panel.getByText("起きた 1件・起きなかった 0件・未確認 1件"));
    });
    await step("再読み込みしても確認者・日時・当時の抜粋・照合の状態が読める", async () => {
      await page.reload();
      await risk2.getByRole("button", { name: "確認と根拠を見る" }).click();
      const history = risk2.getByRole("list", { name: "リスク 2 の確認の履歴" });
      await until.visible(history.getByText(/J1・human:web・/));
      await until.visible(history.getByText(/当時の抜粋: R1  完了から戻した・済みが外れた/));
      await until.visible(history.getByText("照合済み"));
    });
    await step("判断を戻すには理由が要り、前の判断も残る", async () => {
      const form = risk2.getByRole("group", { name: "リスク 2 の確認結果" });
      await form.getByLabel("確認結果").selectOption("unchecked");
      await until.visible(form.getByText("確認済みの判断を変える・未確認に戻すには理由が要ります"));
      await form.getByLabel("訂正の理由").fill("R1 は別の原因だった");
      await form.getByRole("button", { name: "確認結果を保存する" }).click();
      await until.visible(panel.getByText("起きた 0件・起きなかった 0件・未確認 2件"));
      // 保存した後も確認の欄は開いたまま
      await until.visible(risk2.getByText("訂正の理由: R1 は別の原因だった"));
      await until.count(risk2.getByRole("list", { name: "リスク 2 の確認の履歴" }).locator(":scope > li"), 2);
      const v = JSON.parse(await s.env.p3(["retro", ids.a, "--json"])) as { judgments: { state: string; reason?: string }[] };
      expect(v.judgments.map((j) => [j.state, j.reason])).toEqual([
        ["occurred", undefined],
        ["unchecked", "R1 は別の原因だった"],
      ]);
    });
  });

  it("保存の競合では入力を残して知らせ、確認済みの値を上書きしない", async () => {
    const { page, step, env } = s;
    const panel = panelOf(page);
    const risk1 = panel.getByTestId("risk-1");
    await step("入力中に他で確認が保存されると、保存は断られ入力が残る", async () => {
      await page.goto(`/requests/${ids.a}`);
      await risk1.getByRole("button", { name: "根拠を照合して確認する" }).click();
      const form = risk1.getByRole("group", { name: "リスク 1 の確認結果" });
      await form.getByLabel("種類").selectOption("manual");
      await form.getByLabel("参照（成果物・検証の結果の URL やパス）").fill("https://example.com/perf.md");
      await form.getByRole("button", { name: "根拠に加える" }).click();
      await env.p3(["retro", ids.a, "judge", "1", "--state", "not_occurred", "--scope", "CLI で確かめた範囲", "--evidence", "manual:cli"]);
      await form.getByRole("button", { name: "確認結果を保存する" }).click();
      await until.visible(form.getByText(/他で振り返りが更新されました/));
      await until.visible(form.getByText("https://example.com/perf.md"));
      const v = JSON.parse(await env.p3(["retro", ids.a, "--json"])) as { risks: { state: string }[] };
      expect(v.risks[0].state).toBe("not_occurred");
    });
  });

  it("対象を訂正すると、以前の対象と判断を開ける", async () => {
    const { page, step } = s;
    const panel = panelOf(page);
    await step("理由をつけて訂正し、過去の対象を見る", async () => {
      await page.goto(`/requests/${ids.a}`);
      await panel.getByRole("button", { name: "対象を訂正する" }).click();
      await panel.getByRole("radio", { name: new RegExp(ids.run2) }).check();
      await panel.getByLabel("訂正の理由").fill("追加の範囲で採用し直した");
      await panel.getByRole("button", { name: "この評価に訂正する" }).click();
      await until.visible(panel.getByText("起きた 0件・起きなかった 0件・未確認 1件"));
      await panel.getByRole("button", { name: "過去の対象を見る" }).click();
      const past = panel.getByLabel("過去の対象");
      await until.visible(past.getByText(new RegExp(`V1 ${ids.run1}`)));
      await until.visible(past.getByText(/訂正の理由: R1 は別の原因だった/));
      const v = JSON.parse(await s.env.p3(["retro", ids.a, "--json"])) as { targets: { id: string; reason?: string }[] };
      expect(v.targets.map((t) => [t.id, t.reason])).toEqual([
        ["V1", undefined],
        ["V2", "追加の範囲で採用し直した"],
      ]);
    });
  });

  it("幅 375: 対象・一覧・確認の入力で横にはみ出さず、操作に届く", async () => {
    const p = await s.open({ width: 375, height: 800 });
    await s.step(
      "幅 375",
      async () => {
        await p.goto(`/requests/${ids.a}`);
        const panel = panelOf(p);
        await until.visible(panel.getByText("起きた 0件・起きなかった 0件・未確認 1件"));
        await panel.getByRole("button", { name: "過去の対象を見る" }).click();
        await until.visible(panel.getByText(LONG_RISK).first());
        expect(await pageOverflow(p)).toEqual([]);
        const btn = panel.getByTestId("risk-1").getByRole("button", { name: "根拠を照合して確認する" });
        expect(await reachable(btn, "根拠を照合して確認する")).toEqual([]);
        await btn.click();
        const form = panel.getByRole("group", { name: "リスク 1 の確認結果" });
        expect(await reachable(form.getByLabel("確認結果"), "確認結果")).toEqual([]);
        await form.getByLabel("種類").selectOption("manual");
        await form.getByLabel("参照（成果物・検証の結果の URL やパス）").fill(`https://example.com/${"long-path/".repeat(8)}result.md`);
        await form.getByRole("button", { name: "根拠に加える" }).click();
        expect(await reachable(form.getByRole("button", { name: "確認結果を保存する" }), "保存")).toEqual([]);
        expect(await pageOverflow(p)).toEqual([]);
      },
      p,
    );
  });
});
