// リリースノートの画面で、マイルストーンの要望を一括で完了済にする: できないときの理由と導線・確かめとキャンセル・実行・
// 対象0件・材料が変わったとき（何も書かない）・途中で止まったとき（応答を差し替える）とやり直し・二重に送らない・
// タスクの済みと本文の入力を変えない・1280 と 375・キーボード・プロジェクトを跨ぐ serve。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { a: "", b: "", c: "", d: "", e: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[]) => JSON.parse(await env.p3([...args, "--json"])) as { id: string };
  const finished = async (title: string, milestone: string) => {
    const id = (await j(["request", "new", title, "--milestone", milestone])).id;
    await env.p3(["new", `${title}の作業`, "--req", id]);
    await env.p3(["move", "T001", "done", "--req", id, "--record", `${title}を足した`]);
    await env.p3(["request", "set", id, "status=resolved"]);
    return id;
  };
  await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
  await env.p3(["milestone", "add", "v2", "--title", "次のリリース"]);
  ids.a = await finished("検索", "v1");
  ids.b = await finished("通知", "v1");
  await env.p3(["check", "T001", "--req", ids.a]); // 人の済み（変えないことを確かめる）
  ids.c = (await j(["request", "new", "途中の要望", "--milestone", "v1"])).id;
  await env.p3(["new", "まだの作業", "--req", ids.c]);
  ids.d = await finished("一覧", "v2");
  ids.e = await finished("設定", "v2");
}

type Shown = { item: { status: string } };
const statusOf = async (env: UiEnv, id: string) => (JSON.parse(await env.p3(["request", "show", id, "--json"])) as Shown).item.status;
const checkedOf = async (env: UiEnv, id: string) => (JSON.parse(await env.p3(["show", `${id}/T001`, "--json"])) as { item: { checkedAt?: string } }).item.checkedAt;

const openButton = (page: Page) => page.getByRole("button", { name: /^要望を一括で完了済にする/ });
const confirmGroup = (page: Page) => page.getByRole("group", { name: /の要望 \d+ 件を完了済にしますか/ });

describe.skipIf(!inject("chromium").available)("リリースノート: 要望の一括完了", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("要望の一括完了", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("未完了があればできず理由と導線を出し、確かめ・キャンセル・実行で対応済だけを完了済にする（済み・本文の入力は変えない）", async () => {
    const { page, step, env } = s;
    // 本文の欄（ラベルが欄を包むので、入力すると名前に本文が入る。id で指す）
    const body = page.locator("textarea#rn-body");
    await step("未完了があればボタンは押せず、理由と要望への導線を出す", async () => {
      await page.goto("/release-notes?m=v1");
      await until.visible(page.getByText("一括で完了済にできません"));
      expect(await openButton(page).isDisabled()).toBe(true);
      await until.visible(page.getByText(/途中の要望（.*）: 未完了（/));
      const link = page.getByRole("region", { name: "要望の一括完了" }).getByRole("link", { name: "要望を開く →" });
      expect(await link.getAttribute("href")).toContain(ids.c);
      await body.fill("## 最初のリリース\n\n- 書きかけ");
    });
    await step("未完了の要望を見送りにすると（外の変更）、表示が変わって押せる", async () => {
      await env.p3(["request", "set", ids.c, "status=rejected"]);
      await until.visible(openButton(page).filter({ hasText: "（2件）" }));
      expect(await openButton(page).isDisabled()).toBe(false);
      await until.value(body, "## 最初のリリース\n\n- 書きかけ");
    });
    await step("確かめの欄に対象を出し、キャンセルで閉じてボタンへ戻る（キーボード）", async () => {
      await openButton(page).focus();
      await page.keyboard.press("Enter");
      const group = confirmGroup(page);
      await until.visible(group);
      await until.visible(group.getByText("検索"));
      await until.visible(group.getByText("通知"));
      await until.visible(group.getByText("タスクの「済み」は変更しません"));
      await page.keyboard.press("Enter"); // キャンセルにフォーカスがある
      await until.count(group, 0);
      expect(await openButton(page).evaluate((el) => el === document.activeElement)).toBe(true);
      expect(await statusOf(env, ids.a)).toBe("resolved");
    });
    await step("実行すると対応済だけを完了済にし、済み・本文の入力・見送りは変えない", async () => {
      const checked = await checkedOf(env, ids.a);
      await openButton(page).click();
      await confirmGroup(page).getByRole("button", { name: "2件を完了済にする" }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "2 件を完了済にしました" }));
      expect([await statusOf(env, ids.a), await statusOf(env, ids.b), await statusOf(env, ids.c)]).toEqual(["done", "done", "rejected"]);
      expect(await checkedOf(env, ids.a)).toBe(checked);
      expect(await checkedOf(env, ids.b)).toBeUndefined();
      await until.value(body, "## 最初のリリース\n\n- 書きかけ");
      // 取り直した判定: 対象0件
      await until.visible(page.getByText("完了済にする要望はありません"));
      expect(await openButton(page).isDisabled()).toBe(true);
    });
  });

  it("表示したあとで材料が変わったら何も書かずに知らせる。途中で止まったら分けて出し、やり直せる。送っている間は二重に送らない", async () => {
    const { page, step, env } = s;
    await step("確かめている間に外で要望が変わると、実行しても何も書かない（自動で頼み直さない）", async () => {
      await page.goto("/release-notes?m=v2");
      await openButton(page).click();
      await until.visible(confirmGroup(page));
      await env.p3(["request", "set", ids.e, "title=設定（直した）"]);
      await confirmGroup(page).getByRole("button", { name: "2件を完了済にする" }).click();
      await until.visible(page.getByRole("alert").filter({ hasText: "表示したあとで" }));
      expect([await statusOf(env, ids.d), await statusOf(env, ids.e)]).toEqual(["resolved", "resolved"]);
    });
    await step("途中で止まった応答: 完了済にした・止まった・まだ変えていないを分けて出す", async () => {
      await page.route("**/release-notes/v2/complete-requests", (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "止まりました",
            code: "partial",
            result: { milestone: "v2", completed: [], failed: { id: ids.d, reason: "判定したあとで要望が変わりました", code: "conflict" }, notRun: [ids.e], alreadyDone: [] },
          }),
        }),
      );
      await openButton(page).click();
      await confirmGroup(page).getByRole("button", { name: "2件を完了済にする" }).click();
      const alert = page.getByRole("alert").filter({ hasText: "途中で止まりました" });
      await until.visible(alert);
      await until.visible(alert.getByText(`止まった: ${ids.d}（判定したあとで要望が変わりました）`));
      await until.visible(alert.getByText(`まだ変えていない: ${ids.e}`));
      await page.unroute("**/release-notes/v2/complete-requests");
    });
    await step("送っている間はボタンを押せない。やり直すと完了済にする", async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let posts = 0;
      await page.route("**/release-notes/v2/complete-requests", async (route) => {
        posts++;
        await held;
        await route.continue();
      });
      await openButton(page).click();
      const run = confirmGroup(page).getByRole("button", { name: /件を完了済にする|完了済にしています/ });
      await run.click();
      await until.visible(confirmGroup(page).getByRole("button", { name: "完了済にしています…" }));
      expect(await run.isDisabled()).toBe(true);
      expect(await confirmGroup(page).getByRole("button", { name: "キャンセル" }).isDisabled()).toBe(true);
      release();
      await until.visible(page.getByRole("status").filter({ hasText: "2 件を完了済にしました" }));
      await page.unroute("**/release-notes/v2/complete-requests");
      expect(posts).toBe(1);
      expect([await statusOf(env, ids.d), await statusOf(env, ids.e)]).toEqual(["done", "done"]);
    });
  });

  for (const width of [1280, 375]) {
    it(`幅 ${width} で、理由・操作・確かめ・結果が画面に収まる`, async () => {
      const page = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          // v1 に未完了の要望を足して、理由が出る状態にする
          const extra = (JSON.parse(await s.env.p3(["request", "new", `長い題の未完了の要望 ${width}：領収書の画像の添付・差し戻し・再申請・承認の履歴`, "--milestone", "v1", "--json"])) as { id: string }).id;
          await page.goto("/release-notes?m=v1");
          const region = page.getByRole("region", { name: "要望の一括完了" });
          await until.visible(region.getByText("一括で完了済にできません"));
          await region.scrollIntoViewIfNeeded();
          expect(await pageOverflow(page)).toEqual([]);
          expect(await inViewport(page, openButton(page), "ボタン")).toEqual([]);
          expect(await inViewport(page, region.getByText(/長い題の未完了の要望/), "理由")).toEqual([]);
          await s.env.p3(["request", "set", extra, "status=rejected"]);
        },
        page,
      );
      await page.context().close();
    });
  }
});

describe.skipIf(!inject("chromium").available)("リリースノート: 要望の一括完了（プロジェクトを跨ぐ serve）", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("要望の一括完了（跨ぐ）", { prepare, serveArgs: ["--all-projects"] });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("開いているプロジェクトの要望だけを完了済にする", async () => {
    const { page, step, env } = s;
    await step("uitest の v2 を完了済にする", async () => {
      await page.goto("/projects/uitest/release-notes?m=v2");
      await openButton(page).click();
      await confirmGroup(page).getByRole("button", { name: "2件を完了済にする" }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "2 件を完了済にしました" }));
      expect([await statusOf(env, ids.d), await statusOf(env, ids.e)]).toEqual(["done", "done"]);
      expect(await statusOf(env, ids.a)).toBe("resolved");
    });
  });
});
