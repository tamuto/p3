// 子の要望の分割案のレビューと採用: 分割の run（Mock は箇条書き 6 件以上で子の案を書く）を CLI で用意し、要望の概要で
// 分割の判断と子の案を読み、題・本文・採否を直し、確認してから子を作る。未保存の編集・取消・二重送信・途中の失敗と続き・
// 古い評価（親の本文の変更）を確かめ、375 / 1280 の幅で長い本文があっても横にはみ出さないことを測る。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { big: "", stale: "" };
const items = (n: number, long = "") => Array.from({ length: n }, (_, i) => `- 項目${i + 1}${long}`).join("\n");

async function prepare(env: UiEnv) {
  const long = "：とても長い説明".repeat(30);
  ids.big = (JSON.parse(await env.p3(["request", "new", "経費の申請と承認を作り直す", "--body", "-", "--json"], items(7, long))) as { id: string }).id;
  await env.p3(["preflight", ids.big, "--engine", "mock", "--json"]);
  ids.stale = (JSON.parse(await env.p3(["request", "new", "古くなる分割", "--body", "-", "--json"], items(6))) as { id: string }).id;
  await env.p3(["preflight", ids.stale, "--engine", "mock", "--json"]);
  // 評価のあとで本文を変える（古い評価からは採用しない）
  await env.p3(["request", "set", ids.stale, "--body", "-"], `${items(6)}\n- 追加`);
}

describe.skipIf(!inject("chromium").available)("子の要望の分割案", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("子の要望の分割案", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("分割の判断と案を読み、直し、確認してから子を作る。途中の失敗は続きから作る", async () => {
    const { page, step } = s;
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /子の要望への分割案/ }) });
    const confirm = page.getByRole("button", { name: "採用内容を確認" });

    await step("分割の判断と子の案を出す（タスク案ではない）", async () => {
      await page.goto(`/requests/${ids.big}`);
      await until.visible(section);
      await until.visible(section.getByText(/子の要望に分けることを提案しています（想定 7 タスク）/));
      await until.count(section.getByRole("listitem").filter({ has: page.getByRole("checkbox") }), 3);
      expect(await page.getByRole("heading", { name: /^タスク案/ }).count()).toBe(0);
    });

    await step("詳細はキーボードで開閉できる", async () => {
      const summary = section.getByText("目的・範囲・完了条件・前提を見る").first();
      await summary.focus();
      await page.keyboard.press("Enter");
      await until.visible(section.getByRole("heading", { name: "完了条件" }).first());
      await page.keyboard.press("Enter");
      await section.getByRole("heading", { name: "完了条件" }).first().waitFor({ state: "hidden" });
    });

    await step("未保存の編集がある間は採用しない。保存すると採用できる", async () => {
      await section.getByRole("button", { name: "題・本文を直す" }).first().click();
      await section.getByLabel("C1 の題").fill("申請の画面と API");
      await until.disabled(confirm);
      await until.visible(section.getByText(/保存していない子の案の編集があります/));
      await section.getByRole("button", { name: "変更を保存" }).click();
      await until.visible(section.getByText("申請の画面と API"));
      await until.enabled(confirm);
    });

    await step("採否を外すと数が変わり、0 件では確認できない", async () => {
      // 採否は保存してから表示に出る（押した直後には変わらない）
      const toggle = async (key: string, want: boolean) => {
        await section.getByLabel(`${key} を採用`).click();
        await expect.poll(() => section.getByLabel(`${key} を採用`).isChecked(), { timeout: 15_000 }).toBe(want);
      };
      await toggle("C3", false);
      await until.visible(page.getByRole("heading", { name: /子の要望への分割案 \(2\/3 件を採用\)/ }));
      await toggle("C1", false);
      await toggle("C2", false);
      await until.disabled(confirm);
      await until.visible(section.getByText("採用する子の案を選んでください"));
      await toggle("C1", true);
      await toggle("C2", true);
      await until.enabled(confirm);
    });

    await step("確認で親は残す・子の Preflight はまだと示し、取消（Escape）では何も作らない", async () => {
      await confirm.click();
      const group = page.getByRole("group", { name: "採用の確認" });
      await until.visible(group.getByText(/親 .* は残します/));
      await until.visible(group.getByText(/Preflight はまだ実行しません/));
      await page.keyboard.press("Escape");
      await group.waitFor({ state: "hidden" });
      expect(await confirm.evaluate((el) => el === document.activeElement)).toBe(true);
      expect(JSON.parse(await s.env.p3(["request", "ls", "--parent", ids.big, "--json"]))).toEqual([]);
    });

    await step("途中で失敗したら、作った子と続きを出し、続きから作る（二重送信しない）", async () => {
      let posts = 0;
      // 1回目は C1 だけ作れたことにする（サーバの途中の失敗の応答）
      await page.route(`**/api/requests/${ids.big}/preflight/*/materialize`, async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        posts++;
        if (posts > 1) return r.fallback();
        return r.fulfill({ status: 207, contentType: "application/json", body: JSON.stringify({ created: [], failed: [{ key: "C1", error: "ディスクがいっぱい", code: "error" }], pending: ["C2"] }) });
      });
      await confirm.click();
      const create = page.getByRole("button", { name: "子の要望を 2 件作成" });
      await create.dblclick();
      await until.visible(page.getByText(/C1 で止まりました（未実行: C2）/));
      expect(posts).toBe(1);
      await page.unroute(`**/api/requests/${ids.big}/preflight/*/materialize`);
      await page.getByRole("button", { name: /採用内容を確認|続きを作る/ }).click();
      await page.getByRole("button", { name: /子の要望を 2 件作成|続きを作る/ }).last().click();
      await until.visible(page.getByText(/子の要望を 2 件作成しました/));
      const kids = JSON.parse(await s.env.p3(["request", "ls", "--parent", ids.big, "--json"])) as { id: string; title: string }[];
      expect(kids.map((k) => k.title)).toContain("申請の画面と API");
      expect(kids).toHaveLength(2);
    });

    await step("作った子を開ける", async () => {
      await page.getByRole("status").getByRole("link").first().click();
      await until.url(page, /\/requests\/\d{6}-[0-9a-z]{5}$/);
      expect(page.url()).not.toContain(ids.big);
    });
  });

  it("古い評価からは採用しない（再評価を案内する）", async () => {
    const { page, step } = s;
    await step("本文が変わった分割の run", async () => {
      await page.goto(`/requests/${ids.stale}`);
      await until.visible(page.getByText(/この評価は今の要望（または親子）と違うので、採用できません/));
      await until.disabled(page.getByRole("button", { name: "採用内容を確認" }));
      expect(JSON.parse(await s.env.p3(["request", "ls", "--parent", ids.stale, "--json"]))).toEqual([]);
    });
  });

  for (const width of [375, 1280]) {
    it(`幅 ${width} で長い本文の案を開いても横にはみ出さない`, async () => {
      const page = await s.open({ width });
      await s.step(
        `幅 ${width}`,
        async () => {
          await page.goto(`/requests/${ids.big}`);
          await until.visible(page.getByRole("heading", { name: /子の要望への分割案/ }));
          for (const d of await page.locator("details").all()) await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));
          expect(await pageOverflow(page)).toEqual([]);
        },
        page,
      );
    });
  }
});
