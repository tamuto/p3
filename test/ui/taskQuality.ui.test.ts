// 品質基準とタスク: タスクの追加で作業先に当てはまる品質基準を取り込む（外すこともできる）、設定を変えた後にタスク詳細で差分を見て
// 選んだものだけを取り込む（変わった条件の証拠は再確認が必要になる）、幅 375 ではみ出さないこと。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { rid: "", repo: "" };

async function prepare(env: UiEnv) {
  ids.repo = (JSON.parse(await env.p3(["repo", "ls", "--json"])) as { name: string }[])[0].name;
  await env.p3(["quality", "add", "--text", "lint が通る", "--command", "pnpm lint", "--success", "終了コード 0"]);
  await env.p3(["quality", "add", "--text", "用語集に従う", "--reference", "docs/glossary.md"]);
  ids.rid = (JSON.parse(await env.p3(["request", "new", "経費の通知", "--body", "-", "--json"], "通知。\n")) as { id: string }).id;
  await env.p3(["new", "既存のタスク", "--req", ids.rid, "--quality", "none"]);
}

describe.skipIf(!inject("chromium").available)("品質基準とタスク", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質とタスク", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タスクの追加で取り込み、設定を変えた後は詳細で差分を選んで取り込む", async () => {
    const { page, step, env } = s;
    await step("タスクの追加: 作業先に当てはまる品質基準を取り込む", async () => {
      await page.goto(`/requests/${ids.rid}/board`);
      await page.getByRole("button", { name: "＋ タスクを追加" }).click();
      const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
      await dialog.getByLabel("題").fill("品質つきで作る");
      await until.visible(dialog.getByText(/当てはまる品質基準を受け入れ基準に取り込む（2 件）/));
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
      const c = JSON.parse(await env.p3(["criteria", "T002", "--req", ids.rid, "--json"])) as { criteria: { text: string }[] };
      expect(c.criteria.map((x) => x.text)).toEqual(["[Q1] lint が通る（検査: pnpm lint（成功: 終了コード 0））", "[Q2] 用語集に従う（人の確認: docs/glossary.md）"]);
    });

    await step("既存のタスク: 差分を見て、選んだものだけを取り込む", async () => {
      await env.p3(["quality", "set", "Q1", "--command", "pnpm lint --max-warnings 0", "--success", "終了コード 0"]);
      await page.goto(`/requests/${ids.rid}?task=T001`);
      const panel = page.getByRole("region", { name: "品質基準との差分" });
      await until.visible(panel.getByText(/Q1/));
      await panel.getByLabel(/Q2 を取り込む/).uncheck();
      await panel.getByRole("button", { name: "選んだ差分を取り込む" }).click();
      await until.count(panel.getByText(/Q1 足す/), 0);
      await until.visible(panel.getByText(/Q2 足す/));
      const c = JSON.parse(await env.p3(["criteria", "T001", "--req", ids.rid, "--json"])) as { criteria: { text: string }[] };
      expect(c.criteria.map((x) => x.text)).toEqual(["[Q1] lint が通る（検査: pnpm lint --max-warnings 0（成功: 終了コード 0））"]);
    });
  });

  it("幅 375: 差分の欄がはみ出さない", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375",
      async () => {
        await page.goto(`/requests/${ids.rid}?task=T001`);
        await until.visible(page.getByRole("region", { name: "品質基準との差分" }));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
