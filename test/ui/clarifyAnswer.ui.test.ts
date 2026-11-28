// 確認事項への回答の画面: clarify の確認事項のカード（確認先・質問・対象・必要な根拠・判断への影響・元の run と ID）、回答（回答・回答した
// 役割・日）の保存と回答済みの表示、入力中は評価を始めないこと、古い評価の案内と明示の再評価、以前の文の確認事項とメモ欄への案内、
// 幅 375 / 1280 ではみ出さないこととキーボードでの到達を確かめる。状態は CLI で用意する。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { clarify: "" };

async function prepare(env: UiEnv) {
  // clarify の要望（Mock は短い本文で確認事項 Q1 を出す）
  ids.clarify = (JSON.parse(await env.p3(["request", "new", "締め日を決める", "--body", "-", "--json"], "短い\n")) as { id: string }).id;
  await env.p3(["preflight", ids.clarify, "--engine", "mock"]);
}

describe.skipIf(!inject("chromium").available)("確認事項への回答", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("確認事項への回答", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("確認先・質問・必要な根拠をカードで見せ、回答を要望に保存してから明示して再評価する。メモ欄への案内も残る", async () => {
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
      await until.visible(page.getByRole("link", { name: "メモ欄で答える ↓" }));
    });
    await step("回答の入力中は評価を始めず、保存すると回答済み。古い評価からはタスク化できない案内に変わる", async () => {
      const card = section.getByTestId("clarification-Q1");
      await card.getByRole("button", { name: "回答する" }).click();
      await card.getByLabel("回答", { exact: true }).fill("完了条件は、月末の締めで請求書が出ること");
      await card.getByLabel("回答した役割・アクター（任意）").fill("経理担当");
      await card.getByLabel("回答の日（任意）").fill("2026-11-10");
      await until.disabled(page.getByRole("button", { name: /もう一度 Preflight/ }));
      await card.getByRole("button", { name: "回答を要望に保存" }).click();
      await until.visible(card.getByText("回答済み", { exact: true }));
      await until.visible(card.getByText("完了条件は、月末の締めで請求書が出ること"));
      await until.visible(page.getByText(/確認事項への回答が変わりました/).first());
      // 再評価は自動で始まらず、明示のボタン
      await until.enabled(section.getByRole("button", { name: "保存した内容で再評価" }));
      const r = JSON.parse(await s.env.p3(["clarify", ids.clarify, "--json"])) as { items: { state: string; answer?: { by?: string; on?: string } }[] };
      expect(r.items.map((i) => [i.state, i.answer?.by, i.answer?.on])).toEqual([["answered", "経理担当", "2026-11-10"]]);
    });
  });

  it("幅 375 / 1280: カードと回答欄がはみ出さず、キーボードで回答欄に届く", async () => {
    for (const width of [1280, 375]) {
      const p = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await p.goto(`/requests/${ids.clarify}`);
          const card = p.getByTestId("clarification-Q1");
          // 前の手順で回答を保存しているので、回答済みの表示がそろってから操作する
          await until.visible(card.getByText("回答済み", { exact: true }));
          expect(await pageOverflow(p)).toEqual([]);
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
