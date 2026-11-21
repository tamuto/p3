// AI の実行を始める操作の開始待ち: 開始の応答をわざと遅らせても、押した直後に「開始を待っています…」が出て押せなくなり、開始は1回だけ送られる。
// 断られたら理由が出てもう一度押せる。Preflight（概要・メモ欄の保存して再実行）・リリースノートの要約・観測の手順の提案で確かめる。
import type { Page, Route } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { request: "", observation: "" };
async function prepare(env: UiEnv) {
  await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
  ids.request = JSON.parse(await env.p3(["request", "new", "申請の検索", "--milestone", "v1", "--body", "申請を検索する", "--json"])).id;
  await env.p3(["new", "検索の索引を作る", "--req", ids.request]);
  await env.p3(["move", "T001", "done", "--req", ids.request, "--record", "申請を題で検索できるようにした"]);
  await env.p3(["request", "set", ids.request, "status=resolved"]);
  ids.observation = JSON.parse(await env.p3(["observer", "add", "--title", "検索の速さ", "--body", "画面で検索が速いか", "--json"])).id;
}

/** 開始の POST を手で放すまで止める（送られた数を数える）。fail なら断る */
async function hold(page: Page, pattern: RegExp, fail = false) {
  const held: Route[] = [];
  await page.route(pattern, (route) => (route.request().method() === "POST" ? void held.push(route) : void route.continue()));
  return {
    count: () => held.length,
    release: async () => {
      for (const r of held.splice(0)) await (fail ? r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Codex のイメージを作り直しています" }) }) : r.continue());
      await page.unroute(pattern);
    },
  };
}

describe.skipIf(!inject("chromium").available)("AI の実行の開始待ち", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("AI の実行の開始待ち", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("開始の応答が遅くても押した直後から開始待ちになり、開始は1回だけ送られる。断られたらもう一度押せる", async () => {
    const { page, step } = s;
    await step("Preflight: 断られたら理由が出てもう一度押せ、受け付けられたら押せる間を挟まずに実行中へ移る", async () => {
      await page.goto(`/requests/${ids.request}`);
      const run = page.getByRole("button", { name: "▶ Preflight を実行" });
      let h = await hold(page, /\/api\/requests\/[^/]+\/preflight$/, true);
      await run.click();
      const waiting = page.getByRole("button", { name: "開始を待っています…" });
      await until.visible(waiting);
      expect(await waiting.isDisabled()).toBe(true);
      await waiting.click({ force: true });
      expect(h.count()).toBe(1);
      await h.release();
      await until.visible(page.getByText(/Preflight を始められませんでした（もう一度押せます）: Codex のイメージを作り直しています/));
      expect(await run.isEnabled()).toBe(true);
      h = await hold(page, /\/api\/requests\/[^/]+\/preflight$/);
      await run.click();
      await until.visible(waiting);
      expect(h.count()).toBe(1);
      await h.release();
      await until.visible(page.getByRole("button", { name: /もう一度 Preflight|実行中…/ }));
    });
    await step("メモ欄の保存して再実行も同じ要望の開始待ちを使う（概要の開始も押せない）", async () => {
      await until.visible(page.getByRole("button", { name: "▶ もう一度 Preflight" }));
      await page.getByRole("textbox", { name: "Preflight へのメモ" }).fill("対象は画面だけ");
      const h = await hold(page, /\/api\/requests\/[^/]+\/preflight$/);
      await page.getByRole("button", { name: "保存して再実行" }).click();
      // 概要の開始とメモ欄のボタンの両方が開始待ちになり、どちらも押せない
      const waiting = page.getByRole("button", { name: "開始を待っています…" });
      await until.count(waiting, 2);
      expect([await waiting.nth(0).isDisabled(), await waiting.nth(1).isDisabled()]).toEqual([true, true]);
      expect(h.count()).toBe(1);
      await h.release();
      await until.visible(page.getByText("メモを保存して、Preflight を始めました"));
    });
    await step("リリースノートの要約の生成", async () => {
      await page.goto("/release-notes?tab=notes&m=v1");
      const h = await hold(page, /\/api\/release-notes\/[^/]+\/generate$/);
      await page.getByRole("button", { name: "機能の要約を生成" }).click();
      const waiting = page.getByRole("button", { name: "開始を待っています…" });
      await until.visible(waiting);
      await waiting.click({ force: true });
      expect(h.count()).toBe(1);
      await h.release();
      await until.visible(page.getByRole("button", { name: /生成し直す|生成を取り消す|もう一度生成する/ }));
    });
    await step("観測の手順の提案", async () => {
      await page.goto(`/observer/${ids.observation}/edit`);
      const h = await hold(page, /\/definitions\/[^/]+\/suggestions$/);
      await page.getByRole("button", { name: "提案を頼む" }).click();
      const waiting = page.getByRole("button", { name: "開始を待っています…" });
      await until.visible(waiting);
      await waiting.click({ force: true });
      expect(h.count()).toBe(1);
      await h.release();
      await until.visible(page.getByRole("button", { name: /もう一度頼む|提案を待っています…/ }));
    });
  });
});
