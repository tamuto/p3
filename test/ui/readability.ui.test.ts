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
  // 観測: 長い名前・単位・説明・目安の項目に、長い対象とメモの値（推移の図が出る3件）と、長い構造化データの項目
  await env.p3(["observer", "key", "add", "closing.minutes", "--name", `月末の締めの時間（${LONG_TITLE}）`, "--type", "number", "--unit", "分", "--body", LONG_TITLE, "--min", "0", "--max", "120"]);
  for (const [v, at] of [["42", "2026-10-31"], ["35", "2026-11-15"], ["58", "2026-11-30"]]) {
    await env.p3(["observer", "value", "add", "closing.minutes", v, "--at", at, "--milestone", "v1.1", "--target", `${ids.board}/T001`, "--note", LONG_TITLE]);
  }
  await env.p3(["observer", "key", "add", "closing.detail", "--name", "締めの内訳", "--type", "json"]);
  await env.p3(["observer", "value", "add", "closing.detail", "-"], JSON.stringify({ steps: Array.from({ length: 6 }, (_, i) => `手順 ${i + 1}: ${LONG_TITLE}`) }));
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
    name: "観測の一覧",
    open: async (page) => {
      await page.goto("/observer");
      await until.visible(page.getByRole("link", { name: /月末の締めの時間/ }));
    },
  },
  {
    name: "観測の項目の登録",
    open: async (page) => {
      await page.goto("/observer/new");
      await until.visible(page.getByRole("heading", { name: "観測の項目を登録" }));
    },
  },
  {
    name: "観測の項目と値（推移）",
    open: async (page) => {
      await page.goto("/observer/closing.minutes");
      await until.visible(page.getByRole("img", { name: /の推移$/ }));
    },
  },
  {
    name: "観測の項目と値（構造化データ）",
    open: async (page) => {
      await page.goto("/observer/closing.detail");
      await until.visible(page.getByRole("cell", { name: /手順 6/ }));
    },
  },
  {
    name: "観測のシステムの項目",
    open: async (page) => {
      await page.goto("/observer/p3.task.rework");
      await until.visible(page.getByText(/システムの項目です/));
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
    await s.step(at("観測の一覧から作成の操作とナビゲーションへ"), async () => {
      await page.goto("/observer");
      await until.visible(page.getByRole("link", { name: /月末の締めの時間/ }));
      const banner = page.getByRole("banner");
      none(await tabTo(page, banner.getByRole("link", { name: "観測", exact: true }), "ナビゲーションの観測"), at("観測の一覧"));
      none(await tabTo(page, banner.getByRole("link", { name: /新しい要望/ }), "新しい要望"), at("観測の一覧"));
      none(await tabTo(page, banner.getByRole("link", { name: /新しい観測項目/ }), "新しい観測項目"), at("観測の一覧"));
      const [req, obs] = [await banner.getByRole("link", { name: /新しい要望/ }).innerText(), await banner.getByRole("link", { name: /新しい観測項目/ }).innerText()];
      expect(req, at("作成の操作の文字")).not.toBe(obs);
      none(await tabTo(page, page.getByRole("link", { name: "＋ 新しい項目" }), "新しい項目"), at("観測の一覧"));
    }, page);
    await s.step(at("観測の項目の登録"), async () => {
      await page.goto("/observer/new");
      await page.getByLabel("項目キー").fill("closing.count");
      await page.getByLabel("名前").fill(LONG_TITLE);
      await page.getByLabel("名前").focus();
      none(await tabTo(page, page.getByRole("button", { name: "登録する" }), "登録する"), at("観測の項目の登録"));
    }, page);
    await s.step(at("観測の値を足す・項目を変える"), async () => {
      await page.goto("/observer/closing.minutes");
      await until.visible(page.getByRole("img", { name: /の推移$/ }));
      await page.getByLabel(/^値（/).fill("40");
      await page.getByLabel(/^値（/).focus();
      none(await tabTo(page, page.getByRole("button", { name: "足す", exact: true }), "足す"), at("観測の値を足す"));
      await page.getByRole("button", { name: "項目を変える" }).click();
      await page.getByLabel("名前").focus();
      none(await tabTo(page, page.getByRole("button", { name: "変える", exact: true }), "変える"), at("観測の項目を変える"));
      await page.getByRole("button", { name: "やめる" }).click();
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
