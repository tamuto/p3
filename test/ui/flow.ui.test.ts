// 主な流れ: 要望の登録 → Mock の Preflight → 評価と案の確認 → タスク化 → ボード → タスクの着手・完了（成果物・変更の記録）
// → 人の確認（済み）→ 要望の完了済。状態はすべて画面の操作で変え、再読み込みしても残ることを確かめる。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

const TITLE = "経費の申請に領収書の画像を添付できるようにする";
const BODY = `申請のたびに紙の領収書を経理に回しており、確認に時間がかかっている。申請の画面から画像を添付できるようにしたい。

- 申請の画面で、領収書の画像（PNG / JPEG）を1件以上添付できる
- 承認する人が、申請の詳細で添付した画像を確かめられる
- 添付の無い申請は、承認の前に警告を出す
`;

describe.skipIf(!inject("chromium").available)("主な流れ（要望の登録から完了済まで）", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("主な流れ");
  });
  afterAll(async () => {
    await s?.close();
  });

  it("画面の操作だけで、要望をタスクにして完了済まで進め、再読み込み後も残る", async () => {
    const { page, step } = s;
    const header = page.locator("main h1").first();

    await step("要望の登録", async () => {
      await page.goto("/");
      await page.getByRole("link", { name: /新しい要望/ }).first().click();
      await page.getByLabel("タイトル").fill(TITLE);
      await page.getByLabel(/^内容/).fill(BODY);
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.text(header, TITLE);
      await until.url(page, /\/requests\/\d{6}-[a-z0-9]{5}$/);
    });
    const requestUrl = new URL(page.url()).pathname;

    await step("Mock の Preflight を実行する", async () => {
      await page.getByRole("button", { name: "▶ Preflight を実行" }).click();
      await until.visible(page.getByText(/件のタスクに分割しました/).first(), 60_000);
    });

    const accept = page.getByRole("button", { name: /件をタスク化/ });
    let count = 0;
    await step("評価と案を確かめる", async () => {
      await until.visible(page.getByText("評価", { exact: true }).first());
      await until.enabled(accept);
      count = Number(/(\d+) 件をタスク化/.exec((await accept.textContent()) ?? "")?.[1]);
      expect(count).toBeGreaterThanOrEqual(2);
    });

    await step("案をタスク化する", async () => {
      await accept.click();
      await page.getByRole("link", { name: "タスクボードで見る" }).click();
      await until.url(page, new RegExp(`${requestUrl}/board$`));
      await until.count(pane(s, "未着手").locator("article"), count);
    });

    for (let i = 1; i <= count; i++) {
      const id = `T${String(i).padStart(3, "0")}`;
      await step(`${id} を作業中にする`, async () => {
        await pane(s, "未着手").locator("article").filter({ hasText: id }).click();
        const drawer = page.locator("aside");
        await drawer.getByLabel("ステータス").selectOption({ label: "作業中" });
        await drawer.getByRole("button", { name: "保存" }).click();
        await until.visible(drawer.getByText(/^rev 2 /));
        await drawer.getByRole("button", { name: "✕" }).click();
        await until.visible(pane(s, "作業中").locator("article").filter({ hasText: id }));
      });
      await step(`${id} を完了にする（成果物・変更の記録）`, async () => {
        await pane(s, "作業中").locator("article").filter({ hasText: id }).click();
        const drawer = page.locator("aside");
        await drawer.getByLabel("ステータス").selectOption({ label: "完了" });
        await drawer.getByLabel(/^成果物を編集/).fill(`https://example.com/expense/pull/${i}`);
        await drawer.getByLabel(/^変更の記録/).fill(`## 何を変えたか\n\n- ${id} の作業をした\n`);
        await drawer.getByRole("button", { name: "保存" }).click();
        await until.visible(drawer.getByRole("link", { name: new RegExp(`example\\.com/expense/pull/${i}$`) }));
      });
      await step(`${id} を済みにする（人の確認）`, async () => {
        const drawer = page.locator("aside");
        await drawer.getByRole("button", { name: "済みにする" }).click();
        await until.visible(drawer.getByText(/^済み（.+ に確認）$/));
        await drawer.getByRole("button", { name: "✕" }).click();
      });
    }

    await step("ボードから済みのタスクが消え、済みの一覧に移る", async () => {
      await until.count(page.locator("article"), 0);
      await until.visible(page.getByRole("link", { name: `済み ${count} 件 →` }));
    });

    await step("要望を完了済にする", async () => {
      await page.getByRole("link", { name: "概要・Preflight" }).click();
      const status = page.getByLabel("ステータス");
      await status.selectOption({ label: "完了済" });
      await until.value(status, "done");
    });

    await step("再読み込みしても、要望の完了済とタスクの完了・済みが残る", async () => {
      await page.reload();
      await until.text(header, TITLE);
      await until.value(page.getByLabel("ステータス"), "done");
      await page.goto(`${requestUrl}/done`);
      for (let i = 1; i <= count; i++) await until.visible(page.getByText(`T${String(i).padStart(3, "0")}`, { exact: true }).first());
    });

    await step("CLI から見ても保存されている", async () => {
      const shown = JSON.parse(await s.env.p3(["request", "show", requestUrl.split("/").pop()!, "--brief", "--json"])) as {
        item: { status: string };
        tasks: { status: string }[];
      };
      expect(shown.item.status).toBe("done");
      expect(shown.tasks.map((t) => t.status)).toEqual(Array(count).fill("done"));
    });
  });
});

/** ボードの列（未着手・作業中・完了） */
function pane(s: Scenario, label: string) {
  return s.page.locator("section").filter({ has: s.page.getByText(label, { exact: true }) });
}
