// 表示の回帰: 主な画面の通常の幅（1280）とスマホの幅（375）、案の詳細（375 / 768 / 1280・明暗）で、はみ出し・並び・画面内への収まり・
// 局所スクロールの到達・操作への到達・フォーカスを DOM の寸法と操作で確かめる（画像の比較はしない）。
// 長い題・長いパス・複数の案・依存・表とコードのある案の本文を使う。状態は CLI で用意し、開く・閉じるなどはブラウザで行う。
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { box, escapes, inViewport, pageOverflow, reachable, reachByScroll } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_TITLE = "経費精算の申請と承認の画面で、領収書の画像の添付・差し戻し・再申請・承認の履歴をまとめて扱えるようにし、月末の締めの作業を短くする";
const LONG_PATH = "src/web/components/expense/receipts/upload/ReceiptUploaderContainer.tsx";
const steps = (n: number) =>
  `月末の締めで経理の確認が遅れている。\n\n${Array.from({ length: n }, (_, i) => `- 手順 ${i + 1}: ${LONG_PATH.replace(".tsx", `${i}.tsx`)} を直して、申請の画面で添付できるようにする`).join("\n")}\n`;

// 案 D1 の本文に足す（長い文・表・コード・長いパス。最後の行と各局所スクロールの末尾に目印）
const DRAFT_EXTRA = `

## 表

| 申請 | ファイル | 承認する人 | 期限 | 差し戻しの理由 | 最後の列 |
| --- | --- | --- | --- | --- | --- |
${Array.from({ length: 5 }, (_, i) => `| 申請 ${i} の長い説明の文章 | ${LONG_PATH} | 承認する人の名前とメールアドレス | 2026-11-${10 + i} | 差し戻しの理由がここに長く入る | 列の末尾 ${i} |`).join("\n")}

## コード

\`\`\`ts
export function uploadReceipt(requestId: string, file: File, options: { resize: boolean; maxWidth: number; maxHeight: number; quality: number }) { return api.post(\`/api/requests/\${requestId}/attachments\`, file, options); } // END-OF-CODE
\`\`\`

長いパス: /home/me/src/expense/${LONG_PATH.replace(".tsx", "")}/with/many/more/segments/ReceiptUploaderContainer.tsx

${Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}: 経費の申請に領収書を添付する手順を説明する長い文章。承認する人は添付された画像を申請の詳細で確かめる。`).join("\n\n")}

本文の最後の行
`;

const ids = { board: "", drafts: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  await env.p3(["milestone", "add", "v1.1", "--title", "領収書と通知", "--due", "2026-11-30"]);
  // タスクにした要望（依存のある4件。ボードとタスクの詳細）
  ids.board = (await j(["request", "new", LONG_TITLE, "--milestone", "v1.1", "--due", "2026-11-20", "--body", "-"], steps(4))).id;
  await env.p3(["preflight", ids.board, "--engine", "mock"]);
  await env.p3(["accept", ids.board]);
  // 案のままの要望（複数の案と段階の列。案の詳細）
  ids.drafts = (await j(["request", "new", `案を見る要望（${LONG_TITLE}）`, "--body", "-"], steps(3))).id;
  await env.p3(["preflight", ids.drafts, "--engine", "mock"]);
  const runs = join(env.repo, ".p3/requests", ids.drafts, "preflight");
  const d1 = join(runs, readdirSync(runs)[0], "drafts/D1.md");
  writeFileSync(d1, readFileSync(d1, "utf8") + DRAFT_EXTRA);
}

/** 問題の一覧が空であること（失敗の説明に、どの幅・テーマ・画面かを付ける） */
const none = (problems: string[], where: string) => expect(problems, `${where}\n  ${problems.join("\n  ")}`).toEqual([]);

describe.skipIf(!inject("chromium").available)("表示（幅・テーマ）", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("表示", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  for (const width of [1280, 375]) {
    it(`主な画面が幅 ${width} で収まり、主な操作に届く`, async () => {
      const page = await s.open({ width });
      const at = (what: string) => `幅 ${width}・${what}`;

      await s.step(at("進捗"), async () => {
        await page.goto("/");
        await until.visible(page.getByRole("heading", { name: "進捗" }));
        const schedule = page.getByTestId("schedule");
        await until.count(schedule.getByRole("link", { name: /経費精算の申請と承認/ }), 2);
        none(await pageOverflow(page), at("進捗のページ"));
        // 日本語のフォントがあれば、寸法は Noto Sans CJK JP で測っている（中国語の字形のフォントではない）
        if (inject("fontconfig")) expect(await platformFonts(page, "h1"), at("見出しのフォント")).toContain("Noto Sans CJK JP");
        none(
          [
            ...(await reachable(page.getByRole("link", { name: /新しい要望/ }), "新しい要望")),
            ...(await reachable(page.getByRole("button", { name: "今日" }), "今日")),
            // 表は横に局所スクロールする。今日のタスクの印へ届く
            ...(await reachable(schedule.locator("button").first(), "タスクの印")),
          ],
          at("進捗の操作"),
        );
        for (const row of await schedule.getByRole("link", { name: /経費精算の申請と承認/ }).all()) none(await escapes(row), at("進捗の要望の行"));
      }, page);

      await s.step(at("新しい要望"), async () => {
        await page.goto("/requests/new");
        await until.visible(page.getByRole("heading", { name: "新しい要望" }));
        await page.getByLabel("タイトル").fill(LONG_TITLE);
        none(await pageOverflow(page), at("新しい要望のページ"));
        none(await reachable(page.getByRole("button", { name: "作成", exact: true }), "作成"), at("新しい要望の操作"));
      }, page);

      await s.step(at("概要と Preflight の案"), async () => {
        await page.goto(`/requests/${ids.drafts}`);
        await until.text(page.locator("main h1").first(), `案を見る要望（${LONG_TITLE}）`);
        await until.visible(page.getByRole("button", { name: /件をタスク化/ }));
        none(await pageOverflow(page), at("概要のページ"));
        none(await escapes(page.locator("main h1").first().locator("..")), at("要望の題"));
        const open = page.getByRole("button", { name: "内容を見る" });
        await until.count(open, 3);
        // 段階の列は横に局所スクロールする。どの案の「内容を見る」にも届く
        for (const [i, b] of (await open.all()).entries()) none(await reachable(b, `案 ${i + 1} の内容を見る`), at("案の一覧"));
        none(await reachable(page.getByRole("button", { name: /件をタスク化/ }), "タスク化"), at("案の一覧"));
      }, page);

      await s.step(at("タスクボード"), async () => {
        await page.goto(`/requests/${ids.board}/board`);
        const col = (label: string) => page.locator("section").filter({ has: page.getByText(label, { exact: true }) });
        await until.count(col("未着手").locator("article"), 4);
        none(await pageOverflow(page), at("ボードのページ"));
        const [todo, done, doing] = [await box(col("未着手")), await box(col("完了")), await box(col("作業中"))];
        if (width >= 768) {
          // 広い画面: 未着手と完了を横に並べ、その下に作業中
          expect(Math.abs(todo.top - done.top), at(`未着手と完了の上端（${todo.top} / ${done.top}）`)).toBeLessThanOrEqual(2);
          expect(todo.right, at("未着手は完了の左")).toBeLessThanOrEqual(done.left);
          expect(doing.top, at("作業中は下")).toBeGreaterThanOrEqual(Math.max(todo.bottom, done.bottom));
        } else {
          // 狭い画面: 縦に積む（どれも画面の幅いっぱい）
          expect(todo.bottom, at("未着手の下に完了")).toBeLessThanOrEqual(done.top);
          expect(done.bottom, at("完了の下に作業中")).toBeLessThanOrEqual(doing.top);
          for (const b of [todo, done, doing]) expect(b.width, at(`列の幅 ${b.width}`)).toBeGreaterThanOrEqual(width - 60);
        }
        for (const card of await col("未着手").locator("article").all()) none(await escapes(card), at("タスクのカード"));
        none(await reachable(col("未着手").locator("article").last(), "最後のカード"), at("ボード"));
      }, page);

      await s.step(at("タスクの詳細"), async () => {
        await page.locator("section article").filter({ hasText: "T001" }).click();
        const drawer = page.locator("aside");
        await until.visible(drawer.getByRole("button", { name: "保存" }));
        none(
          [
            ...(await inViewport(page, drawer, "詳細の枠")),
            ...(await inViewport(page, drawer.getByRole("button", { name: "保存" }), "保存")),
            ...(await inViewport(page, drawer.getByRole("button", { name: "✕" }), "閉じる（✕）")),
          ],
          at("タスクの詳細"),
        );
        none(await escapes(drawer), at("タスクの詳細の中身"));
        // 本文は詳細の中でスクロールし、末尾（データのファイルの場所）まで届く
        none(await reachByScroll(drawer.locator(".overflow-y-auto").first(), drawer.getByText(/tasks\/T001\.md$/), "y", "詳細の末尾"), at("タスクの詳細"));
        await drawer.getByRole("button", { name: "✕" }).click();
        await until.count(drawer, 0);
      }, page);
      await page.context().close();
    });
  }

  for (const width of [375, 768, 1280]) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(`案の詳細が幅 ${width}・${colorScheme === "dark" ? "暗い" : "明るい"}テーマで画面に収まり、末尾と局所スクロールに届き、閉じるとフォーカスが戻る`, async () => {
        const page = await s.open({ width, colorScheme });
        const at = (what: string) => `幅 ${width}・${colorScheme === "dark" ? "暗い" : "明るい"}・${what}`;
        await s.step(at("案の詳細"), async () => {
          await page.goto(`/requests/${ids.drafts}`);
          const opener = page.getByRole("button", { name: "内容を見る" }).first();
          await opener.click();
          const dialog = page.locator("dialog[open]");
          await until.visible(dialog.getByRole("heading", { name: /D1/ }));
          expect(await isDark(page), at("テーマ")).toBe(colorScheme === "dark");
          expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor), at("詳細の背景")).toSatisfy((c: string) => (luminance(c) < 0.3) === (colorScheme === "dark"));
          none(
            [
              ...(await inViewport(page, dialog, "詳細の枠")),
              ...(await inViewport(page, dialog.getByRole("button", { name: "閉じる" }), "閉じる")),
              ...(await pageOverflow(page)),
              ...(await escapes(dialog)),
            ],
            at("案の詳細の収まり"),
          );
          // 本文の末尾・表の最後の列・コードの行末へ届く（局所スクロール）
          const body = dialog.locator(".overflow-y-auto").first();
          none(
            [
              ...(await reachByScroll(dialog.locator("table").locator(".."), dialog.getByRole("columnheader", { name: "最後の列" }), "x", "表の最後の列")),
              ...(await codeEndVisible(dialog)),
              ...(await reachByScroll(body, dialog.getByText("本文の最後の行"), "y", "本文の最後の行")),
            ],
            at("案の詳細の局所スクロール"),
          );

          // 閉じるボタン → 閉じて、開いたボタンへフォーカスが戻る
          await dialog.getByRole("button", { name: "閉じる" }).click();
          await until.count(page.locator("dialog[open]"), 0);
          expect(await opener.evaluate((el) => el === document.activeElement), at("閉じた後のフォーカス")).toBe(true);
          // Escape でも同じ
          await opener.click();
          await until.visible(page.locator("dialog[open]"));
          await page.keyboard.press("Escape");
          await until.count(page.locator("dialog[open]"), 0);
          expect(await opener.evaluate((el) => el === document.activeElement), at("Escape の後のフォーカス")).toBe(true);
        }, page);
        await page.context().close();
      });
    }
  }

  it("測り方が崩れを見逃さない（はみ出し・枠の外・画面の外・届かない局所スクロール）", async () => {
    const page = await s.open({ width: 375 });
    await page.goto("/");
    await until.visible(page.getByRole("heading", { name: "進捗" }));
    // ページの横のはみ出し
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="wide" style="width:1500px">横にはみ出す</div>'));
    expect((await pageOverflow(page)).join("\n")).toMatch(/文書の幅 \d+px が画面の幅 375px より広い/);
    // 枠からのはみ出し（区切りの無い長い文字）・画面の外の枠・届かない目印
    await page.evaluate(() => {
      document.getElementById("wide")?.remove();
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div id="frame" style="position:absolute;top:0;left:0;width:120px;height:40px"><p>区切りの無い長い文字src/web/components/expense/receipts/upload</p></div>' +
          '<div id="tall" style="position:absolute;top:0;left:0;width:100px;height:3000px"></div>' +
          '<div id="scroller" style="position:absolute;top:0;left:0;width:100px;height:50px;overflow:hidden"><div style="height:500px"></div><span id="mark">目印</span></div>',
      );
    });
    expect((await escapes(page.locator("#frame"))).join("\n")).toMatch(/文字「区切りの無い長い文字.*」が枠の外/);
    expect((await inViewport(page, page.locator("#tall"), "高い枠")).join("\n")).toMatch(/高い枠 が画面（375×800）の外/);
    const scroller = page.locator("#scroller");
    await scroller.evaluate((el) => (el.style.height = "50px"));
    await page.evaluate(() => document.getElementById("mark")!.style.setProperty("margin-left", "400px"));
    expect((await reachByScroll(scroller, page.locator("#mark"), "y", "目印")).join("\n")).toMatch(/目印: 端まで送っても/);
    await page.context().close();
  });
});

/** Chromium が実際に使ったフォント（CDP） */
async function platformFonts(page: Page, selector: string): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  await cdp.detach();
  return fonts.map((f) => f.familyName);
}

const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

/** rgb(a) の明るさ（0〜1） */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? ["255", "255", "255"]).slice(0, 3).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** コードの行末（目印 END-OF-CODE）まで、コードの枠の中を横に送って見えるか */
async function codeEndVisible(dialog: ReturnType<Page["locator"]>): Promise<string[]> {
  return dialog.locator("pre").evaluate((pre) => {
    pre.scrollLeft = pre.scrollWidth;
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const i = t.data.indexOf("END-OF-CODE");
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(t, i);
      range.setEnd(t, i + "END-OF-CODE".length);
      const r = range.getBoundingClientRect();
      const p = pre.getBoundingClientRect();
      return r.left >= p.left - 1 && r.right <= p.right + 1 ? [] : [`コードの行末: 端まで送っても見えない（x ${Math.round(r.left)}〜${Math.round(r.right)}、枠 ${Math.round(p.left)}〜${Math.round(p.right)}）`];
    }
    return ["コードの行末の目印が見つからない"];
  });
}
