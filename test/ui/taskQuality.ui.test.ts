// 品質基準とタスク: タスクの追加で作業先に当てはまる品質基準の件数を示して受け入れ基準に足すこと、作業先なしには全参照先の基準だけを
// 足すこと、設定を変えても既にあるタスクの基準は変えないこと、幅 375 で追加の画面がはみ出さないこと。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { rid: "", repo: "" };

async function prepare(env: UiEnv) {
  ids.repo = (JSON.parse(await env.p3(["repo", "ls", "--json"])) as { name: string }[])[0].name;
  await env.p3(["quality", "add", "--text", "lint が通る", "--how", "pnpm lint（成功: 終了コード 0）"]);
  await env.p3(["quality", "add", "--text", "用語集に従う", "--how", "docs/glossary.md", "--repo", ids.repo]);
  ids.rid = (JSON.parse(await env.p3(["request", "new", "経費の通知", "--body", "-", "--json"], "通知。\n")) as { id: string }).id;
}

describe.skipIf(!inject("chromium").available)("品質基準とタスク", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質とタスク", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  const criteria = async (env: UiEnv, tid: string) => (JSON.parse(await env.p3(["criteria", tid, "--req", ids.rid, "--json"])) as { criteria: { text: string }[] }).criteria.map((x) => x.text);

  it("タスクの追加で当てはまる基準の件数を示して足し、作業先なしは全参照先の基準だけ。設定を変えても既にあるタスクは変えない", async () => {
    const { page, step, env } = s;
    await step("作業先あり: 当てはまる2件を足す", async () => {
      await page.goto(`/requests/${ids.rid}/board`);
      await page.getByRole("button", { name: "＋ タスクを追加" }).click();
      const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
      await dialog.getByLabel("題").fill("品質つきで作る");
      await until.visible(dialog.getByText(`作業先 ${ids.repo}に当てはまる品質基準 2 件を、受け入れ基準に足して作ります。`));
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await criteria(env, "T001")).toEqual(["[Q1] lint が通る（pnpm lint（成功: 終了コード 0））", "[Q2] 用語集に従う（docs/glossary.md）"]);
    });

    await step("作業先なし: 全参照先の1件だけを足す", async () => {
      await page.getByRole("button", { name: "＋ タスクを追加" }).click();
      const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
      await dialog.getByLabel("題").fill("作業先なし");
      await dialog.getByLabel("作業先").selectOption({ label: "作業先なし" });
      await until.visible(dialog.getByText("作業先なしに当てはまる品質基準 1 件を、受け入れ基準に足して作ります。"));
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await criteria(env, "T002")).toEqual(["[Q1] lint が通る（pnpm lint（成功: 終了コード 0））"]);
    });

    await step("設定を変えても既にあるタスクの基準は変わらない", async () => {
      await env.p3(["quality", "set", "Q1", "--how", "pnpm lint --max-warnings 0"]);
      await page.goto(`/requests/${ids.rid}?task=T001`);
      await until.visible(page.locator("aside").getByText("[Q1] lint が通る（pnpm lint（成功: 終了コード 0））"));
      expect(await criteria(env, "T001")).toEqual(["[Q1] lint が通る（pnpm lint（成功: 終了コード 0））", "[Q2] 用語集に従う（docs/glossary.md）"]);
    });
  });

  it("幅 375: タスクの追加の画面がはみ出さない", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto(`/requests/${ids.rid}/board`);
        await page.getByRole("button", { name: "＋ タスクを追加" }).click();
        await until.visible(page.getByText(/当てはまる品質基準 \d 件を/));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
