// タスク化した後の要望の概要: 「Preflight を実行」・再評価・メモの再実行が出ず、新しい要望・子の要望の登録へ移れる（子は親を選んだ状態で開く）。
// 本文の編集の案内も、再評価ではなく新しい要望を案内する。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("タスク化した後の要望は再評価しない", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("概要に新しい要望への導線が出て、子として登録できる", async () => {
    s = await openScenario("タスク化した後の再評価");
    const { page, step, env } = s;
    const rid = JSON.parse(await env.p3(["request", "new", "一覧を速くする", "--body", "- 一覧\n- 検索", "--json"])).id as string;
    await env.p3(["preflight", rid, "--engine", "mock"]);
    await env.p3(["accept", rid]);
    await step("概要に Preflight の実行・再評価・メモの再実行が無く、理由と新しい要望の導線が出る", async () => {
      await page.goto(`/requests/${rid}`);
      await until.visible(page.getByText(/進行中の要望は、タスク化した後なので再評価しません。変えたいことは新しい要望を登録してください/));
      await until.count(page.getByRole("button", { name: /Preflight/ }), 0);
      await until.count(page.getByRole("button", { name: "保存して再実行" }), 0);
      await until.count(page.getByRole("button", { name: "今の内容で再評価する" }), 0);
      await until.visible(page.getByText(/メモは次の Preflight に渡すものなので、ここでは書き足しません/));
    });
    await step("本文の編集の案内も新しい要望を案内する", async () => {
      await page.getByRole("button", { name: /本文を編集/ }).click();
      await until.visible(page.getByText(/本文の修正は要望の記録として残ります。変えたいことは新しい要望を登録してください/));
      await page.getByRole("button", { name: "キャンセル" }).click();
    });
    await step("「この要望の子として登録する」で、親を選んだ登録の画面が開き、子を登録できる", async () => {
      await page.getByRole("link", { name: "この要望の子として登録する" }).click();
      await until.url(page, /\/requests\/new\?parent=/);
      await until.value(page.getByLabel("親の要望（任意。子として作る）"), rid);
      await page.getByLabel("タイトル").fill("検索も速くする");
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.url(page, /\/requests\/\d{6}-[0-9a-z]{5}$/);
      // 子はまだタスク化していないので Preflight を実行できる
      await until.visible(page.getByRole("button", { name: "▶ Preflight を実行" }));
    });
    const list = JSON.parse(await env.p3(["request", "list", "--json"])) as { id: string; parent?: string }[];
    expect(list.filter((r) => r.parent === rid)).toHaveLength(1);
  });
});
