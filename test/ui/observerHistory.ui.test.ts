// 観測の期待の履歴と終了の画面: 作業中のタスクの詳細の「この作業として観測を開く」→ 作業の帰属の知らせ → 観測を作る・期待を変える（理由）→
// 詳細の期待の履歴にタスクが残る → 文脈を外すと残らない → 理由と移した先を書いて終える（終えた観測は直せない）。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("観測の期待の履歴と終了", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("タスクの作業として観測を作り、期待を変え、終える", async () => {
    s = await openScenario("観測の期待の履歴");
    const { page, step, env } = s;
    const rid = JSON.parse(await env.p3(["request", "new", "一覧を速くする", "--json"])).id as string;
    await env.p3(["new", "一覧の観測を足す", "--req", rid]);
    await env.p3(["move", "T001", "doing", "--req", rid]);
    let id = "";
    await step("作業中のタスクの詳細から、この作業として観測を開くと、作業の帰属が知らされる", async () => {
      await page.goto(`/requests/${rid}/board`);
      await page.locator("section article").filter({ hasText: "T001" }).click();
      await page.locator("aside").getByRole("link", { name: "この作業として観測を開く" }).click();
      await until.url(page, /\/observer$/);
      await until.text(page.getByRole("status").filter({ hasText: "作業の帰属" }), new RegExp(`${rid}/T001`));
      await until.visible(page.getByText(/今の期待（仕様）が実際の環境・データ・使い方で成り立っているかを確かめる記録/));
    });
    await step("観測を作り、期待を理由つきで変えると、詳細の期待の履歴にタスクの作業として残る", async () => {
      await page.getByRole("banner").getByRole("link", { name: "新しい観測", exact: true }).click();
      await page.getByLabel("タイトル").fill("一覧の速さ");
      await page.getByLabel("観測内容").fill("一覧が速く出るか");
      await page.getByLabel("期待する結果（任意）").fill("1秒以内に出る");
      await page.getByRole("button", { name: "保存して続ける" }).click();
      await until.url(page, /\/edit$/);
      id = page.url().split("/").at(-2)!;
      await page.getByLabel("期待する結果（任意）").fill("0.5秒以内に出る");
      await page.getByLabel("期待を変えた理由（任意）").fill("要望で速さを上げた");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, new RegExp(`/observer/${id}$`));
      const history = page.getByRole("region", { name: "期待の履歴" });
      await until.text(history, new RegExp(`期待の変更（.*${rid}/T001 の作業）: 要望で速さを上げた`));
      await until.text(history, /「1秒以内に出る」→「0\.5秒以内に出る」/);
    });
    await step("作業の文脈を外すと、終えたときに作業の帰属は残らない。終えた観測は直せない", async () => {
      await page.getByRole("button", { name: "作業の文脈を外す" }).click();
      await page.getByRole("button", { name: "観測を終える" }).click();
      await page.getByRole("button", { name: "終える", exact: true }).click();
      await until.text(page.getByRole("form", { name: "観測を終える" }).getByRole("alert"), /終える理由/);
      await page.getByLabel("終える理由").fill("毎回同じ判定になったので CI に移した");
      await page.getByLabel("移した先（任意）").fill("GitHub Actions: list-speed");
      await page.getByRole("button", { name: "終える", exact: true }).click();
      await until.text(page.getByRole("alert"), /この観測は終了しています.*CI に移した.*GitHub Actions: list-speed/);
      expect(await page.getByRole("link", { name: "編集・AI に提案を頼む" }).count()).toBe(0);
      const d = JSON.parse(await env.p3(["observer", "show", id, "--json"]));
      expect(d.history.map((h: { kind: string; work?: unknown }) => [h.kind, !!h.work])).toEqual([["created", true], ["expected", true], ["ended", false]]);
    });
  });
});
