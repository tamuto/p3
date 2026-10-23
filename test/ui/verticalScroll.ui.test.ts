// 縦スクロールは1つ: 要望の画面では本文（request-content）だけが縦に送れ、共通の main と文書（ページ全体）は送れない。
// 通常のタスク案・子の分割案・親を持つ子（長い祖先の題）と Preflight 未実行で、本文を末尾まで送れ、見出しのコピーとタブは
// 本文の外に残る。ほかの画面（進捗・新しい要望・設定・リリースノート・タスクボード・対応済み）も文書は送れない。
// 局所スクロールの例外（実行ログ）は対象を名指しして、末尾まで届くことを確かめる。375 / 1280・明暗・高さ 900 / 600。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, isDark, pageOverflow, reachable, reachByScroll, scrollableY } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { plain: "", split: "", child: "", fresh: "" };
const LONG = "とても長い題の親の要望で、狭い画面でも祖先の列が折り返されることを確かめるための文".repeat(2);
const items = (n: number, long = "") => Array.from({ length: n }, (_, i) => `- 項目${i + 1}${long}`).join("\n");
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `段落 ${i + 1}: 経費の申請に領収書を添付する手順を説明する長い文章。`).join("\n\n");

async function prepare(env: UiEnv) {
  const make = async (title: string, body: string, ...args: string[]) =>
    (JSON.parse(await env.p3(["request", "new", title, "--body", "-", ...args, "--json"], body)) as { id: string }).id;
  // 通常のタスク案（タスク化して、タスクボード・対応済みも見る）
  ids.plain = await make("通常のタスク案", `${items(3)}\n\n${paragraphs(40)}`);
  await env.p3(["preflight", ids.plain, "--engine", "mock", "--json"]);
  await env.p3(["accept", ids.plain]);
  // 子の分割案（Mock は箇条書き 6 件以上で子の案を書く）
  ids.split = await make("子の分割案", items(7, "：とても長い説明".repeat(30)));
  await env.p3(["preflight", ids.split, "--engine", "mock", "--json"]);
  // 親を持つ子（長い題の祖先が2段）・Preflight 未実行
  const root = await make(LONG, "");
  const mid = await make(`${LONG}（中間）`, "", "--parent", root);
  ids.child = await make("申請の画面", paragraphs(60), "--parent", mid);
  ids.fresh = await make("Preflight の前", paragraphs(60));
}

/** 文書・main は縦に送れず、本文だけが送れて末尾まで届く。送ったあともコピーとタブは画面内 */
async function oneBodyScroll(page: Page, at: (w: string) => string) {
  const content = page.getByTestId("request-content");
  expect(await scrollableY(page), at("文書の縦スクロール")).toBe(0);
  expect(await scrollableY(page, page.locator("main")), at("main の縦スクロール")).toBe(0);
  expect(await scrollableY(page, content), at("本文が縦に送れる")).toBeGreaterThan(0);
  // 本文を下端まで送ると、本文の最後の要素の下端が本文の見えている範囲に入る（途中で切れて届かない内容が無い）
  const end = await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    let last = el.lastElementChild;
    while (last?.lastElementChild) last = last.lastElementChild;
    return { last: last?.getBoundingClientRect().bottom ?? 0, frame: el.getBoundingClientRect().bottom, text: last?.textContent?.slice(0, 40) };
  });
  expect(end.last, at(`本文の末尾「${end.text}」が本文の下端（${Math.round(end.frame)}）までに入る`)).toBeLessThanOrEqual(end.frame + 1);
  expect(await scrollableY(page), at("送ったあとの文書の縦スクロール")).toBe(0);
  expect(await inViewport(page, page.getByRole("button", { name: "要望 ID をコピー" }), "コピー"), at("送ったあとのコピー")).toEqual([]);
  expect(await inViewport(page, page.getByRole("link", { name: "タスクボード", exact: true }), "タブ"), at("送ったあとのタブ")).toEqual([]);
  expect(await pageOverflow(page), at("横のはみ出し")).toEqual([]);
}

describe.skipIf(!inject("chromium").available)("縦スクロールは1つ", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("縦スクロールは1つ", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  for (const width of [1280, 375]) {
    for (const height of [900, 600]) {
      for (const colorScheme of ["light", "dark"] as const) {
        const theme = colorScheme === "dark" ? "暗い" : "明るい";
        it(`幅 ${width}・高さ ${height}・${theme}テーマで、要望の本文だけが縦に送れ、ほかの画面も文書は送れない`, async () => {
          const page = await s.open({ width, height, colorScheme });
          const at = (what: string) => `幅 ${width}・高さ ${height}・${theme}・${what}`;
          const h1 = page.locator("main h1").first();

          await s.step(
            at("通常のタスク案"),
            async () => {
              await page.goto(`/requests/${ids.plain}`);
              await until.text(h1, "通常のタスク案");
              expect(await isDark(page), at("テーマ")).toBe(colorScheme === "dark");
              await until.visible(page.getByRole("heading", { name: /^タスク案/ }));
              await oneBodyScroll(page, (w) => at(`通常のタスク案: ${w}`));
              // 局所スクロールの例外: 実行ログは自分で送り、末尾まで届く
              const log = page.locator("section").filter({ has: page.getByRole("heading", { name: "実行ログ" }) }).locator(".overflow-y-auto");
              await log.scrollIntoViewIfNeeded();
              expect(await reachByScroll(log, log.locator(":scope > div").last(), "y", "実行ログの末尾"), at("実行ログ")).toEqual([]);
            },
            page,
          );

          await s.step(
            at("子の分割案"),
            async () => {
              await page.goto(`/requests/${ids.split}`);
              await until.visible(page.getByRole("heading", { name: /子の要望への分割案/ }));
              await oneBodyScroll(page, (w) => at(`子の分割案: ${w}`));
              expect(await reachable(page.getByRole("button", { name: "採用内容を確認" }), "採用内容を確認"), at("子の分割案")).toEqual([]);
              expect(await scrollableY(page), at("子の分割案: 確認ボタンまで送ったあとの文書")).toBe(0);
            },
            page,
          );

          await s.step(
            at("親を持つ子・Preflight 未実行"),
            async () => {
              for (const [id, title] of [
                [ids.child, "申請の画面"],
                [ids.fresh, "Preflight の前"],
              ]) {
                await page.goto(`/requests/${id}`);
                await until.text(h1, title);
                if (id === ids.child) await until.visible(page.getByRole("navigation", { name: "親の要望" }).getByRole("link", { name: LONG, exact: true }));
                await oneBodyScroll(page, (w) => at(`${title}: ${w}`));
              }
            },
            page,
          );

          await s.step(
            at("ほかの画面"),
            async () => {
              for (const path of [
                "/",
                "/requests/new",
                "/settings?tab=personal",
                "/settings?tab=project",
                "/settings?tab=repos",
                "/release-notes",
                `/requests/${ids.plain}/board`,
                `/requests/${ids.plain}/done`,
              ]) {
                await page.goto(path);
                await until.visible(page.locator("main > *").first());
                await page.waitForLoadState("networkidle");
                expect(await scrollableY(page), at(`${path} の文書の縦スクロール`)).toBe(0);
              }
            },
            page,
          );
          await page.context().close();
        });
      }
    }
  }
});
