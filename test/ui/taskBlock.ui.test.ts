// 止まっている理由の画面: ボードの作業中カードと「停止中のみ」、進捗の「停止中のみ」と親子の文脈・配下の停止、タスク詳細での
// 付与 → 再読み込み → 内容の編集（止まった時刻は変わらない）→ 解除 → 履歴、止まったままの移動の拒否、外の変更での競合と入力の保持、
// 作業中でないタスク、幅 375 と暗いテーマで長い理由が読めてはみ出さないこと。状態は CLI で用意し、保存の結果も CLI で確かめる。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG = "領収書の画像の向きが端末ごとに違い、どちらを正とするかで申請の画面と承認の画面の両方の作りが変わるため、先に進めない".repeat(3);
const ids = { a: "", parent: "", child: "", empty: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  ids.a = (await j(["request", "new", "経費の申請を直す", "--body", "-"], "申請。\n")).id;
  const a = ["--req", ids.a];
  for (const t of ["止まっているタスク", "止まっていないタスク", "未着手のタスク", "画面で止めるタスク"]) await env.p3(["new", t, ...a]);
  for (const t of ["T001", "T002", "T004"]) await env.p3(["move", t, "doing", ...a]);
  await env.p3(["block", "T001", ...a, "--reason", LONG, "--decision", "縦向きを正としてよいか"]);
  ids.parent = (await j(["request", "new", "運用の改善", "--body", "-"], "親。\n")).id;
  ids.child = (await j(["request", "new", "通知の権限", "--parent", ids.parent, "--body", "-"], "子。\n")).id;
  await env.p3(["new", "権限を確かめる", "--req", ids.child]);
  await env.p3(["move", "T001", "doing", "--req", ids.child]);
  await env.p3(["block", "T001", "--req", ids.child, "--reason", "接続に必要な権限の判断を待っている"]);
  ids.empty = (await j(["request", "new", "止まっていない要望", "--body", "-"], "空。\n")).id;
  await env.p3(["new", "普通のタスク", "--req", ids.empty]);
}

describe.skipIf(!inject("chromium").available)("止まっている理由", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("停止", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });
  const showJson = async (env: UiEnv, tid: string) =>
    JSON.parse(await env.p3(["show", tid, "--req", ids.a, "--json"])) as { item: { status: string; block?: { reason: string; decision?: string; since: string }; blockHistory?: { action: string }[] } };

  it("ボードと進捗で見つけ、タスク詳細で付ける・直す・解除し、履歴を読む。状態は作業中のまま", async () => {
    const { page, step, env } = s;
    const panelBox = page.getByRole("status", { name: "止まっています" });

    await step("ボード: 作業中カードに停止・理由・決めてほしいこと。停止中のみで止まっているものだけ（列は増えない）", async () => {
      await page.goto(`/requests/${ids.a}/board`);
      const card = page.getByLabel("T001 は止まっています");
      await until.visible(card.getByText(/⏸ 停止中/));
      await until.visible(card.getByText("決めてほしいこと: 縦向きを正としてよいか"));
      await until.visible(page.getByText("全 4 件・作業中 3 件（うち停止中 1 件）"));
      await page.getByLabel("停止中のみ").check();
      await until.url(page, /blocked=true/);
      await until.visible(page.getByText("1 / 全 3"));
      expect(await page.getByText("止まっていないタスク").count()).toBe(0);
      await page.reload();
      await until.visible(page.getByText("1 / 全 3"));
      await page.goto(`/requests/${ids.empty}/board?blocked=true`);
      await until.visible(page.getByText("停止中のタスクはありません。"));
      await page.getByRole("button", { name: "絞り込みを解除" }).click();
      await until.visible(page.getByText("普通のタスク"));
    });

    await step("進捗: 停止中のみで止まっている要望と親（文脈・配下の停止）", async () => {
      await page.goto("/?blocked=true");
      await until.visible(page.getByText("停止中 2 件・2 要望"));
      await until.visible(page.getByText("⏸停止 1").first());
      await until.visible(page.getByText("配下の停止 1"));
      await until.visible(page.getByText("文脈"));
      expect(await page.getByText("止まっていない要望").count()).toBe(0);
    });

    await step("タスク詳細: 付けて、再読み込みしても残る", async () => {
      await page.goto(`/requests/${ids.a}?task=T004`);
      await page.getByRole("button", { name: "停止理由を付ける" }).click();
      await until.disabled(page.getByRole("button", { name: "停止理由を保存" }));
      await page.getByLabel(/止まっている理由/).fill("前提が崩れた");
      await page.getByLabel(/決めてほしいこと/).fill("方式 A と B のどちらにするか");
      await page.getByRole("button", { name: "停止理由を保存" }).click();
      await until.visible(panelBox.getByText("前提が崩れた"));
      await page.reload();
      await until.visible(panelBox.getByText("方式 A と B のどちらにするか"));
      // 閉じたらフォーカスは操作元に戻る
      expect(await page.getByRole("button", { name: "停止内容を編集" }).isVisible()).toBe(true);
    });

    await step("内容を直しても止まった時刻は変わらない", async () => {
      const since = (await showJson(env, "T004")).item.block!.since;
      await page.getByRole("button", { name: "停止内容を編集" }).click();
      await page.getByLabel(/止まっている理由/).fill("前提が崩れた（仕様書の 3 章）");
      await page.getByRole("button", { name: "停止理由を保存" }).click();
      await until.visible(panelBox.getByText("前提が崩れた（仕様書の 3 章）"));
      expect((await showJson(env, "T004")).item.block!.since).toBe(since);
    });

    await step("解除: 回答が要り、状態は作業中のまま。履歴を読める", async () => {
      await page.getByRole("button", { name: "停止を解除" }).click();
      await until.visible(page.getByText(/作業は自動で再開しません/));
      await until.disabled(page.getByRole("button", { name: "記録して停止を解除" }));
      await page.getByLabel(/回答・解決の内容/).fill("方式 A にする");
      await page.getByRole("button", { name: "記録して停止を解除" }).click();
      await until.count(panelBox, 0);
      const t = (await showJson(env, "T004")).item;
      expect(t.status).toBe("doing");
      expect(t.blockHistory!.map((h) => h.action)).toEqual(["set", "update", "clear"]);
      await page.getByText("停止の履歴（3 件）").click();
      await until.visible(page.getByText("回答・解決: 方式 A にする"));
    });

    await step("止まったまま完了へ動かすと断られ、解除へ案内する（入力は残る）", async () => {
      await page.goto(`/requests/${ids.a}?task=T001`);
      await until.visible(panelBox);
      await page.locator("aside select").first().selectOption("done");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(page.getByText(/止まっています.*解除してください/));
      expect(await page.locator("aside select").first().inputValue()).toBe("done");
      await page.getByRole("button", { name: "破棄" }).click();
      expect((await showJson(env, "T001")).item.status).toBe("doing");
    });

    await step("編集中に外で変わったら入力を残して知らせ、最新に合わせて保存できる", async () => {
      await page.getByRole("button", { name: "停止内容を編集" }).click();
      await page.getByLabel(/決めてほしいこと/).fill("画面の入力");
      await env.p3(["block", "T001", "--req", ids.a, "--reason", "外で直した理由"]);
      await until.visible(page.getByText(/編集中に他で更新されました/));
      await page.getByRole("button", { name: "停止理由を保存" }).click();
      await until.visible(page.getByRole("alert").filter({ hasText: /他で更新されました/ }));
      await until.value(page.getByLabel(/決めてほしいこと/), "画面の入力");
      await page.getByRole("button", { name: "最新に合わせる" }).click();
      await page.getByRole("button", { name: "停止理由を保存" }).click();
      await until.visible(panelBox.getByText("画面の入力"));
    });

    await step("作業中でないタスクには付けられない", async () => {
      await page.goto(`/requests/${ids.a}?task=T003`);
      await until.visible(page.getByText("停止理由は作業中のタスクだけに付けられます。"));
      expect(await page.getByRole("button", { name: "停止理由を付ける" }).count()).toBe(0);
    });
  });

  it("幅 375 と暗いテーマ: 長い理由・決めてほしいこと・履歴が読め、はみ出さず、操作に届く", async () => {
    const page: Page = await s.open({ width: 375, height: 700, colorScheme: "dark" });
    await s.step(
      "375・暗いテーマ",
      async () => {
        await page.goto(`/requests/${ids.a}/board`);
        await until.visible(page.getByLabel("T001 は止まっています"));
        expect(await pageOverflow(page)).toEqual([]);
        await page.goto(`/requests/${ids.a}?task=T001`);
        await until.visible(page.getByRole("status", { name: "止まっています" }));
        expect(await pageOverflow(page)).toEqual([]);
        const unblock = page.getByRole("button", { name: "停止を解除" });
        expect(await reachable(unblock, "停止を解除")).toEqual([]);
        await unblock.focus();
        await page.keyboard.press("Enter");
        await until.visible(page.getByLabel(/回答・解決の内容/));
        expect(await pageOverflow(page)).toEqual([]);
        await page.goto("/?blocked=true");
        await until.visible(page.getByText(/停止中 \d+ 件/));
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
