// 要望 ID のコピー: 要望の枠の見出し（タブの外・本文のスクロールの外）に1組だけあり、概要・タスクボード・対応済みのどのタブでも、
// 本文を下へ送っても押せる。コピーされるのは今の要望の ID 全文。失敗は手で選ぶよう案内し、キーボードでも押せ、タイトルの入力中に
// マウスで押しても保存しない。375 / 1280・明暗・長い題・タスク 0 件と複数件で、はみ出しと本文への到達を確かめる。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, isDark, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_TITLE = "経費精算の申請と承認の画面で、領収書の画像の添付・差し戻し・再申請・承認の履歴をまとめて扱えるようにし、月末の締めの作業を短くする";
const longBody = (n: number) =>
  `月末の締めで経理の確認が遅れている。\n\n${Array.from({ length: n }, (_, i) => `- 手順 ${i + 1}: 申請の画面で領収書を添付できるようにし、承認する人が履歴を確かめられるようにする`).join("\n")}\n\n` +
  Array.from({ length: 40 }, (_, i) => `段落 ${i + 1}: 経費の申請に領収書を添付する手順を説明する長い文章。承認する人は添付された画像を申請の詳細で確かめる。`).join("\n\n") +
  "\n";

const ids = { tasks: "", empty: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  // タスクにした要望（複数件。長い題・長い本文）
  ids.tasks = (await j(["request", "new", LONG_TITLE, "--body", "-"], longBody(4))).id;
  await env.p3(["preflight", ids.tasks, "--engine", "mock"]);
  await env.p3(["accept", ids.tasks]);
  // タスクの無い要望（長い本文）
  ids.empty = (await j(["request", "new", "タスクの無い要望", "--body", "-"], longBody(2))).id;
}

describe.skipIf(!inject("chromium").available)("要望 ID のコピー", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("要望 ID のコピー", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  for (const width of [1280, 375]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const theme = colorScheme === "dark" ? "暗い" : "明るい";
      it(`幅 ${width}・${theme}テーマで、どのタブでも本文を送ったまま今の要望の ID をコピーできる`, async () => {
        const page = await s.open({ width, height: 640, colorScheme });
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const at = (what: string) => `幅 ${width}・${theme}・${what}`;
        const copy = page.getByRole("button", { name: "要望 ID をコピー" });
        const status = page.getByRole("status").filter({ hasText: /コピー/ });

        /** ボタンが1つだけで、本文を下まで送っても画面内にあり、押すと id がクリップボードに入る */
        const copiesAfterScroll = async (id: string, what: string, mustScroll: boolean) => {
          await until.count(copy, 1);
          const scrolled = await scrollContentToEnd(page);
          if (mustScroll) expect(scrolled, at(`${what}: 本文が下へ送れる`)).toBe(true);
          expect(await inViewport(page, copy, "コピー"), at(`${what}: 送ったあとのコピー`)).toEqual([]);
          expect(await pageOverflow(page), at(`${what}: ページの横のはみ出し`)).toEqual([]);
          await page.evaluate(() => navigator.clipboard.writeText(""));
          await copy.click();
          await until.visible(status.filter({ hasText: "コピーしました" }));
          expect(await page.evaluate(() => navigator.clipboard.readText()), at(`${what}: コピーした ID`)).toBe(id);
        };

        await s.step(
          at("概要・Preflight"),
          async () => {
            await page.goto(`/requests/${ids.tasks}`);
            await until.text(page.locator("main h1").first(), LONG_TITLE);
            expect(await isDark(page), at("テーマ")).toBe(colorScheme === "dark");
            // ID は見出しのタイトルの上に出す（概要の管理情報には出さない）
            const idText = page.locator("main").getByText(ids.tasks, { exact: true });
            await until.count(idText, 1);
            const [idBox, h1Box] = [(await idText.boundingBox())!, (await page.locator("main h1").first().boundingBox())!];
            expect(idBox.y + idBox.height, at("ID はタイトルの上")).toBeLessThanOrEqual(h1Box.y + 1);
            await until.visible(page.getByText(/タスク \d+\/\d+ 完了/));
            await copiesAfterScroll(ids.tasks, "概要", true);
          },
          page,
        );

        await s.step(
          at("タスクボード"),
          async () => {
            await page.getByRole("link", { name: "タスクボード", exact: true }).click();
            await until.url(page, /\/board$/);
            await until.visible(page.locator("section article").first());
            await copiesAfterScroll(ids.tasks, "タスクボード", width < 768);
          },
          page,
        );

        await s.step(
          at("対応済み"),
          async () => {
            await page.getByRole("link", { name: "対応済み", exact: true }).click();
            await until.url(page, /\/done$/);
            await copiesAfterScroll(ids.tasks, "対応済み", false);
          },
          page,
        );

        await s.step(
          at("タスクの無い要望へ移る"),
          async () => {
            await page.goto(`/requests/${ids.empty}`);
            await until.text(page.locator("main h1").first(), "タスクの無い要望");
            expect(await page.getByText(/タスク \d+\/\d+ 完了/).count(), at("タスクの完了数（0 件では出さない）")).toBe(0);
            // 前の要望の「コピーしました」は持ち込まない
            expect(await status.filter({ hasText: "コピーしました" }).count(), at("前の要望の知らせ")).toBe(0);
            await copiesAfterScroll(ids.empty, "タスクの無い要望", true);
          },
          page,
        );

        await s.step(
          at("コピーを拒まれたとき"),
          async () => {
            await page.evaluate(() => {
              navigator.clipboard.writeText = () => Promise.reject(new Error("拒否"));
            });
            await page.locator("main").evaluate((m) => m.querySelectorAll("*").forEach((e) => (e.scrollTop = 0)));
            await copy.click();
            await until.visible(status.filter({ hasText: "ID を選択してコピーしてください" }));
            // 知らせで見出しが広がっても、本文を送ってボタンが隠れず、横にはみ出さない
            expect(await scrollContentToEnd(page), at("拒まれたあとも本文が下へ送れる")).toBe(true);
            expect(await inViewport(page, copy, "コピー"), at("拒まれたあとのコピー")).toEqual([]);
            expect(await inViewport(page, status, "知らせ"), at("拒まれたあとの知らせ")).toEqual([]);
            expect(await pageOverflow(page), at("拒まれたあとのページの横のはみ出し")).toEqual([]);
          },
          page,
        );
        await page.context().close();
      });
    }
  }

  it("Clipboard API が無ければ手で選ぶよう案内し、ID は全体を選べる", async () => {
    const page = await s.open({ width: 1280 });
    await s.step(
      "Clipboard API の無い画面",
      async () => {
        await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
        await page.goto(`/requests/${ids.tasks}`);
        await page.getByRole("button", { name: "要望 ID をコピー" }).click();
        await until.visible(page.getByRole("status").filter({ hasText: "このブラウザではコピーできません。ID を選択してコピーしてください" }));
        await page.locator("main").getByText(ids.tasks, { exact: true }).click();
        expect(await page.evaluate(() => getSelection()?.toString())).toBe(ids.tasks);
      },
      page,
    );
    await page.context().close();
  });

  it("キーボードで押せ、タイトルの入力中にマウスで押しても入力欄から離れず保存しない", async () => {
    const page = await s.open({ width: 1280 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = page.getByRole("button", { name: "要望 ID をコピー" });
    await s.step(
      "キーボード",
      async () => {
        await page.goto(`/requests/${ids.empty}`);
        await copy.focus();
        await page.keyboard.press("Enter");
        await until.visible(page.getByRole("status").filter({ hasText: "コピーしました" }));
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ids.empty);
      },
      page,
    );
    await s.step(
      "タイトルの入力中にマウスで押す",
      async () => {
        const title = page.getByLabel("タイトル");
        await title.fill("書きかけのタイトル");
        await copy.click();
        expect(await title.evaluate((el) => el === document.activeElement), "入力欄のフォーカスが残る").toBe(true);
        await until.value(title, "書きかけのタイトル");
        const shown = JSON.parse(await s.env.p3(["request", "show", ids.empty, "--json"])) as { item: { title: string } };
        expect(shown.item.title).toBe("タスクの無い要望");
        // 元に戻して離れる（保存は起きない）
        await title.fill("タスクの無い要望");
        await title.blur();
      },
      page,
    );
    await page.context().close();
  });
});

/** 要望の画面の本文（main の中のスクロールする要素）を全部いちばん下まで送る。送れたものがあれば true */
function scrollContentToEnd(page: Page): Promise<boolean> {
  return page.locator("main").evaluate((m) => {
    let moved = false;
    for (const e of [m, ...m.querySelectorAll("*")]) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 1) {
        e.scrollTop = e.scrollHeight;
        if (e.scrollTop > 0) moved = true;
      }
    }
    return moved;
  });
}
