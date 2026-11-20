// 準備の画面: 観測の一覧から準備の一覧へ → 登録（誤りは該当する項目に出る）→ 詳細 → 読み直しても同じ → CLI で同じ準備を読む →
// 編集で名前と確かめを直す（ほかの準備と同じ名前は断る）→ 一覧に今の版が出る。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("準備の登録と編集", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("画面で登録・編集し、CLI と同じ準備を読む", async () => {
    s = await openScenario("準備");
    const { page, step, env } = s;
    let id = "";
    await step("観測の一覧から準備の一覧へ移り、登録の画面を開く", async () => {
      await page.goto("/observer");
      await page.getByRole("link", { name: /^準備/ }).click();
      await until.url(page, /\/observer\/preparations$/);
      await until.visible(page.getByText("まだ準備がありません。"));
      await page.getByRole("link", { name: "＋ 新しい準備" }).click();
      await until.visible(page.getByRole("heading", { name: "準備を登録" }));
    });
    await step("名前が空・前処理の項目が足りないと、該当する項目に誤りが出る", async () => {
      await page.getByRole("button", { name: "＋ 前処理を書く" }).click();
      await page.getByRole("button", { name: "保存する" }).click();
      await until.text(page.getByRole("alert"), /name: 入力してください/);
      await until.text(page.getByRole("alert"), /setup\.run\.target: 入力してください/);
    });
    await step("名前・説明・占有と前処理（AI への指示）を入れて保存すると詳細へ移り、読み直しても同じ", async () => {
      await page.getByLabel("名前", { exact: true }).fill("注文が1件ある状態");
      await page.getByLabel("説明（任意）").fill("注文の一覧の観測の前に、注文を1件作る");
      await page.getByLabel("占有（任意。1行に1つ）").fill("db:orders\naccount:demo");
      const setup = page.getByRole("group", { name: "前処理" });
      await setup.getByLabel("対象").fill("http://localhost:4310/orders/new");
      await setup.getByLabel("順に行う操作（1行に1つ）").fill("実行ごとに一意な名前で注文を作る\n一覧に出るまで待つ");
      await setup.getByLabel("判定").fill("一覧に作った注文が出る");
      await setup.getByLabel("測定値の記録方法").fill("記録しない");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, /\/observer\/preparations\/prep-\d{6}-[0-9a-z]{5}$/);
      id = page.url().split("/").pop()!;
      for (const reload of [false, true]) {
        if (reload) await page.reload();
        await until.visible(page.getByRole("heading", { name: "注文が1件ある状態" }));
        await until.visible(page.getByText("db:orders・account:demo"));
        await until.visible(page.getByRole("article", { name: "前処理" }).getByText("実行ごとに一意な名前で注文を作る"));
      }
      expect(JSON.parse(await env.p3(["observer", "prep", "show", id, "--json"])).preparation).toMatchObject({
        rev: 1,
        name: "注文が1件ある状態",
        exclusive: ["db:orders", "account:demo"],
        setup: { run: { kind: "ai-instruction", target: "http://localhost:4310/orders/new", steps: ["実行ごとに一意な名前で注文を作る", "一覧に出るまで待つ"] } },
      });
    });
    await step("編集でほかの準備と同じ名前にすると名前の欄で断り、名前と確かめ（コマンド）を直して保存できる", async () => {
      await env.p3(["observer", "prep", "add", "--title", "別の準備"]);
      await page.getByRole("link", { name: "編集" }).click();
      await until.visible(page.getByRole("heading", { name: "準備を編集" }));
      await page.getByLabel("名前", { exact: true }).fill("別の準備");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.text(page.getByRole("alert"), /同じ名前の準備があります/);
      await page.getByLabel("名前", { exact: true }).fill("注文が1件ある");
      await page.getByRole("button", { name: "＋ 確かめを書く" }).click();
      const check = page.getByRole("group", { name: "確かめ" });
      await check.getByLabel("今の実行方法").selectOption("command");
      await check.getByLabel("実行名").fill("curl");
      await check.getByLabel("引数（1行に1つ）").fill("-sf\nhttp://localhost:4310/health");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, new RegExp(`/observer/preparations/${id}$`));
      await until.visible(page.getByRole("article", { name: "確かめ" }).getByText("curl -sf http://localhost:4310/health"));
      await page.getByRole("link", { name: "← 準備の一覧" }).click();
      const row = page.getByRole("row", { name: /注文が1件ある/ });
      await until.visible(row);
      expect(await row.innerText()).toMatch(/確かめ・前処理\s+db:orders・account:demo\s+v2/);
    });
    let obs = "";
    await step("観測の登録で使う準備を選ぶと、観測の詳細に準備へのリンク、準備の詳細に観測へのリンクが出て、準備は消せない", async () => {
      await page.goto("/observer/new");
      await page.getByLabel("タイトル").fill("注文の一覧");
      await page.getByLabel("観測内容").fill("注文の一覧が出るか");
      await page.getByRole("group", { name: "使う準備（任意）" }).getByLabel("注文が1件ある").check();
      await page.getByRole("button", { name: "保存して続ける" }).click();
      await until.url(page, /\/observer\/obs-\d{6}-[0-9a-z]{5}\/edit$/);
      obs = page.url().split("/").at(-2)!;
      await page.goto(`/observer/${obs}`);
      await page.getByRole("region", { name: "前提の観測と使う準備" }).getByRole("link", { name: "注文が1件ある" }).click();
      await until.url(page, new RegExp(`/observer/preparations/${id}$`));
      await until.visible(page.getByRole("region", { name: "この準備を使う観測" }).getByRole("link", { name: "注文の一覧" }));
      expect(await page.getByRole("button", { name: "消す" }).isDisabled()).toBe(true);
    });
    await step("前提の観測を選ぶと下書きに残り、読み直しても戻る。循環する前提は前提の欄に誤りが出て保存しない", async () => {
      const base = JSON.parse(await env.p3(["observer", "add", "--title", "サインイン", "--body", "サインインできる", "--json"])).id as string;
      await env.p3(["observer", "update", base, "--rev", "1", "--input", "-"], JSON.stringify({ title: "サインイン", description: "サインインできる", prerequisites: [obs] }));
      await page.goto(`/observer/${obs}/edit`);
      const pre = page.getByRole("group", { name: "前提の観測（任意）" });
      await pre.getByLabel("サインイン").check();
      await until.visible(page.getByText(/入力は保存されています（/));
      await page.reload();
      await until.visible(page.getByRole("group", { name: "前提の観測（任意）" }).getByLabel("サインイン"));
      expect(await page.getByRole("group", { name: "前提の観測（任意）" }).getByLabel("サインイン").isChecked()).toBe(true);
      await page.getByRole("button", { name: "保存する" }).click();
      await until.text(page.getByRole("group", { name: "前提の観測（任意）" }), /前提が循環します/);
      expect(JSON.parse(await env.p3(["observer", "show", obs, "--json"]))).not.toHaveProperty("prerequisites");
    });
  });
});
