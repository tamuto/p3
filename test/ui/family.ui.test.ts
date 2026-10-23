// 親子の要望の画面: 見出しの祖先へのリンクと概要の「親子」（子の一覧・自分と配下の集計・完了できない理由）で親と子を行き来し、
// 多段の祖先・付け替え（失敗したら入力を残す）・新しい要望での親の指定・再読み込みでも残ることを確かめる。
// 進捗は親子の木で、絞り込みで子だけ合うときは親を文脈として出し（件数に数えない）、直接編集の循環は警告にする。
// 単独の要望は今までどおり。375 / 1280 の幅で長い題と祖先の列があっても横にはみ出さない。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { parent: "", child: "", grand: "", single: "", solo: "", a: "", b: "" };
const LONG = "とても長い題の親の要望で、狭い画面でも祖先の列が折り返されることを確かめるための文".repeat(2);

async function prepare(env: UiEnv) {
  const make = async (title: string, ...args: string[]) => (JSON.parse(await env.p3(["request", "new", title, ...args, "--json"])) as { id: string }).id;
  ids.parent = await make(LONG);
  ids.child = await make("申請の画面", "--parent", ids.parent, "--tag", "child-only");
  await env.p3(["new", "申請のフォーム", "--req", ids.child]);
  ids.grand = await make("申請の通知", "--parent", ids.child);
  ids.single = await make("単独の要望");
  ids.solo = await make("ひとりの要望");
  // 直接編集で循環を作る（CLI は循環を断るので、ファイルを書き換える）
  ids.a = await make("循環A");
  ids.b = await make("循環B", "--parent", ids.a);
  const file = join(env.repo, ".p3", "requests", ids.a, "request.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("status: draft", `status: draft\nparent: ${ids.b}`));
}

describe.skipIf(!inject("chromium").available)("親子の要望の画面", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("親子の要望", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("祖先と子の一覧で行き来し、集計と完了できない理由を見せる", async () => {
    const { page, step } = s;
    const family = page.locator("section").filter({ has: page.getByRole("heading", { name: "親子" }) });

    await step("子から見出しの祖先で親へ", async () => {
      await page.goto(`/requests/${ids.child}`);
      const nav = page.getByRole("navigation", { name: "親の要望" });
      await until.visible(nav);
      await nav.getByRole("link").click();
      await until.url(page, new RegExp(`/requests/${ids.parent}$`));
    });

    await step("親の概要に子の一覧と、自分・配下の集計を出す。子へ移れる", async () => {
      await until.visible(family.getByText("子の要望（1 件・表示順）"));
      await until.visible(family.getByText("自分のタスク 0/1"));
      await until.visible(family.getByText(/配下全体（自身を含む）: 0\/1/));
      await until.visible(family.getByText(/自分のタスクが無い親です/));
      await family.getByRole("link", { name: "申請の画面" }).click();
      await until.url(page, new RegExp(`/requests/${ids.child}$`));
    });

    await step("多段: 孫の見出しに根から順の祖先", async () => {
      await page.goto(`/requests/${ids.grand}`);
      const links = page.getByRole("navigation", { name: "親の要望" }).getByRole("link");
      await until.count(links, 2);
      expect(await links.allInnerTexts()).toEqual([LONG, "申請の画面"]);
    });

    await step("配下が終わっていない親は対応済にできず、対象の子と次の操作を出す", async () => {
      await page.goto(`/requests/${ids.parent}`);
      await until.visible(family.getByText(/対応済にできません: 配下の要望が終わっていません/));
      await page.getByLabel("ステータス").selectOption("resolved");
      await until.visible(page.getByText(new RegExp(`子 ${ids.child} が未完了.*子の作業を終えて`)).first());
    });
  });

  it("付け替え（失敗したら入力を残す）・新しい要望での親の指定・再読み込みでも残る", async () => {
    const { page, step } = s;
    const family = page.locator("section").filter({ has: page.getByRole("heading", { name: "親子" }) });

    await step("付け替えに失敗したら選んだ親を残し、やり直せる", async () => {
      await page.goto(`/requests/${ids.grand}`);
      await family.getByLabel("親の要望").selectOption(ids.single);
      await page.route(`**/api/requests/${ids.grand}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }) : r.fallback()), {
        times: 1,
      });
      await family.getByRole("button", { name: "親を保存" }).click();
      await until.visible(family.getByRole("alert").filter({ hasText: "選んだ親は残してあります" }));
      expect(await family.getByLabel("親の要望").inputValue()).toBe(ids.single);
      await family.getByRole("button", { name: "親を保存" }).click();
      await until.text(page.getByRole("navigation", { name: "親の要望" }), /単独の要望/);
      await page.reload();
      await until.text(page.getByRole("navigation", { name: "親の要望" }), /単独の要望/);
    });

    await step("自分と子孫は親の候補に出ない", async () => {
      await page.goto(`/requests/${ids.parent}`);
      const options = await family.getByLabel("親の要望").locator("option").allInnerTexts();
      expect(options.some((o) => o.includes(ids.parent) || o.includes(ids.child))).toBe(false);
    });

    await step("新しい要望で親を選んで作る", async () => {
      await page.goto("/requests/new");
      await page.getByLabel("タイトル").fill("申請の一覧");
      await page.getByLabel(/親の要望/).selectOption(ids.child);
      await page.getByRole("button", { name: "作成" }).click();
      await until.url(page, /\/requests\/\d{6}-[0-9a-z]{5}$/);
      await until.text(page.getByRole("navigation", { name: "親の要望" }), /申請の画面/);
    });

    await step("親も子も無い要望は今までどおり（祖先の列は出さない）", async () => {
      await page.goto(`/requests/${ids.solo}`);
      await until.visible(family.getByText(/親も子もありません/));
      expect(await page.getByRole("navigation", { name: "親の要望" }).count()).toBe(0);
    });
  });

  it("進捗は親子の木。子だけが絞り込みに合うと親を文脈として出し、数えない。循環は警告", async () => {
    const { page, step } = s;
    await step("タグで子だけを選ぶ", async () => {
      await page.goto(`/?tags=${encodeURIComponent(JSON.stringify(["child-only"]))}`);
      // 子と、子から作った（タグを写した）孫が合う。合わない根の親は文脈で、件数に入らない
      const count = page.getByText(/\d+ 件（ほかに親を文脈として表示）/);
      await until.visible(count);
      const schedule = page.getByTestId("schedule");
      const contexts = schedule.getByRole("link").filter({ hasText: "文脈" });
      await until.visible(contexts.first());
      const shown = await schedule.getByRole("link").count();
      const n = Number(/(\d+) 件/.exec(await count.innerText())![1]);
      expect(n).toBe(shown - (await contexts.count()));
      expect(await contexts.first().innerText()).toContain("とても長い題");
      await until.visible(schedule.getByRole("link", { name: /申請の画面/ }));
    });
    await step("親を畳むと子を隠し、開くと戻る", async () => {
      await page.goto("/");
      const fold = page.getByRole("button", { name: /の子を畳む/ }).first();
      await until.visible(fold);
      const before = await page.getByTestId("schedule").getByRole("link").count();
      await fold.click();
      await expect.poll(() => page.getByTestId("schedule").getByRole("link").count()).toBeLessThan(before);
      await page.getByRole("button", { name: /の子を開く/ }).first().click();
      await expect.poll(() => page.getByTestId("schedule").getByRole("link").count()).toBe(before);
    });
    await step("直接編集の循環は要望の画面で警告する", async () => {
      await page.goto(`/requests/${ids.a}`);
      await until.visible(page.getByText(/親子の問題: .*循環/).first());
    });
  });

  for (const width of [375, 1280]) {
    it(`幅 ${width} で長い題と祖先の列があっても横にはみ出さない`, async () => {
      const page = await s.open({ width });
      await s.step(
        `幅 ${width}`,
        async () => {
          for (const path of [`/requests/${ids.child}`, `/requests/${ids.parent}`, "/"]) {
            await page.goto(path);
            await until.visible(page.getByRole("heading", { level: 1 }).first());
            expect(await pageOverflow(page), path).toEqual([]);
          }
        },
        page,
      );
    });
  }
});
