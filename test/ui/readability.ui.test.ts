// 文字の大きさと拡大表示: 主な画面で、本文・フォームの見出し・主な操作の計算済みの文字が 16px 以上、ID・日時などの補助の情報が
// 14px 以上（test/ui/layout.ts の fontProblems）。200% の拡大（1280×900 の画面を 640×450 の CSS の幅で描くのと同じ）でも
// ページが横にはみ出さず、入力と主な操作にキーボード（Tab）で届く。方針は docs/development.md の「画面の文字と余白」
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { fontProblems, inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_TITLE = "経費精算の申請と承認の画面で、領収書の画像の添付・差し戻し・再申請・承認の履歴をまとめて扱えるようにし、月末の締めの作業を短くする";
const ids = { board: "", drafts: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  // 長い題のマイルストーン（リリースノートのマイルストーン・レビュー）と長い説明（設定）
  await env.p3(["milestone", "add", "v1.1", "--title", `領収書と通知（${LONG_TITLE}）`, "--due", "2026-11-30"]);
  await env.p3(["config", "set", `description=${LONG_TITLE}。${LONG_TITLE}`]);
  const body = `${Array.from({ length: 4 }, (_, i) => `- 手順 ${i + 1}: src/web/components/expense/Receipt${i}.tsx を直す`).join("\n")}\n`;
  ids.board = (await j(["request", "new", LONG_TITLE, "--milestone", "v1.1", "--due", "2026-11-20", "--body", "-"], body)).id;
  await env.p3(["preflight", ids.board, "--engine", "mock"]);
  await env.p3(["accept", ids.board]);
  ids.drafts = (await j(["request", "new", `案を見る要望（${LONG_TITLE}）`, "--body", "-"], body)).id;
  await env.p3(["preflight", ids.drafts, "--engine", "mock"]);
}

const none = (problems: string[], where: string) => expect(problems, `${where}\n  ${problems.join("\n  ")}`).toEqual([]);

/** 画面ごとの開き方（開いたら読み終わるまで待つ） */
const screens: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "進捗",
    open: async (page) => {
      await page.goto("/");
      await until.count(page.getByTestId("schedule").getByRole("link", { name: /経費精算の申請と承認/ }), 2);
    },
  },
  {
    name: "新しい要望",
    open: async (page) => {
      await page.goto("/requests/new");
      await until.visible(page.getByRole("heading", { name: "新しい要望" }));
    },
  },
  {
    name: "要望の概要と Preflight の案",
    open: async (page) => {
      await page.goto(`/requests/${ids.drafts}`);
      await until.visible(page.getByRole("button", { name: /件をタスク化/ }));
    },
  },
  {
    name: "タスクボード",
    open: async (page) => {
      await page.goto(`/requests/${ids.board}/board`);
      await until.count(page.locator("section article"), 4);
    },
  },
  {
    name: "タスクの詳細",
    open: async (page) => {
      await page.goto(`/requests/${ids.board}/board`);
      await page.locator("section article").filter({ hasText: "T001" }).click();
      await until.visible(page.locator("aside").getByRole("button", { name: "保存" }));
    },
  },
  {
    name: "設定（プロジェクト）",
    open: async (page) => {
      await page.goto("/settings?tab=project");
      await until.visible(page.getByLabel("プロジェクト名"));
    },
  },
  {
    name: "設定（品質基準）",
    open: async (page) => {
      await page.goto("/settings?tab=quality");
      await until.visible(page.getByRole("tabpanel"));
    },
  },
  {
    name: "リリースノート（マイルストーン）",
    open: async (page) => {
      await page.goto("/release-notes?tab=milestones");
      await until.visible(page.getByRole("heading", { name: "リリースノート" }));
    },
  },
  {
    name: "リリースノート（レビュー）",
    open: async (page) => {
      await page.goto("/release-notes?tab=review");
      await until.visible(page.getByRole("heading", { name: "リリースノート" }));
    },
  },
];

/** Tab を押して target にフォーカスが届くか（届いたら画面内に見えている） */
async function tabTo(page: Page, target: Locator, what: string, max = 60): Promise<string[]> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return inViewport(page, target, what);
  }
  return [`${what} に Tab で ${max} 回以内に届かない`];
}

describe.skipIf(!inject("chromium").available)("文字の大きさと拡大表示", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("文字の大きさ", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  for (const [width, colorScheme] of [
    [1280, "light"],
    [375, "dark"],
  ] as const) {
    it(`幅 ${width}・${colorScheme === "dark" ? "暗い" : "明るい"}テーマで、本文・見出し・操作は 16px 以上、補助の情報は 14px 以上`, async () => {
      expect.hasAssertions();
      const page = await s.open({ width, colorScheme });
      for (const sc of screens) {
        await s.step(`幅 ${width}・${sc.name}`, async () => {
          await sc.open(page);
          none(await fontProblems(page.locator("body")), `幅 ${width}・${sc.name}の文字`);
          none(await pageOverflow(page), `幅 ${width}・${sc.name}の横のはみ出し`);
        }, page);
      }
      await page.context().close();
    });
  }

  it("200% の拡大表示（CSS の幅 640×450）で、入力と主な操作が欠けずキーボードで届く", async () => {
    expect.hasAssertions();
    const page = await s.open({ width: 640, height: 450 });
    const at = (w: string) => `200%・${w}`;
    for (const sc of screens) {
      await s.step(at(sc.name), async () => {
        await sc.open(page);
        none(await pageOverflow(page), at(`${sc.name}の横のはみ出し`));
      }, page);
    }
    await s.step(at("新しい要望の入力と作成"), async () => {
      await screens[1].open(page);
      await page.getByLabel("タイトル").fill(LONG_TITLE);
      await page.getByLabel("タイトル").focus();
      none(await tabTo(page, page.getByRole("button", { name: "作成", exact: true }), "作成"), at("新しい要望"));
    }, page);
    await s.step(at("設定の入力と保存"), async () => {
      await screens[5].open(page);
      await page.getByLabel("プロジェクト名").fill("uitest-拡大");
      await page.getByLabel("プロジェクト名").focus();
      none(await tabTo(page, page.getByRole("button", { name: "保存", exact: true }), "保存"), at("設定"));
      none(await tabTo(page, page.getByRole("button", { name: "元に戻す", exact: true }), "元に戻す"), at("設定"));
      await page.keyboard.press("Enter");
    }, page);
    await s.step(at("タスクの詳細の保存と閉じる"), async () => {
      await screens[4].open(page);
      const drawer = page.locator("aside");
      // 保存は入力を変えてから押せる。ラベルを変えて、その欄から Tab で保存へ
      await drawer.getByLabel("ラベル (カンマ区切り)").fill("拡大");
      await drawer.getByRole("button", { name: "✕" }).focus();
      none(await tabTo(page, drawer.getByRole("button", { name: "保存" }), "詳細の保存"), at("タスクの詳細"));
    }, page);
    await page.context().close();
  });
});
