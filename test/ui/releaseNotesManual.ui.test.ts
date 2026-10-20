// リリースノートの要約を生成できないとき（Codex のエンジンで ChatGPT に未接続）: 失敗の理由と再生成を残したまま、本文を手で書いて
// 保存・更新できることを確かめる。生成の失敗で入力を消さず、外で保存されたら入力を残して保存を止める。Docker も ChatGPT も使わない。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

async function prepare(env: UiEnv) {
  env.env.P3_PREFLIGHT_ENGINE = "codex";
  await env.p3(["milestone", "add", "v1", "--title", "最初のリリース"]);
  const id = (JSON.parse(await env.p3(["request", "new", "申請の検索", "--milestone", "v1", "--json"])) as { id: string }).id;
  await env.p3(["new", "検索の索引を作る", "--req", id]);
  await env.p3(["move", "T001", "done", "--req", id, "--record", "申請を題で検索できるようにした"]);
  await env.p3(["request", "set", id, "status=resolved"]);
}

describe.skipIf(!inject("chromium").available)("リリースノートを手で書く（生成できないとき）", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("リリースノートを手で書く", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("生成に失敗しても本文を手で書いて保存・更新でき、失敗と再生成で入力を消さない", async () => {
    const { page, step } = s;
    const body = page.locator("#rn-body");
    const save = page.getByRole("button", { name: "保存", exact: true });

    await step("生成の欄に、手で書いて保存できることが出る", async () => {
      await page.goto("/release-notes?m=v1");
      await until.visible(page.getByText(/生成せずに、本文を手で書いて保存することもできます/));
    });

    await step("入力してから生成すると失敗し、理由・再生成・手で書く案内が出て、入力は残る", async () => {
      await body.fill("## 最初のリリース\n\n- 申請を題で検索できる\n");
      await page.getByRole("button", { name: "機能の要約を生成" }).click();
      await until.visible(page.getByText(/生成できませんでした（Codex を使えません）/));
      await until.visible(page.getByRole("button", { name: "もう一度生成する" }));
      await until.value(body, "## 最初のリリース\n\n- 申請を題で検索できる\n");
      // もう一度失敗しても消えない
      await page.getByRole("button", { name: "もう一度生成する" }).click();
      await until.visible(page.getByText(/生成できませんでした（Codex を使えません）/));
      await until.value(body, "## 最初のリリース\n\n- 申請を題で検索できる\n");
      // 案内から本文へ進める
      await page.getByRole("button", { name: "本文を手で書く" }).click();
      expect(await body.evaluate((el) => el === document.activeElement)).toBe(true);
    });

    await step("生成によらず保存でき、CLI から見ても保存されている", async () => {
      await until.enabled(save);
      await save.click();
      await until.visible(page.getByRole("status").filter({ hasText: "保存しました" }));
      expect(await s.env.p3(["release-notes", "export", "v1"])).toBe("## 最初のリリース\n\n- 申請を題で検索できる\n");
    });

    await step("外で保存されたら、入力を残して保存を止める", async () => {
      const version = (JSON.parse(await s.env.p3(["release-notes", "show", "v1", "--json"])) as { note: { version: string } }).note.version;
      await s.env.p3(["release-notes", "save", "v1", "--body", "外で書いた", "--version", version]);
      await body.fill("## 最初のリリース\n\n- 画面で直した\n");
      // 画面が外の保存を取り込む前でも、保存は版の競合で止まる
      await save.click().catch(() => undefined);
      await until.visible(page.getByText(/別の操作でノートが保存されました/));
      await until.value(body, "## 最初のリリース\n\n- 画面で直した\n");
      expect(await s.env.p3(["release-notes", "export", "v1"])).toBe("外で書いた\n");
    });
  });
});
