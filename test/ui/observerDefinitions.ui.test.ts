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
    const newObservation = page.getByRole("banner").getByRole("link", { name: "新しい観測", exact: true });
    await step("進捗のツールバーの「新しい観測」（「新しい要望」の隣）から登録の画面が開く", async () => {
      await page.goto("/");
      const nav = page.getByRole("banner").getByRole("navigation");
      await until.visible(nav.getByRole("link", { name: "進捗" }));
      expect(await nav.getByRole("link").allInnerTexts()).toEqual(["進捗", "観測", "リリースノート", "開発の指標", "設定"]);
      // 二つの作成の操作は同じまとまりで隣り合う（要望 → 観測の順）
      const group = newObservation.locator("..");
      expect(await group.getByRole("link").allInnerTexts()).toEqual(["＋新しい要望", "＋新しい観測"]);
      await newObservation.click();
      await until.url(page, /\/observer\/new$/);
      await until.visible(page.getByRole("heading", { name: "観測を登録" }));
    });
    await step("ナビゲーションの「観測」の一覧には登録の操作が無く、見出しのすぐ下が状態の表示。ツールバーから登録の画面へ移る", async () => {
      await page.getByRole("banner").getByRole("navigation").getByRole("link", { name: "観測" }).click();
      await until.url(page, /\/observer$/);
      await until.visible(page.getByRole("banner").getByText("uitest"));
      const empty = page.getByText("まだ観測の定義がありません。");
      await until.visible(empty);
      expect(await page.getByRole("main").getByRole("link", { name: /観測を登録|新しい観測/ }).count()).toBe(0);
      // 見出しと状態の表示だけで、本文の上端から状態の表示までが詰まっている（以前の操作の段と余白は 80px 余り）
      const mainTop = (await page.getByRole("main").boundingBox())!.y;
      const heading = (await page.getByRole("heading", { name: "観測", exact: true }).boundingBox())!;
      const emptyTop = (await empty.boundingBox())!.y;
      expect(heading.y - mainTop).toBeLessThanOrEqual(16);
      expect(emptyTop - mainTop).toBeLessThanOrEqual(64);
      await newObservation.click();
      await until.url(page, /\/observer\/new$/);
    });
    await step("タイトル・観測内容が空なら該当する項目に誤りが出る。カテゴリは任意", async () => {
      await page.getByRole("button", { name: "保存して続ける" }).click();
      await until.text(page.getByRole("alert"), /観測の定義に誤りがあります/);
      await until.visible(page.getByText("入力してください").first());
      expect(await page.getByText("入力してください").count()).toBe(2);
    });
    await step("タイトルと観測内容だけで保存すると ID が付き、編集の画面へ移る", async () => {
      await page.getByLabel("タイトル").fill("一覧の応答時間");
      await page.getByLabel("観測内容").fill("要望の一覧が速く返るか");
      await page.getByLabel("期待する結果（任意）").fill("200ms 以内に一覧が返る");
      await page.getByRole("button", { name: "保存して続ける" }).click();
      await until.url(page, /\/observer\/obs-\d{6}-[0-9a-z]{5}\/edit$/);
      await until.value(page.getByLabel("期待する結果（任意）"), "200ms 以内に一覧が返る");
    });
    await step("編集の画面で測定項目・手順を入れる。入力は自動で保存され、読み直しても戻る", async () => {
      await page.getByLabel("カテゴリ").fill("性能");
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
      await p1.getByLabel("今の実行方法").selectOption("command");
      await p1.getByLabel("実行名").fill("curl");
      await p1.getByLabel("引数（1行に1つ）").fill("-s\nhttp://localhost:4310/api/requests");
      await p1.getByRole("checkbox", { name: "elapsed" }).check();
      await page.getByRole("button", { name: "＋ 手順を足す" }).click();
      const p2 = page.getByRole("group", { name: "手順 2", exact: true });
      await p2.getByLabel("今の実行方法").selectOption("test");
      await p2.getByLabel("手順の名前").fill("性能テスト");
      await p2.getByLabel("参照先", { exact: true }).fill("uitest");
      await p2.getByLabel("ファイル（参照先の中の相対パス）").fill("../outside.ts");
      await p2.getByRole("checkbox", { name: "ok" }).check();
      await page.getByRole("button", { name: "＋ 手順を足す" }).click();
      const p3 = page.getByRole("group", { name: "手順 3", exact: true });
      // スクリプトが無い手順は AI への指示（前提・対象・操作・判定・記録）と、置き換え候補（用意するスクリプト）
      await p3.getByLabel("手順の名前").fill("見た目");
      await p3.getByLabel("対象").fill("要望の一覧の画面");
      await p3.getByLabel("順に行う操作（1行に1つ）").fill("一覧を開く\n読み込み中の表示が残らないかを確かめる");
      await p3.getByLabel("判定").fill("読み込み中の表示が残らない");
      await p3.getByLabel("測定値の記録方法").fill("ok に結果を書く");
      await p3.getByRole("button", { name: "置き換え候補を書く" }).click();
      await p3.getByLabel("置き換え先の参照先").fill("repo");
      await p3.getByLabel("用意するファイル").fill("test/ui/list.ui.test.ts");
      await until.text(p3.getByText(/ファイル: 新規予定/), /新規予定（まだ無い）/);
      await p3.getByLabel("再現する操作").fill("一覧を開いて表示を待つ");
      await p3.getByLabel("測定値の出力形式").fill("ok を JSON で出す");
      await p3.getByLabel("結果を比べる条件").fill("2回とも同じ");
      await p3.getByLabel("切り替えの条件").fill("スクリプトで同じ判定が出たとき");
      await until.text(page.getByRole("status").filter({ hasText: "入力" }), /入力は保存されています/);
      await page.reload();
      await until.value(page.getByRole("group", { name: "手順 3", exact: true }).getByLabel("順に行う操作（1行に1つ）"), "一覧を開く\n読み込み中の表示が残らないかを確かめる");
      await until.value(page.getByRole("group", { name: "手順 3", exact: true }).getByLabel("切り替えの条件"), "スクリプトで同じ判定が出たとき");
      await until.value(page.getByRole("group", { name: "手順 2", exact: true }).getByLabel("ファイル（参照先の中の相対パス）"), "../outside.ts");
      await page.getByRole("button", { name: "保存する" }).click();
      // 参照先の外を指すパスは、その項目に誤りが出る
      await until.visible(p2.getByText("参照先の外を指す .. は使えません"));
      await p2.getByLabel("ファイル（参照先の中の相対パス）").fill("test/perf.test.ts");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, /\/observer\/obs-\d{6}-[0-9a-z]{5}$/);
      await until.visible(page.getByRole("heading", { name: "一覧の応答時間" }));
      await until.visible(page.getByRole("article", { name: "P1: curl で測る" }).getByText("elapsed（数値・ms）"));
      await until.visible(page.getByRole("article", { name: "P2: 性能テスト" }).getByText("uitest:test/perf.test.ts"));
      const p3view = page.getByRole("article", { name: "P3: 見た目" });
      await until.visible(p3view.getByRole("listitem").filter({ hasText: "読み込み中の表示が残らないかを確かめる" }));
      await until.visible(p3view.getByRole("region", { name: "P3: 見た目 の置き換え候補" }).getByText(/新規予定（まだ無い）/));
      expect(await p3view.getByRole("button", { name: "スクリプトに切り替える" }).isDisabled()).toBe(true);
    });
    const id = new URL(page.url()).pathname.split("/").pop()!;
    await step("CLI で同じ ID・版・項目を読める", async () => {
      const d = JSON.parse(await env.p3(["observer", "show", id, "--json"]));
      expect(d).toMatchObject({
        id,
        rev: 2,
        title: "一覧の応答時間",
        category: "性能",
        expected: "200ms 以内に一覧が返る",
        createdBy: "human:web",
        measures: [
          { name: "elapsed", type: "number", unit: "ms" },
          { name: "ok", type: "boolean" },
        ],
        procedures: [
          { id: "P1", run: { kind: "command", command: "curl", args: ["-s", "http://localhost:4310/api/requests"] }, measures: ["elapsed"] },
          { id: "P2", run: { kind: "test", repo: "uitest", path: "test/perf.test.ts" }, measures: ["ok"] },
          { id: "P3", run: { kind: "ai-instruction", target: "要望の一覧の画面", steps: ["一覧を開く", "読み込み中の表示が残らないかを確かめる"], judge: "読み込み中の表示が残らない", record: "ok に結果を書く" }, replacement: { kind: "ui-script", repo: "repo", path: "test/ui/list.ui.test.ts" } },
        ],
      });
    });
    await step("編集を開いたまま CLI で直すと、画面の保存は断られて入力が残る。読み直すと CLI の変更が見える", async () => {
      await page.getByRole("link", { name: "編集" }).click();
      await until.url(page, /\/edit$/);
      await until.value(page.getByLabel("タイトル"), "一覧の応答時間");
      await env.p3(["observer", "update", id, "--rev", "2", "--category", "速度"]);
      await page.getByLabel("タイトル").fill("画面で直した");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.text(page.getByRole("alert"), /今の版 3/);
      await until.value(page.getByLabel("タイトル"), "画面で直した");
      expect(JSON.parse(await env.p3(["observer", "show", id, "--json"]))).toMatchObject({ rev: 3, title: "一覧の応答時間", category: "速度" });
      await page.reload();
      await until.visible(page.getByText(/より古い版（v2）をもとにした編集途中の入力があります/));
      await until.value(page.getByLabel("カテゴリ"), "速度");
      await page.getByLabel("タイトル").fill("画面で直した");
      await page.getByRole("button", { name: "保存する" }).click();
      await until.url(page, new RegExp(`/observer/${id}$`));
      await until.visible(page.getByRole("heading", { name: "画面で直した" }));
      expect(JSON.parse(await env.p3(["observer", "show", id, "--json"]))).toMatchObject({ rev: 4, title: "画面で直した", category: "速度" });
    });
    await step("一覧に出る", async () => {
      await page.getByRole("link", { name: "← 観測の一覧" }).click();
      await until.visible(page.getByRole("link", { name: "画面で直した" }));
    });
  });
});
