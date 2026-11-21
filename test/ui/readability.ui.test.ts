// 文字の大きさと拡大表示: 主な画面で、本文・フォームの見出し・主な操作の計算済みの文字が 16px 以上、ID・日時などの補助の情報が
// 14px 以上（test/ui/layout.ts の fontProblems）。200% の拡大（1280×900 の画面を 640×450 の CSS の幅で描くのと同じ）でも
// ページが横にはみ出さず、入力と主な操作にキーボード（Tab）で届く。方針は docs/development.md の「画面の文字と余白」
import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { fontProblems, inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_TITLE = "経費精算の申請と承認の画面で、領収書の画像の添付・差し戻し・再申請・承認の履歴をまとめて扱えるようにし、月末の締めの作業を短くする";
const ids = { board: "", drafts: "", observation: "", preparation: "" };

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
  // 観測: 長いパスと呼び出し方の手順と置き換え候補、完了した提案（Mock）
  const long = "test/ui/expense/receipt/attachments/approval-history/monthly-closing-workflow.ui.test.ts";
  const steps = Array.from({ length: 3 }, (_, i) => `手順 ${i + 1}: ${LONG_TITLE}`);
  const obs = {
    title: `観測（${LONG_TITLE}）`,
    category: "使い勝手",
    description: LONG_TITLE,
    measures: [{ name: "closing_minutes", type: "number", unit: "分", description: LONG_TITLE }],
    procedures: [
      {
        title: `月末の締めを確かめる（${LONG_TITLE}）`,
        measures: ["closing_minutes"],
        run: { kind: "ai-instruction", premise: LONG_TITLE, target: `http://localhost:4310/very/long/path/${"segment/".repeat(8)}`, steps, judge: LONG_TITLE, record: LONG_TITLE },
        replacement: { kind: "ui-script", repo: "repo", path: long, operation: LONG_TITLE, output: LONG_TITLE, compare: LONG_TITLE, switchWhen: LONG_TITLE, invoke: `pnpm vitest run -c vitest.ui.config.ts ${long} --reporter=verbose --no-file-parallelism` },
      },
    ],
  };
  // 準備: 長い名前・占有と、置き換え候補のある前処理
  const prep = { name: `準備（${LONG_TITLE}）`, description: LONG_TITLE, exclusive: [`account:${"x".repeat(60)}`], setup: { run: obs.procedures[0].run, replacement: obs.procedures[0].replacement } };
  ids.preparation = (await j(["observer", "prep", "add", "--input", "-"], JSON.stringify(prep))).id;
  ids.observation = (await j(["observer", "add", "--input", "-"], JSON.stringify(obs))).id;
  await env.p3(["observer", "suggest", ids.observation, "--note", LONG_TITLE]);
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
      await until.visible(page.getByRole("link", { name: /観測（経費精算/ }));
    },
  },
  {
    name: "観測の登録",
    open: async (page) => {
      await page.goto("/observer/new");
      await until.visible(page.getByRole("heading", { name: "観測を登録" }));
    },
  },
  {
    name: "観測の詳細",
    open: async (page) => {
      await page.goto(`/observer/${ids.observation}`);
      await until.visible(page.getByRole("region", { name: /の置き換え候補$/ }).getByText(/新規予定（まだ無い）/));
    },
  },
  {
    name: "観測の編集と提案の結果（完了）",
    open: async (page) => {
      await page.goto(`/observer/${ids.observation}/edit`);
      // 提案の結果は完了の表示まで待ってから検査する
      await until.visible(page.getByTestId("suggestion").getByText(/操作面:/));
      await until.visible(page.getByTestId("suggestion").getByRole("article").first());
    },
  },
  {
    name: "準備の一覧",
    open: async (page) => {
      await page.goto("/observer/preparations");
      await until.visible(page.getByRole("link", { name: /準備（経費精算/ }));
    },
  },
  {
    name: "準備の登録",
    open: async (page) => {
      await page.goto("/observer/preparations/new");
      await until.visible(page.getByRole("heading", { name: "準備を登録" }));
    },
  },
  {
    name: "準備の詳細",
    open: async (page) => {
      await page.goto(`/observer/preparations/${ids.preparation}`);
      await until.visible(page.getByRole("region", { name: /の置き換え候補$/ }).getByText(/新規予定（まだ無い）/));
    },
  },
  {
    name: "準備の編集",
    open: async (page) => {
      await page.goto(`/observer/preparations/${ids.preparation}/edit`);
      await until.value(page.getByLabel("名前", { exact: true }), `準備（${LONG_TITLE}）`);
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
      await until.visible(page.getByRole("link", { name: /観測（経費精算/ }));
      const banner = page.getByRole("banner");
      none(await tabTo(page, banner.getByRole("link", { name: "観測", exact: true }), "ナビゲーションの観測"), at("観測の一覧"));
      none(await tabTo(page, banner.getByRole("link", { name: /新しい要望/ }), "新しい要望"), at("観測の一覧"));
      none(await tabTo(page, banner.getByRole("link", { name: /新しい観測/ }), "新しい観測"), at("観測の一覧"));
      const [req, obs] = [await banner.getByRole("link", { name: /新しい要望/ }).innerText(), await banner.getByRole("link", { name: /新しい観測/ }).innerText()];
      expect(req, at("作成の操作の文字")).not.toBe(obs);
    }, page);
    await s.step(at("観測の登録の保存"), async () => {
      await page.goto("/observer/new");
      await page.getByLabel("タイトル").fill(LONG_TITLE);
      await page.getByLabel("タイトル").focus();
      none(await tabTo(page, page.getByRole("button", { name: "保存して続ける" }), "保存して続ける"), at("観測の登録"));
    }, page);
    await s.step(at("観測の編集の提案・取り込み・保存"), async () => {
      await page.goto(`/observer/${ids.observation}/edit`);
      await until.visible(page.getByTestId("suggestion").getByRole("article").first());
      await page.getByLabel("補足（任意）").focus();
      none(await tabTo(page, page.getByRole("button", { name: "もう一度頼む" }), "提案を頼む"), at("観測の編集"));
      none(await tabTo(page, page.getByTestId("suggestion").getByRole("button", { name: /編集欄に取り込む|測る項目を先に取り込んでください/ }).first(), "取り込む", 80), at("観測の編集"));
      none(await tabTo(page, page.getByTestId("suggestion").getByRole("link", { name: "準備の登録の画面で確かめる" }), "新しい準備の案", 80), at("観測の編集"));
      none(await tabTo(page, page.getByRole("button", { name: "保存する" }), "保存する", 200), at("観測の編集"));
    }, page);
    await s.step(at("観測の詳細の編集への移動"), async () => {
      await page.goto(`/observer/${ids.observation}`);
      await until.visible(page.getByRole("heading", { name: /観測（経費精算/ }));
      none(await tabTo(page, page.getByRole("link", { name: "編集・AI に提案を頼む" }), "編集"), at("観測の詳細"));
      await page.getByRole("button", { name: "観測を終える" }).click();
      await page.getByLabel("終える理由").focus();
      none(await tabTo(page, page.getByRole("button", { name: "終える", exact: true }), "終える"), at("観測の詳細の終了"));
      await page.getByRole("button", { name: "やめる" }).click();
    }, page);
    await s.step(at("準備の一覧から登録・詳細から編集・登録と編集の保存"), async () => {
      await page.goto("/observer/preparations");
      await until.visible(page.getByRole("link", { name: /準備（経費精算/ }));
      none(await tabTo(page, page.getByRole("link", { name: "＋ 新しい準備" }), "新しい準備"), at("準備の一覧"));
      await page.goto("/observer/preparations/new");
      await page.getByLabel("名前", { exact: true }).fill(LONG_TITLE);
      await page.getByLabel("名前", { exact: true }).focus();
      none(await tabTo(page, page.getByRole("button", { name: "保存する" }), "保存する"), at("準備の登録"));
      await page.goto(`/observer/preparations/${ids.preparation}`);
      await until.visible(page.getByRole("heading", { name: /準備（経費精算/ }));
      none(await tabTo(page, page.getByRole("link", { name: "編集", exact: true }), "編集"), at("準備の詳細"));
      await page.goto(`/observer/preparations/${ids.preparation}/edit`);
      await until.value(page.getByLabel("名前", { exact: true }), `準備（${LONG_TITLE}）`);
      await page.getByLabel("名前", { exact: true }).focus();
      none(await tabTo(page, page.getByRole("button", { name: "保存する" }), "保存する", 120), at("準備の編集"));
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
