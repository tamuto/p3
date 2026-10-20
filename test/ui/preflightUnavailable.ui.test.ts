// Preflight を使えないとき（Codex のエンジンで ChatGPT に未接続）: 概要の止まっている表示と失敗した run から、Preflight を通さずに
// タスクを作るフォームへ進み、Preflight を呼ばずに作れることを確かめる。止まった理由と直し方は残す。個人設定の ChatGPT の欄にも案内が出る。
// Docker も ChatGPT も使わない（未接続なので、Codex は認証の段で止まる）。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { request: "" };

async function prepare(env: UiEnv) {
  // UI テストの既定は Mock。この要望では Codex にして、使えない状態にする
  env.env.P3_PREFLIGHT_ENGINE = "codex";
  ids.request = (JSON.parse(await env.p3(["request", "new", "申請の一覧を月ごとに分ける", "--body", "-", "--json"], "- 月ごとに見出しを付ける\n")) as { id: string }).id;
  // 失敗した run を1つ残す（未接続なので始めてすぐ失敗し、終了コード 1）
  await env.p3(["preflight", ids.request]).then(
    () => expect.unreachable("Preflight は失敗するはず"),
    () => undefined,
  );
}

describe.skipIf(!inject("chromium").available)("Preflight を使えないときの直接作成の案内", () => {
  let s: Scenario;
  const preflightStarts: string[] = [];
  beforeAll(async () => {
    s = await openScenario("Preflight を使えない", { prepare });
    s.context.on("request", (r) => {
      if (r.method() === "POST" && /\/api\/requests\/[^/]+\/preflight/.test(r.url())) preflightStarts.push(r.url());
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("概要の止まっている表示と失敗した run から、Preflight を呼ばずにタスクを作れる", async () => {
    const { page, step } = s;
    const link = page.getByRole("link", { name: "Preflight を通さずにタスクを作成" });

    await step("概要: 止まった理由・実行ボタンの停止を残し、直接作る道を並べる", async () => {
      await page.goto(`/requests/${ids.request}`);
      await until.visible(page.getByText(/✕ .*サインイン/).first());
      expect(await page.getByRole("button", { name: /Preflight を実行|もう一度 Preflight/ }).isDisabled()).toBe(true);
      // 失敗した run（理由つき）にも出る
      await until.visible(page.getByText(/^失敗: /));
      await until.count(link, 2);
    });

    await step("案内からフォームを開き、作成する", async () => {
      await link.first().click();
      await until.url(page, new RegExp(`/requests/${ids.request}/board$`));
      const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
      await until.visible(dialog);
      await dialog.getByLabel("題").fill("一覧に月の見出しを付ける");
      await dialog.getByLabel(/^本文/).fill("- 月が変わるところに見出しを出す\n");
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
      await until.visible(page.locator("article").filter({ hasText: "一覧に月の見出しを付ける" }));
      // 閉じたら「タスクを追加」へフォーカスが戻る
      expect(await page.getByRole("button", { name: "＋ タスクを追加" }).evaluate((el) => el === document.activeElement)).toBe(true);
    });

    await step("Preflight は呼んでおらず、CLI から見てもタスクがある", async () => {
      expect(preflightStarts).toEqual([]);
      const shown = JSON.parse(await s.env.p3(["request", "show", ids.request, "--brief", "--json"])) as { tasks: { title: string; status: string }[] };
      expect(shown.tasks).toEqual([expect.objectContaining({ title: "一覧に月の見出しを付ける", status: "todo" })]);
    });

    await step("個人設定の ChatGPT の欄にも、タスクボードで作る手順が出る", async () => {
      await page.goto("/settings?tab=personal");
      await until.visible(page.getByText(/タスクボードの「＋ タスクを追加」で、Preflight を通さずにタスクを作れます/));
    });
  });
});
