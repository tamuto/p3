// 観測の定義の登録の画面: 登録（測定項目・4種の手順・測る項目）→ 共通の検証の誤りが該当する項目に出る → 保存して詳細 → CLI で同じ定義を読む →
// CLI で直したあとに古い版の編集を保存すると断られ、入力が残る。
import { afterEach, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

describe.skipIf(!inject("chromium").available)("観測の定義の登録", () => {
  let s: Scenario | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("画面で登録・編集し、CLI と同じ定義を読む。古い版の保存は断る", async () => {
    s = await openScenario("観測の定義");
    const { page, step, env } = s;
    await step("ナビゲーションの「観測」から一覧を開き、登録の画面へ移る。外枠（プロジェクト名）は tasks と同じ", async () => {
      await page.goto("/");
      const nav = page.getByRole("banner").getByRole("navigation");
      await until.visible(nav.getByRole("link", { name: "進捗" }));
      expect(await nav.getByRole("link").allInnerTexts()).toEqual(["進捗", "観測", "リリースノート", "開発の指標", "設定"]);
      await nav.getByRole("link", { name: "観測" }).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByRole("banner").getByText("uitest"));
      await until.visible(page.getByText("まだ観測の定義がありません。"));
      await page.getByRole("link", { name: "＋ 観測を登録" }).click();
      await until.url(page, /\/observer\/new$/);
    });
    await step("必須の項目が空・単位の誤り・定義に無い測定項目は、該当する項目に誤りが出て保存しない", async () => {
      await page.getByRole("button", { name: "登録する" }).click();
      const alert = page.getByRole("alert");
      await until.visible(alert);
      await until.text(alert, /title: 入力してください/);
      expect(await alert.innerText()).toContain("category: 入力してください");
      expect(await alert.innerText()).toContain("description: 入力してください");
    });
    await step("タイトル・カテゴリ・観測内容と、測定項目・手順を入れて登録する", async () => {
      await page.getByLabel("タイトル").fill("一覧の応答時間");
      await page.getByLabel("カテゴリ").fill("性能");
      await page.getByLabel("観測内容").fill("要望の一覧が速く返るか");
      await page.getByRole("button", { name: "＋ 測定項目を足す" }).click();
      await page.getByRole("button", { name: "＋ 測定項目を足す" }).click();
      const m1 = page.getByRole("group", { name: "測定項目 1" });
      await m1.getByLabel("名前").fill("elapsed");
      await m1.getByLabel("単位").fill("ms");
      const m2 = page.getByRole("group", { name: "測定項目 2" });
      await m2.getByLabel("名前").fill("ok");
      await m2.getByLabel("型").selectOption("boolean");
      await page.getByRole("button", { name: "＋ 手順を足す" }).click();
      const p1 = page.getByRole("group", { name: "手順 1", exact: true });
      await p1.getByLabel("手順の名前").fill("curl で測る");
      await p1.getByLabel("実行名").fill("curl");
      await p1.getByLabel("引数（1行に1つ）").fill("-s\nhttp://localhost:4310/api/requests");
      await p1.getByRole("checkbox", { name: "elapsed" }).check();
      await page.getByRole("button", { name: "＋ 手順を足す" }).click();
      const p2 = page.getByRole("group", { name: "手順 2", exact: true });
      await p2.getByLabel("種別").selectOption("test");
      await p2.getByLabel("手順の名前").fill("性能テスト");
      await p2.getByLabel("参照先", { exact: true }).fill("uitest");
      await p2.getByLabel("ファイル（参照先の中の相対パス）").fill("../outside.ts");
      await p2.getByRole("checkbox", { name: "ok" }).check();
      await page.getByRole("button", { name: "＋ 手順を足す" }).click();
      const p3 = page.getByRole("group", { name: "手順 3", exact: true });
      await p3.getByLabel("種別").selectOption("ai-instruction");
      await p3.getByLabel("手順の名前").fill("見た目");
      await p3.getByLabel("指示文").fill("一覧の読み込み中の表示が残らないかを確かめる");
      await page.getByRole("button", { name: "登録する" }).click();
      // 参照先の外を指すパスは、その項目に誤りが出る
      await until.visible(p2.getByText("参照先の外を指す .. は使えません"));
      await p2.getByLabel("ファイル（参照先の中の相対パス）").fill("test/perf.test.ts");
      await page.getByRole("button", { name: "登録する" }).click();
      await until.url(page, /\/observer\/obs-\d{6}-[0-9a-z]{5}$/);
      await until.visible(page.getByRole("heading", { name: "一覧の応答時間" }));
      await until.visible(page.getByRole("article", { name: "手順 1: curl で測る" }).getByText("測る項目: elapsed（数値・ms）"));
      await until.visible(page.getByRole("article", { name: "手順 2: 性能テスト" }).getByText("uitest:test/perf.test.ts"));
    });
    const id = new URL(page.url()).pathname.split("/").pop()!;
    await step("CLI で同じ ID・版・項目を読める", async () => {
      const d = JSON.parse(await env.p3(["observer", "show", id, "--json"]));
      expect(d).toMatchObject({
        id,
        rev: 1,
        title: "一覧の応答時間",
        category: "性能",
        createdBy: "human:web",
        measures: [
          { name: "elapsed", type: "number", unit: "ms" },
          { name: "ok", type: "boolean" },
        ],
        procedures: [
          { kind: "command", command: "curl", args: ["-s", "http://localhost:4310/api/requests"], measures: ["elapsed"] },
          { kind: "test", repo: "uitest", path: "test/perf.test.ts", measures: ["ok"] },
          { kind: "ai-instruction", body: "一覧の読み込み中の表示が残らないかを確かめる", measures: [] },
        ],
      });
    });
    await step("編集を開いたまま CLI で直すと、画面の保存は断られて入力が残る。読み直すと CLI の変更が見える", async () => {
      await page.getByRole("link", { name: "編集" }).click();
      await until.url(page, /\/edit$/);
      await until.value(page.getByLabel("タイトル"), "一覧の応答時間");
      await env.p3(["observer", "update", id, "--rev", "1", "--category", "速度"]);
      await page.getByLabel("タイトル").fill("画面で直した");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.text(page.getByRole("alert"), /今の版 2/);
      await until.value(page.getByLabel("タイトル"), "画面で直した");
      expect(JSON.parse(await env.p3(["observer", "show", id, "--json"]))).toMatchObject({ rev: 2, title: "一覧の応答時間", category: "速度" });
      await page.reload();
      await until.value(page.getByLabel("カテゴリ"), "速度");
      await page.getByLabel("タイトル").fill("画面で直した");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, new RegExp(`/observer/${id}$`));
      await until.visible(page.getByRole("heading", { name: "画面で直した" }));
      expect(JSON.parse(await env.p3(["observer", "show", id, "--json"]))).toMatchObject({ rev: 3, title: "画面で直した", category: "速度" });
    });
    await step("一覧に出る", async () => {
      await page.getByRole("link", { name: "← 観測の一覧" }).click();
      await until.visible(page.getByRole("link", { name: "画面で直した" }));
    });
  });
});
