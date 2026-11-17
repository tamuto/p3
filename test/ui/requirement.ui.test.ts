// 要求の出典と確認・確認事項への回答の画面: 根拠を入れずに要望を作れること、要望の記録の保存と再読み込み・確認の記録・本文の変更での
// 再確認の表示、未保存の間の評価の開始の停止、外の変更との競合で入力を残すこと、clarify の確認事項のカード（確認先・質問・必要な根拠）と
// 回答の保存・古い評価の案内・明示の再評価、以前の文の確認事項とメモ欄、タスク詳細と案の詳細の基準ごとの記録、実装後の証拠と別の欄、
// 幅 375 / 1280 で長い出典・根拠がはみ出さないこととキーボードでの到達を確かめる。状態は CLI で用意する。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_SOURCE = `経理規程 第3版 ${"第4章第2節第3項（端数の扱い）".repeat(4)} https://example.com/${"very-long-path-segment/".repeat(6)}rule.pdf`;
const ids = { plain: "", sources: "", clarify: "", task: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  // 根拠のある要望（S1 は確認記録あり、S2 は出典だけ）
  ids.sources = (await j(["request", "new", "請求の端数を直す", "--body", "-"], "請求の消費税の端数を規程に合わせる。\n- 計算を直す\n- 画面に出す\n")).id;
  await env.p3(["source", ids.sources, "add", "--target", "消費税の端数は切り捨て", "--source", "経理規程 3.2", "--grounds", "1,234 円 × 10% = 123 円", "--by", "経理担当", "--on", "2026-11-01"]);
  await env.p3(["source", ids.sources, "add", "--source", LONG_SOURCE]);
  await env.p3(["preflight", ids.sources, "--engine", "mock"]);
  // clarify の要望（Mock は短い本文で確認事項 Q1 を出す）
  ids.clarify = (await j(["request", "new", "締め日を決める", "--body", "-"], "短い\n")).id;
  await env.p3(["preflight", ids.clarify, "--engine", "mock"]);
  // タスクの基準の記録
  ids.task = (await j(["request", "new", "基準の出典", "--body", "-"], "基準ごとの出典。\n")).id;
  await env.p3(["new", "端数の計算", "--req", ids.task, "--criterion", "端数を切り捨てる", "--criterion", "幅 375 で横にはみ出さない"]);
  await env.p3(["source", "T001", "A1", "add", "--source", "経理規程 3.2", "--grounds", "123 円", "--req", ids.task]);
}

describe.skipIf(!inject("chromium").available)("要求の出典と確認", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("要求の出典と確認", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("根拠を入れなくても要望を作れる。記録なしは未記録で、確認済みにしない", async () => {
    const { page, step } = s;
    await step("新規の要望は今までどおり題だけで作れる", async () => {
      await page.goto("/requests/new");
      await page.getByLabel("タイトル", { exact: true }).fill("根拠なしの要望");
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.url(page, /\/requests\/\d{6}-[a-z0-9]{5}/);
      ids.plain = /\/requests\/(\d{6}-[a-z0-9]{5})/.exec(page.url())![1];
      const panel = page.locator("details").filter({ hasText: "要求の出典と確認（任意）" });
      await until.visible(panel.getByText("未記録", { exact: true }));
      expect(JSON.parse(await s.env.p3(["source", ids.plain, "--json"]))).toMatchObject({ state: "unrecorded", sources: [] });
    });
  });

  it("要望の記録: 保存して再読み込みしても残り、確認を記録でき、本文を変えると再確認が必要と出る。未保存の間は評価を始めない", async () => {
    const { page, step, env } = s;
    const panel = page.locator("details").filter({ hasText: "要求の出典と確認（任意）" });
    const start = page.getByRole("button", { name: /Preflight を実行|もう一度 Preflight/ });
    await step("記録と状態を文字で見せる（色だけにしない）", async () => {
      await page.goto(`/requests/${ids.sources}`);
      await until.visible(panel.getByTestId("source-S1").getByText("確認記録あり", { exact: true }));
      await until.visible(panel.getByTestId("source-S1").getByText("確かめた人 経理担当・2026-11-01"));
      await until.visible(panel.getByTestId("source-S2").getByText("未確認", { exact: true }));
    });
    await step("入力中は Preflight の開始を止め、取消で戻る", async () => {
      await panel.getByRole("button", { name: "＋ 出典と根拠を追加" }).click();
      await panel.getByLabel("出典（誰の要求か・資料の名前・版・節）").fill("業務の担当の確認メモ");
      await until.disabled(start);
      await until.visible(page.getByText(/要求の出典と確認か、確認事項への回答が未保存です/).first());
      await panel.getByRole("button", { name: "取消" }).click();
      await until.enabled(start);
    });
    await step("追加して保存し、再読み込みしても残る", async () => {
      await panel.getByRole("button", { name: "＋ 出典と根拠を追加" }).click();
      await panel.getByLabel("対象の要求・前提").fill("請求の締めは月末");
      await panel.getByLabel("出典（誰の要求か・資料の名前・版・節）").fill("営業の担当の依頼");
      await panel.getByRole("button", { name: "保存" }).click();
      await until.visible(panel.getByTestId("source-S3").getByText("未確認", { exact: true }));
      await page.reload();
      await until.visible(panel.getByTestId("source-S3").getByText("請求の締めは月末"));
    });
    await step("根拠が無ければ確認を記録できず理由を出す。根拠を足して確認を記録する", async () => {
      await panel.getByTestId("source-S3").getByRole("button", { name: "確認を記録" }).click();
      await panel.getByLabel("確かめた役割・アクター").fill("営業の担当");
      await panel.getByLabel("確かめた日").fill("2026-11-10");
      await panel.getByRole("button", { name: "保存" }).click();
      await until.visible(panel.getByText(/根拠が要ります/));
      // 入力は残る
      await until.value(panel.getByLabel("確かめた役割・アクター"), "営業の担当");
      await panel.getByRole("button", { name: "取消" }).click();
      await panel.getByTestId("source-S3").getByRole("button", { name: "編集" }).click();
      await panel.getByLabel("根拠（承認された計算例・規則や契約の該当箇所など）").fill("2026-11-10 の打ち合わせの記録");
      await panel.getByLabel("確かめた役割・アクター").fill("営業の担当");
      await panel.getByLabel("確かめた日").fill("2026-11-10");
      await panel.getByRole("button", { name: "保存" }).click();
      await until.visible(panel.getByTestId("source-S3").getByText("確認記録あり", { exact: true }));
    });
    await step("本文を外で変えると再確認が必要と出る", async () => {
      await env.p3(["request", "set", ids.sources, "--body", "請求の消費税の端数を規程に合わせる（改）。\n"]);
      await page.reload();
      await until.visible(panel.getByTestId("source-S1").getByText("再確認が必要", { exact: true }));
      await until.visible(panel.getByTestId("source-S1").getByText(/前の確認: 経理担当・2026-11-01/));
    });
    await step("外の変更との競合では入力を残して理由を出す", async () => {
      await panel.getByRole("button", { name: "＋ 出典と根拠を追加" }).click();
      await panel.getByLabel("出典（誰の要求か・資料の名前・版・節）").fill("競合する入力");
      await env.p3(["source", ids.sources, "add", "--source", "外で足した"]);
      await panel.getByRole("button", { name: "保存" }).click();
      await until.visible(panel.getByText(/他で更新されました。入力は残しています/));
      await until.value(panel.getByLabel("出典（誰の要求か・資料の名前・版・節）"), "競合する入力");
      await panel.getByRole("button", { name: "取消" }).click();
    });
    const saved = JSON.parse(await env.p3(["source", ids.sources, "--json"])) as { sources: { id: string; state: string }[] };
    expect(saved.sources.map((x) => [x.id, x.state])).toEqual([["S1", "reconfirm"], ["S2", "unconfirmed"], ["S3", "reconfirm"], ["S4", "unconfirmed"]]);
  });

  it("確認事項: 確認先・質問・必要な根拠をカードで見せ、回答を要望に保存してから明示して再評価する。以前の文の確認事項とメモ欄も使える", async () => {
    const { page, step } = s;
    const section = page.getByRole("region", { name: "確認事項と回答" });
    await step("カードに確認先・質問・対象・必要な根拠・判断への影響・元の run と ID", async () => {
      await page.goto(`/requests/${ids.clarify}`);
      const card = section.getByTestId("clarification-Q1");
      await until.visible(card.getByText("未回答", { exact: true }));
      await until.visible(card.getByText("要望者に確認先を特定してもらう"));
      await until.visible(card.getByText("完了条件をより具体的にしてください"));
      await until.visible(card.getByText(/完了したと確かめられる条件/));
      await until.visible(card.getByText(/PF-.*\/Q1/));
      // 文の確認事項とメモ欄への案内も残る
      await until.visible(page.getByRole("link", { name: "メモ欄で答える ↓" }));
    });
    await step("回答の入力中は評価を始めず、保存すると回答済み。古い評価からはタスク化できない案内に変わる", async () => {
      const card = section.getByTestId("clarification-Q1");
      await card.getByRole("button", { name: "回答する" }).click();
      await card.getByLabel("回答", { exact: true }).fill("完了条件は、月末の締めで請求書が出ること");
      await card.getByLabel("回答した役割・アクター（任意）").fill("経理担当");
      await until.disabled(page.getByRole("button", { name: /もう一度 Preflight/ }));
      await card.getByRole("button", { name: "回答を要望に保存" }).click();
      await until.visible(card.getByText("回答済み", { exact: true }));
      await until.visible(card.getByText("完了条件は、月末の締めで請求書が出ること"));
      await until.visible(page.getByText(/要求の根拠・確認事項への回答が変わりました/).first());
      // 再評価は自動で始まらず、明示のボタン
      await until.enabled(section.getByRole("button", { name: "保存した内容で再評価" }));
      const r = JSON.parse(await s.env.p3(["clarify", ids.clarify, "--json"])) as { items: { state: string }[] };
      expect(r.items.map((i) => i.state)).toEqual(["answered"]);
    });
  });

  it("タスク詳細と案の詳細: 基準ごとの出典と確認を実装後の証拠と別の欄で読み書きできる", async () => {
    const { page, step, env } = s;
    const sec = page.getByRole("region", { name: "受け入れ基準の出典と確認" });
    await step("タスク詳細で状態を読み、記録を足す", async () => {
      await page.goto(`/requests/${ids.task}?task=T001`);
      await until.visible(sec.getByTestId("criterion-sources-A1").getByText("未確認", { exact: true }).first());
      await until.visible(sec.getByTestId("criterion-sources-A2").getByText("未記録", { exact: true }).first());
      // 実装後の証拠の欄とは別の見出し
      await until.visible(page.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }));
      const a2 = sec.getByTestId("criterion-sources-A2");
      await a2.getByRole("button", { name: "＋ 出典と根拠を追加" }).click();
      await a2.getByLabel("出典（誰の要求か・資料の名前・版・節）").fill("画面仕様 v2 4章");
      await a2.getByLabel("根拠（承認された計算例・規則や契約の該当箇所など）").fill("幅 375 の原稿");
      await a2.getByLabel("確かめた役割・アクター").fill("画面の担当");
      await a2.getByLabel("確かめた日").fill("2026-11-12");
      await a2.getByRole("button", { name: "保存" }).click();
      await until.visible(a2.getByText("確認記録あり", { exact: true }).first());
      const t = JSON.parse(await env.p3(["source", "T001", "--req", ids.task, "--json"])) as { items: { id: string; state: string }[] };
      expect(t.items.map((i) => i.state)).toEqual(["unconfirmed", "confirmed"]);
    });
    await step("案の詳細でも基準ごとの記録を足せる", async () => {
      await page.goto(`/requests/${ids.sources}`);
      await page.getByRole("button", { name: "内容を見る" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("受け入れ基準の出典と確認（任意）").click();
      const a1 = dialog.getByTestId("criterion-sources-A1");
      await a1.getByRole("button", { name: "＋ 出典と根拠を追加" }).click();
      await a1.getByLabel("要望の記録を写す（任意。確認は引き継ぎません）").selectOption("S1");
      await a1.getByRole("button", { name: "保存" }).click();
      await until.visible(a1.getByText("要望の S1 を写したもの"));
    });
  });

  it("幅 375 / 1280: 長い出典・根拠でページが横にはみ出さず、キーボードで編集・保存・取消・回答欄に届く", async () => {
    for (const width of [1280, 375]) {
      const p = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await p.goto(`/requests/${ids.sources}`);
          const panel = p.locator("details").filter({ hasText: "要求の出典と確認（任意）" });
          await until.visible(panel.getByText(LONG_SOURCE));
          expect(await pageOverflow(p)).toEqual([]);
          const edit = panel.getByTestId("source-S2").getByRole("button", { name: "編集" });
          expect(await reachable(edit, "編集")).toEqual([]);
          await edit.focus();
          await p.keyboard.press("Enter");
          expect(await reachable(panel.getByRole("button", { name: "保存" }), "保存")).toEqual([]);
          expect(await reachable(panel.getByRole("button", { name: "取消" }), "取消")).toEqual([]);
          expect(await pageOverflow(p)).toEqual([]);
          await panel.getByRole("button", { name: "取消" }).click();
          await p.goto(`/requests/${ids.clarify}`);
          const card = p.getByTestId("clarification-Q1");
          // 前の手順で回答を保存しているので、回答済みの表示がそろってから操作する
          await until.visible(card.getByText("回答済み", { exact: true }));
          const btn = card.getByRole("button", { name: /回答を直す|回答する/ });
          expect(await reachable(btn, "回答")).toEqual([]);
          await btn.focus();
          await p.keyboard.press("Enter");
          expect(await reachable(card.getByLabel("回答", { exact: true }), "回答欄")).toEqual([]);
          expect(await pageOverflow(p)).toEqual([]);
        },
        p,
      );
    }
  });
});
