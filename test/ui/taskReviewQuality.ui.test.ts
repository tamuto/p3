// タスクのレビューの品質の欄: 材料を確かめると品質基準（版・判定する基準・除外）が出る、結果に品質の欄（基準ごとの判定）が
// タスクの比較項目とは別に出る、品質基準を変えると「材料が変わりました」になる、幅 375 ではみ出さない。serve は Mock のエンジン。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { git } from "../helpers.ts";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { rid: "" };

async function prepare(env: UiEnv) {
  await env.p3(["quality", "add", "--text", "lint が通る", "--command", "pnpm lint", "--success", "終了コード 0"]);
  await env.p3(["quality", "add", "--text", "除外する基準", "--reference", "r"]);
  await env.p3(["quality", "exempt", "Q2", "--reason", "この製品には当てはまらない"]);
  writeFileSync(join(env.repo, "notify.ts"), "export const send = () => true;\n");
  git(env.repo, "add", "notify.ts");
  git(env.repo, "commit", "-q", "-m", "通知");
  const sha = git(env.repo, "rev-parse", "HEAD");
  ids.rid = (JSON.parse(await env.p3(["request", "new", "通知", "--body", "-", "--json"], "通知。\n")) as { id: string }).id;
  await env.p3(["new", "送る", "--req", ids.rid, "--criterion", "送れる"]);
  await env.p3(["move", "T001", "done", "--req", ids.rid, "--output", sha]);
  await env.p3(["review", "T001", "--req", ids.rid, "--engine", "mock"]);
}

describe.skipIf(!inject("chromium").available)("タスクのレビューの品質", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("レビューの品質", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("品質の欄が比較項目とは別に出て、品質基準を変えると材料が変わったと知らせる", async () => {
    const { page, step, env } = s;
    const review = page.locator("section").filter({ has: page.getByRole("heading", { name: "タスクの AI レビュー" }) });
    await step("結果の品質の欄", async () => {
      await page.goto(`/requests/${ids.rid}?task=T001`);
      const quality = review.getByRole("region", { name: "品質", exact: true });
      await until.visible(quality.getByRole("listitem", { name: "品質 Q1" }).getByText("判断できない"));
      await until.visible(quality.getByText(/Q2 除外（この製品には当てはまらない）/));
      expect(await review.getByRole("listitem", { name: "判定 A2" }).count()).toBe(1);
    });
    await step("材料を確かめると品質基準の版と判定する基準が出る", async () => {
      await review.getByRole("button", { name: "材料を確かめる" }).click();
      await until.visible(review.getByText(/品質基準: 版 .*・判定する Q1・除外 Q2/));
    });
    await step("品質基準を変えると材料が変わったと知らせる", async () => {
      await env.p3(["quality", "set", "Q1", "--text", "lint が警告なしで通る"]);
      await until.visible(review.getByText(/材料が変わりました/));
    });
  });

  it("幅 375: 品質の欄がはみ出さない", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto(`/requests/${ids.rid}?task=T001`);
        await until.visible(page.getByRole("region", { name: "品質", exact: true }));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
