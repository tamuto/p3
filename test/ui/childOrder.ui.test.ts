// 子の表示順: 親の概要の「親子」で「上へ」「下へ」で並べ、「順序を保存」で保存する。保存するまでは下書きで「取消」で戻せ、
// 保存の失敗（競合）でも並べた順を残す。保存した順は再読み込み・進捗の木・CLI の親で絞った一覧で同じで、後ろの子を更新しても
// 変わらない。キーボードで並べ、端の操作は押せず、読み上げの操作名に子の題が入る。375 / 1280 の幅で横にはみ出さない。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { parent: "", a: "", b: "", c: "" };
const LONG = "とても長い題の子の要望で、狭い画面でも並べ替えの操作が折り返されることを確かめるための文".repeat(2);

async function prepare(env: UiEnv) {
  const make = async (title: string, ...args: string[]) => (JSON.parse(await env.p3(["request", "new", title, ...args, "--json"])) as { id: string }).id;
  ids.parent = await make("並べる親");
  ids.a = await make("子A", "--parent", ids.parent);
  ids.b = await make("子B", "--parent", ids.parent);
  ids.c = await make(LONG, "--parent", ids.parent);
}

/** 「親子」の子の一覧の題（上から） */
const order = (page: Page) =>
  page
    .getByRole("list", { name: "子の要望（表示順）" })
    .getByRole("listitem")
    .evaluateAll((lis) => lis.map((li) => li.querySelector("a")?.textContent ?? ""));

describe.skipIf(!inject("chromium").available)("子の表示順", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("子の表示順", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("上へ・下へで並べ、取消で戻し、保存した順は再読み込み・進捗・CLI で同じ。競合しても下書きを残す", async () => {
    const { page, step } = s;
    const save = page.getByRole("button", { name: "順序を保存" });

    await step("作成順で並び、端の操作は押せない。前提を確かめる案内を出す", async () => {
      await page.goto(`/requests/${ids.parent}`);
      await until.visible(page.getByText("表示順は着手可能かを判定しません。子の本文にある前提を確認してください。"));
      expect(await order(page)).toEqual(["子A", "子B", LONG]);
      await until.disabled(page.getByRole("button", { name: "子A を上へ" }));
      await until.disabled(page.getByRole("button", { name: `${LONG} を下へ` }));
      expect(await save.count()).toBe(0);
    });

    await step("キーボードで並べ、フォーカスは動かした子の操作に残る（端に着いたら反対の操作）", async () => {
      await page.getByRole("button", { name: `${LONG} を上へ` }).focus();
      await page.keyboard.press("Enter");
      expect(await order(page)).toEqual(["子A", LONG, "子B"]);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(`${LONG} を上へ`);
      await page.keyboard.press("Enter");
      expect(await order(page)).toEqual([LONG, "子A", "子B"]);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(`${LONG} を下へ`);
      await until.visible(page.getByRole("status").filter({ hasText: `${LONG} を 1 番目に移しました（保存していません）` }));
      await until.visible(page.getByText("保存していない並べ替えがあります"));
    });

    await step("取消で保存した順に戻す", async () => {
      await page.getByRole("button", { name: "取消" }).click();
      expect(await order(page)).toEqual(["子A", "子B", LONG]);
      expect(await save.count()).toBe(0);
    });

    await step("保存に失敗（競合）しても並べた順を残し、もう一度保存できる", async () => {
      await page.getByRole("button", { name: "子B を上へ" }).click();
      expect(await order(page)).toEqual(["子B", "子A", LONG]);
      let failed = false;
      await page.route(`**/api/requests/${ids.parent}/child-order`, async (route) => {
        if (failed) return route.continue();
        failed = true;
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "競合", code: "rev_conflict" }) });
      });
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: "並べた順は残してあります" }));
      expect(await order(page)).toEqual(["子B", "子A", LONG]);
      await save.click();
      await save.waitFor({ state: "hidden" });
      await page.unroute(`**/api/requests/${ids.parent}/child-order`);
      expect(await order(page)).toEqual(["子B", "子A", LONG]);
    });

    await step("再読み込み・CLI の親で絞った一覧・進捗の木で同じ順。後ろの子を更新しても変わらない", async () => {
      await s.env.p3(["request", "set", ids.c, "--body", "-"], "後ろの子を更新した");
      await s.env.p3(["new", "作業", "--req", ids.c]);
      await page.reload();
      await until.visible(page.getByRole("list", { name: "子の要望（表示順）" }));
      expect(await order(page)).toEqual(["子B", "子A", LONG]);
      const cli = JSON.parse(await s.env.p3(["request", "ls", "--parent", ids.parent, "--json"])) as { id: string }[];
      expect(cli.map((r) => r.id)).toEqual([ids.b, ids.a, ids.c]);
      await page.goto("/");
      await until.visible(page.getByTestId("schedule").getByRole("link", { name: /子A/ }));
      const titles = await page.getByTestId("schedule").getByRole("link").allInnerTexts();
      const kids = titles.filter((t) => ["子A", "子B", LONG].some((k) => t.includes(k)));
      expect(kids.map((t) => (t.includes("子A") ? "A" : t.includes("子B") ? "B" : "C"))).toEqual(["B", "A", "C"]);
    });
  });

  for (const width of [375, 1280]) {
    it(`幅 ${width} で横にはみ出さず、並べ替えの操作と保存に届く`, async () => {
      const page = await s.open({ width, height: 700 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await page.goto(`/requests/${ids.parent}`);
          await until.visible(page.getByRole("list", { name: "子の要望（表示順）" }));
          expect(await pageOverflow(page), `幅 ${width}: 横のはみ出し`).toEqual([]);
          const down = page.getByRole("button", { name: "子B を下へ" });
          expect(await reachable(down, "子B を下へ")).toEqual([]);
          await down.click();
          expect(await reachable(page.getByRole("button", { name: "順序を保存" }), "順序を保存")).toEqual([]);
          expect(await pageOverflow(page), `幅 ${width}: 並べたあとの横のはみ出し`).toEqual([]);
          await page.getByRole("button", { name: "取消" }).click();
        },
        page,
      );
      await page.context().close();
    });
  }
});
