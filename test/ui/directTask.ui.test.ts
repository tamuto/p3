// Preflight を通さないタスクの直接作成: タスクの無い要望のボードから「タスクを追加」で作り、再読み込み・CLI でも残ることを確かめる。
// 空の題・空白だけの題は作らず、保存に失敗したときは入力を残して一覧を読み直す。取消は保存せず、閉じたら開いたボタンへフォーカスを戻す。
// Preflight の API は一度も呼ばない。状態は CLI で用意し、作成はブラウザで行う（Docker は使わない）。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { empty: "" };

async function prepare(env: UiEnv) {
  ids.empty = (JSON.parse(await env.p3(["request", "new", "領収書の画像の大きさを制限する", "--body", "-", "--json"], "大きすぎる画像を断る。\n")) as { id: string }).id;
}

describe.skipIf(!inject("chromium").available)("Preflight を通さないタスクの直接作成", () => {
  let s: Scenario;
  const preflightCalls: string[] = [];
  beforeAll(async () => {
    s = await openScenario("直接作成", { prepare });
    s.context.on("request", (r) => {
      if (/\/api\/requests\/[^/]+\/preflight/.test(r.url())) preflightCalls.push(`${r.method()} ${r.url()}`);
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タスクの無い要望のボードから作り、再読み込み・CLI でも残る（Preflight は呼ばない）", async () => {
    const { page, step } = s;
    const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
    const add = page.getByRole("button", { name: "＋ タスクを追加" });

    await step("タスクの無いボードを開く", async () => {
      await page.goto(`/requests/${ids.empty}/board`);
      await until.visible(page.getByText(/タスクはまだありません/));
    });

    await step("取消は保存せず、開いたボタンへフォーカスを戻す", async () => {
      await add.click();
      await until.visible(dialog);
      await dialog.getByLabel("題").fill("取り消すタスク");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await add.evaluate((el) => el === document.activeElement)).toBe(true);
      // 開き直すと前の入力は残っていない
      await page.keyboard.press("Enter");
      await until.visible(dialog);
      await until.value(dialog.getByLabel("題"), "");
      await dialog.getByRole("button", { name: "取消" }).click();
      await dialog.waitFor({ state: "hidden" });
    });

    await step("空の題・空白だけの題は作らない", async () => {
      await add.click();
      await dialog.getByRole("button", { name: "作成" }).click();
      await until.visible(dialog.getByRole("alert").filter({ hasText: "題を入れてください" }));
      await dialog.getByLabel("題").fill("   ");
      await dialog.getByLabel("題").press("Enter");
      await until.visible(dialog.getByRole("alert").filter({ hasText: "題を入れてください" }));
    });

    await step("保存に失敗したら入力を残す", async () => {
      await dialog.getByLabel("題").fill("画像の大きさの上限を 5MB にする");
      await dialog.getByLabel(/^本文/).fill("- 5MB を超える画像は申請の画面で断る\n");
      await page.route("**/api/requests/*/tasks", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, body: "boom" }) : r.fallback()), {
        times: 1,
      });
      await dialog.getByRole("button", { name: "作成" }).click();
      await until.visible(dialog.getByRole("alert").filter({ hasText: /保存できませんでした.*確かめてから/ }));
      await until.value(dialog.getByLabel("題"), "画像の大きさの上限を 5MB にする");
      await until.value(dialog.getByLabel(/^本文/), "- 5MB を超える画像は申請の画面で断る\n");
    });

    await step("もう一度保存すると未着手にでき、カードから詳細を開ける", async () => {
      // 作業先は CLI の p3 new と同じ既定（作業先にできる参照先が1つならそれ）
      expect(await dialog.getByLabel("作業先").inputValue()).not.toBe("");
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
      await until.visible(page.getByRole("status").filter({ hasText: "T001 を未着手に作成しました" }));
      const card = page.locator("section").filter({ has: page.getByText("未着手", { exact: true }) }).locator("article").filter({ hasText: "T001" });
      await until.visible(card);
      expect(await add.evaluate((el) => el === document.activeElement)).toBe(true);
      await card.click();
      await until.value(page.locator("aside").getByLabel("ステータス"), "todo");
      await page.locator("aside").getByRole("button", { name: "✕" }).click();
    });

    await step("再読み込みしても残り、CLI から見ても保存されている", async () => {
      await page.reload();
      await until.visible(page.locator("article").filter({ hasText: "画像の大きさの上限を 5MB にする" }));
      const shown = JSON.parse(await s.env.p3(["request", "show", ids.empty, "--brief", "--json"])) as { tasks: { id: string; title: string; status: string }[] };
      expect(shown.tasks).toEqual([expect.objectContaining({ id: "T001", title: "画像の大きさの上限を 5MB にする", status: "todo" })]);
      const task = JSON.parse(await s.env.p3(["show", `${ids.empty}/T001`, "--brief", "--json"])) as { item: { body: string } };
      expect(task.item.body).toContain("5MB を超える画像は申請の画面で断る");
      expect(preflightCalls).toEqual([]);
    });
  });

  it("スマホの幅（375）でも、ボタンとフォームの操作が画面に収まる", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375 の幅で開く",
      async () => {
        await page.goto(`/requests/${ids.empty}/board`);
        const add = page.getByRole("button", { name: "＋ タスクを追加" });
        await until.visible(add);
        expect(await inViewport(page, add, "タスクを追加")).toEqual([]);
        await add.click();
        const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
        await until.visible(dialog);
        for (const [name, l] of [
          ["題", dialog.getByLabel("題")],
          ["作成", dialog.getByRole("button", { name: "作成" })],
          ["取消", dialog.getByRole("button", { name: "取消" })],
        ] as const)
          expect(await inViewport(page, l, name)).toEqual([]);
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
