// 観測の手順の提案の画面（頼む先は Mock。参照先は Preflight と同じく読めるものを全部渡す）: 入力中の定義から提案を頼み、操作面・手順・根拠を確かめて編集欄に取り込み、直して保存する。
// 画面を示す材料では画面操作スクリプト、手がかりが無ければ足りない材料と理由。材料の不足は理由を出して入力を残す。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("観測の手順の提案", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("提案を頼み、取り込んで直して保存する。材料に応じた種別と、足りない材料を出す", async () => {
    s = await openScenario("観測の手順の提案");
    const { page, step, env } = s;
    const panel = page.getByRole("region", { name: "AI に手順を提案してもらう" });
    await step("タイトルと観測内容で保存すると、編集の画面に提案の欄があり、頼む先が出る。参照先は選ばせない", async () => {
      await page.goto("/observer/new");
      await page.getByLabel("タイトル").fill("一覧の応答時間");
      await page.getByLabel("観測内容").fill("速さを見る");
      await page.getByRole("button", { name: "保存して続ける" }).click();
      await until.url(page, /\/edit$/);
      await until.text(panel.getByTestId("suggest-engine"), /頼む先: mock/);
      expect(await panel.getByRole("checkbox").count()).toBe(0);
    });
    await step("材料が無いと理由を出し、入力は残す", async () => {
      await page.getByLabel("タイトル").fill("");
      await page.getByLabel("観測内容").fill("");
      await page.getByLabel("カテゴリ").fill("性能");
      await panel.getByRole("button", { name: "提案を頼む" }).click();
      await until.text(panel.getByRole("alert"), /タイトルか観測内容を入力してください/);
      await until.value(page.getByLabel("カテゴリ"), "性能");
    });
    await step("CLI を示す材料ではコマンドを提案し、根拠が出る。取り込むと手順の欄に入る", async () => {
      await page.getByLabel("タイトル").fill("一覧の応答時間");
      await page.getByLabel("観測内容").fill("p3 ls コマンドが速く返るか");
      await page.getByRole("button", { name: "＋ 測定項目を足す" }).click();
      await page.getByRole("group", { name: "測定項目 1" }).getByLabel("名前").fill("elapsed");
      await panel.getByLabel("補足（任意）").fill("pnpm の script を使う");
      await panel.getByRole("button", { name: "提案を頼む" }).click();
      const result = panel.getByTestId("suggestion");
      await until.visible(result.getByText("操作面: CLI・コマンド"));
      await until.visible(result.getByText(/根拠: Mock: 材料に CLI・コマンドの言葉がある/));
      const proposal = result.getByRole("article").first();
      await until.visible(proposal.getByText("pnpm -s test（repo:.）"));
      await proposal.getByRole("button", { name: "編集欄に取り込む" }).click();
      await until.visible(proposal.getByRole("button", { name: "取り込みました" }));
      const p1 = page.getByRole("group", { name: "手順 1", exact: true });
      await until.value(p1.getByLabel("実行名"), "pnpm");
      await until.value(p1.getByLabel("作業場所の参照先"), "repo");
      expect(await p1.getByRole("checkbox", { name: "elapsed" }).isChecked()).toBe(true);
      await p1.getByLabel("手順の名前").fill("ls の時間を測る");
    });
    await step("読み直しても、入力と最新の提案（観測に残したもの）が戻る", async () => {
      await until.text(page.getByRole("status").filter({ hasText: "入力" }), /入力は保存されています/);
      await page.reload();
      await until.value(page.getByRole("group", { name: "手順 1", exact: true }).getByLabel("手順の名前"), "ls の時間を測る");
      await until.visible(panel.getByTestId("suggestion").getByText("操作面: CLI・コマンド"));
    });
    await step("画面を示す材料では画面操作スクリプトを提案する", async () => {
      await page.getByLabel("観測内容").fill("要望の画面でボタンを押すと一覧が出るか");
      await panel.getByLabel("補足（任意）").fill("");
      await panel.getByRole("button", { name: "もう一度頼む" }).click();
      await until.visible(panel.getByTestId("suggestion").getByText("操作面: 画面"));
      await until.visible(panel.getByRole("article").first().getByText(/画面操作スクリプト/));
    });
    await step("手がかりが無ければ、足りない材料と理由を出す（手順は出さない）", async () => {
      await page.getByLabel("観測内容").fill("速さを見る");
      await page.getByLabel("タイトル").fill("速さ");
      await panel.getByRole("button", { name: "もう一度頼む" }).click();
      const missing = panel.getByTestId("suggestion-missing");
      await until.visible(missing);
      expect(await missing.innerText()).toContain("操作面（CLI・画面・API など）: 観測の対象が CLI・画面・API のどれか分かりません");
      expect(await panel.getByRole("article").count()).toBe(0);
    });
    await step("保存すると取り込んで直した手順が定義の検証を通って残る。提案の履歴も CLI で読める", async () => {
      await page.getByLabel("観測内容").fill("p3 ls コマンドが速く返るか");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, /\/observer\/obs-[^/]+$/);
      const id = new URL(page.url()).pathname.split("/").pop()!;
      expect(JSON.parse(await env.p3(["observer", "suggestions", id, "--json"])).suggestions.map((j: { status: string }) => j.status)).toEqual(["completed", "completed", "completed"]);
      const d = JSON.parse(await env.p3(["observer", "show", id, "--json"]));
      expect(d.procedures).toEqual([{ kind: "command", title: "ls の時間を測る", command: "pnpm", args: ["-s", "test"], repo: "repo", measures: ["elapsed"] }]);
    });
  });
});
