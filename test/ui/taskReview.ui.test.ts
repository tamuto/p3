// タスクの AI レビューの画面: タスク詳細の「タスクの AI レビュー」で材料を確かめてから始め、履歴を選んで結果を読む。材料が変わったら
// 知らせて今の材料で確かめ直せる。保存していない入力がある間は始めない。未完了は始められず、アーカイブは履歴を読むだけ。レビューで
// 済みは変わらない。幅 375 で長い根拠・履歴がはみ出さない。状態は CLI で用意する（serve は Mock のエンジン）。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { git } from "../helpers.ts";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { rid: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  ids.rid = (await j(["request", "new", "経費の通知", "--body", "-"], "承認されたら通知する。\n")).id;
  writeFileSync(join(env.repo, "notify.ts"), `export const send = (to: string) => to.length > 0; // ${"長いコメント".repeat(30)}\n`);
  git(env.repo, "add", "notify.ts");
  git(env.repo, "commit", "-q", "-m", "通知を送る");
  const sha = git(env.repo, "rev-parse", "HEAD");
  const req = ["--req", ids.rid];
  await env.p3(["new", "通知を送る", ...req, "--criterion", "承認されたら通知する", "--criterion", "宛先が空なら送らない"]);
  await env.p3(["move", "T001", "done", ...req, "--output", `https://example.com/commit/${sha}`]);
  await env.p3(["new", "途中のタスク", ...req]);
  await env.p3(["new", "捨てたタスク", ...req, "--criterion", "捨てる前の基準"]);
  await env.p3(["move", "T003", "done", ...req, "--output", sha]);
  await env.p3(["review", "T003", ...req, "--engine", "mock"]);
  await env.p3(["archive", "T003", ...req]);
}

describe.skipIf(!inject("chromium").available)("タスクの AI レビュー", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("タスクのレビュー", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("材料を確かめて始め、履歴と結果を読む。材料が変わったら知らせ、保存していない入力がある間は始めない。済みは変わらない", async () => {
    const { page, step, env } = s;
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "タスクの AI レビュー" }) });
    const startBtn = panel.getByRole("button", { name: "新しい Codex のスレッドでレビューを始める" });

    await step("まだ実行していない。始めるには材料を確かめる", async () => {
      await page.goto(`/requests/${ids.rid}?task=T001`);
      await until.visible(panel.getByText("履歴: まだ実行していません"));
      await until.visible(panel.getByText(/作業した AI の能力や成績を採点するものではありません/));
      await until.disabled(startBtn);
      await panel.getByRole("button", { name: "材料を確かめる" }).click();
      await until.visible(panel.getByText(/材料の hash/));
      await until.visible(panel.getByText("宛先が空なら送らない"));
      await until.enabled(startBtn);
    });

    await step("始めると履歴に出て、項目ごとの判定・読めた範囲を読める", async () => {
      await startBtn.click();
      await until.visible(panel.getByRole("listitem", { name: "判定 A1" }).getByText("判断できない"));
      await until.visible(panel.getByRole("listitem", { name: "判定 A2" }));
      await until.visible(panel.getByText(/読めなかった範囲/));
      expect(await panel.getByLabel("レビューの履歴").locator("option").count()).toBe(1);
      // 同じ材料なら「材料が変わりました」は出ない
      expect(await panel.getByText(/材料が変わりました/).count()).toBe(0);
      // レビューで済みは変わらない（人が決める）
      await until.visible(page.getByRole("button", { name: "済みにする" }));
    });

    await step("材料が変わったら知らせ、今の材料で確かめ直せる", async () => {
      await env.p3(["set", "T001", "--req", ids.rid, "--body", "本文を直した"]);
      await until.visible(panel.getByText(/材料が変わりました/));
      await panel.getByRole("button", { name: /今の材料でレビューし直す/ }).click();
      await until.visible(panel.getByText(/材料の hash/));
    });

    await step("保存していない入力がある間は始めない", async () => {
      await page.locator("aside input").first().fill("題を直している途中");
      await until.visible(panel.getByText(/保存していない入力があります/));
      await until.disabled(startBtn);
      await page.getByRole("button", { name: "破棄" }).click();
      await until.enabled(startBtn);
    });

    await step("未完了のタスクは始められない", async () => {
      await page.goto(`/requests/${ids.rid}?task=T002`);
      await until.visible(panel.getByText("レビューは完了したタスクだけ始められます。"));
      expect(await startBtn.count()).toBe(0);
    });

    await step("アーカイブしたタスクは履歴を読むだけ", async () => {
      await page.goto(`/requests/${ids.rid}/archive?archived=T003`);
      const dialog = page.getByRole("dialog", { name: /アーカイブしたタスク/ });
      await until.visible(dialog.getByText(/新しいレビューを始められません/));
      await until.visible(dialog.getByRole("listitem", { name: "判定 A1" }));
      expect(await dialog.getByRole("button", { name: /レビューを始める/ }).count()).toBe(0);
    });
  });

  it("幅 375: 長い根拠・履歴がはみ出さず、材料を確かめて始めるまでに届く", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375 のタスク詳細",
      async () => {
        await page.goto(`/requests/${ids.rid}?task=T001`);
        const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "タスクの AI レビュー" }) });
        await until.visible(panel.getByRole("listitem", { name: "判定 A1" }));
        expect(await pageOverflow(page)).toEqual([]);
        const check = panel.getByRole("button", { name: "材料を確かめる" });
        expect(await reachable(check, "材料を確かめる")).toEqual([]);
        await check.click();
        await until.visible(panel.getByText(/材料の hash/));
        expect(await pageOverflow(page)).toEqual([]);
        expect(await reachable(panel.getByRole("button", { name: "新しい Codex のスレッドでレビューを始める" }), "始める")).toEqual([]);
      },
      page,
    );
  });
});
