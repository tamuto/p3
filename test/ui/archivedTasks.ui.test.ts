// アーカイブしたタスクの閲覧: 要望の「アーカイブ」タブの一覧と閲覧専用の詳細（?archived=T003）。通常の完了タスクと、アーカイブした
// 未着手・完了のタスクが混ざった要望で、タブの移動・詳細・直接の URL・再読み込み・旧案のリンクを確かめる。ボード・見出しの完了数には
// 入らず、空・壊れ・無い・通信の失敗から再試行でき、詳細から書き込みが起きない。幅 1280 / 375 で長い題・本文を読め、キーボードで
// 開閉でき、閉じたらフォーカスを戻す。状態は CLI で用意する（関係は Preflight のタスク化が張るものなので、ファイルに直接書く）。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_TITLE = "領収書の画像を申請の詳細で拡大して確かめられるようにし、承認する人が差し戻しの理由を画像の場所に書き込めるようにする長い題";
const ids = { mixed: "", empty: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  ids.mixed = (await j(["request", "new", "経費の申請を見直す", "--body", "-"], "申請の画面を見直す。\n")).id;
  ids.empty = (await j(["request", "new", "アーカイブの無い要望", "--body", "-"], "空。\n")).id;
  const req = ["--req", ids.mixed];
  await env.p3(["new", "残す完了", ...req, "--status", "done"]);
  await env.p3(["new", "捨てた未着手", ...req, "--body", "-"], "UNUSED-BODY\n");
  await env.p3(["new", LONG_TITLE, ...req, "--body", "-"], `ARCHIVED-BODY\n\n${"長い本文の段落。".repeat(80)}\n`);
  await env.p3(["move", "T003", "done", ...req, "--output", "https://example.com/pr/3", "--record", "-"], "ARCHIVED-RECORD\n");
  await env.p3(["archive", "T002", ...req]);
  await env.p3(["archive", "T003", ...req]);
  const dataDir = (JSON.parse(await env.p3(["whoami", "--json"])) as { dataDir: string }).dataDir;
  const tasks = join(dataDir, "requests", ids.mixed, "tasks");
  // 残した T001 が T002 を置き換えた（旧案のリンク）
  const t1 = join(tasks, "T001.md");
  const text = await readFile(t1, "utf8");
  await writeFile(t1, text.replace(/^status: (.*)$/m, "status: $1\nrelations:\n  - type: supersedes\n    target: T002"));
  // 壊れたアーカイブ
  await writeFile(join(tasks, ".archive", "T009.md"), "---\n: [broken\n---\n");
}

describe.skipIf(!inject("chromium").available)("アーカイブしたタスクの閲覧", () => {
  let s: Scenario;
  const writes: string[] = [];
  beforeAll(async () => {
    s = await openScenario("アーカイブの閲覧", { prepare });
    s.context.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/api/")) writes.push(`${r.method()} ${r.url()}`);
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タブの一覧・詳細・直接の URL・再読み込み・旧案のリンク。ボードと完了数には入らず、書き込みは起きない", async () => {
    const { page, step } = s;
    const dialog = page.getByRole("dialog", { name: /アーカイブしたタスク/ });
    const list = page.getByRole("list", { name: "アーカイブしたタスク" });

    await step("見出しの完了数は残した完了だけ。ボードにアーカイブは出ない", async () => {
      await page.goto(`/requests/${ids.mixed}/board`);
      await until.visible(page.getByText("タスク 1/1 完了"));
      await until.visible(page.getByText("残す完了").first());
      expect(await page.getByText("捨てた未着手").count()).toBe(0);
    });

    await step("アーカイブのタブに一覧と読めないファイルが出る", async () => {
      await page.getByRole("link", { name: "アーカイブ", exact: true }).click();
      await until.url(page, /\/archive/);
      await until.count(list.getByRole("button"), 2);
      await until.visible(list.getByText("捨てた未着手"));
      await until.visible(list.getByText(LONG_TITLE));
      await until.visible(page.getByText(/読めないアーカイブのファイルが 1 件/));
      await until.visible(page.getByText("T009", { exact: true }));
      expect(await page.getByText("タスク 1/1 完了").count()).toBe(1);
    });

    await step("行を押すと閲覧専用の詳細。編集の操作は無く、Esc で閉じて行にフォーカスを戻す", async () => {
      const row = list.getByRole("button").filter({ hasText: LONG_TITLE });
      await row.focus();
      await page.keyboard.press("Enter");
      await until.visible(dialog);
      await until.url(page, /archived=T003/);
      await until.visible(dialog.getByText("閲覧専用", { exact: true }));
      await until.visible(dialog.getByText("ARCHIVED-RECORD"));
      await until.visible(dialog.getByText("ARCHIVED-BODY"));
      await until.visible(dialog.getByRole("link", { name: /pr\/3/ }));
      await until.visible(dialog.getByText("アーカイブ前の状態"));
      for (const name of ["保存", "済みにする", "済みを外す", "破棄"]) expect(await dialog.getByRole("button", { name, exact: true }).count(), name).toBe(0);
      expect(await dialog.locator("input, textarea, select").count()).toBe(0);
      expect(await dialog.getByRole("button", { name: "閉じる" }).evaluate((e) => e === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      await until.count(dialog, 0);
      expect(await row.evaluate((e) => e === document.activeElement)).toBe(true);
      expect(page.url()).not.toMatch(/archived=/);
    });

    await step("直接の URL と再読み込みで開ける（別のタブの上でも）", async () => {
      await page.goto(`/requests/${ids.mixed}/board?archived=T002`);
      await until.visible(dialog.getByText("捨てた未着手"));
      await page.reload();
      await until.visible(dialog.getByText("捨てた未着手"));
      await page.getByRole("button", { name: "閉じる" }).click();
      await until.count(dialog, 0);
    });

    await step("通常のタスクの旧案のリンクから、アーカイブの詳細を開ける", async () => {
      await page.goto(`/requests/${ids.mixed}?task=T001`);
      const open = page.getByRole("button", { name: /閲覧専用の詳細を開く/ });
      await until.visible(open);
      await open.click();
      await until.visible(dialog.getByText("捨てた未着手"));
      await until.url(page, /archived=T002/);
      expect(page.url()).not.toMatch(/task=/);
    });

    await step("無い・読めないは理由を出す", async () => {
      await page.goto(`/requests/${ids.mixed}/archive?archived=T008`);
      await until.visible(dialog.getByRole("alert").filter({ hasText: "T008 はありません" }));
      await page.goto(`/requests/${ids.mixed}/archive?archived=T009`);
      await until.visible(dialog.getByRole("alert").filter({ hasText: "読めません" }));
    });

    await step("アーカイブの無い要望は空と出す", async () => {
      await page.goto(`/requests/${ids.empty}/archive`);
      await until.visible(page.getByText("アーカイブしたタスクはありません"));
    });

    await step("一覧と詳細の通信の失敗から再試行できる", async () => {
      await page.route("**/api/requests/*/archived-tasks**", (r) => r.abort());
      await page.goto(`/requests/${ids.mixed}/archive?archived=T003`);
      await until.visible(page.getByText(/アーカイブの一覧を読み込めませんでした/));
      await until.visible(dialog.getByText(/読み込めませんでした/));
      await page.unroute("**/api/requests/*/archived-tasks**");
      await dialog.getByRole("button", { name: "もう一度読み込む" }).click();
      await until.visible(dialog.getByText("ARCHIVED-RECORD"));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "もう一度読み込む" }).click();
      await until.count(list.getByRole("button"), 2);
    });

    expect(writes).toEqual([]);
  });

  it("幅 375 でも長い題・本文を横にはみ出さずに読める", async () => {
    const page: Page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375 の一覧と詳細",
      async () => {
        await page.goto(`/requests/${ids.mixed}/archive`);
        const list = page.getByRole("list", { name: "アーカイブしたタスク" });
        await until.visible(list.getByText(LONG_TITLE));
        expect(await pageOverflow(page)).toEqual([]);
        await list.getByRole("button").filter({ hasText: LONG_TITLE }).click();
        const dialog = page.getByRole("dialog", { name: /アーカイブしたタスク/ });
        await until.visible(dialog.getByText("ARCHIVED-RECORD"));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
