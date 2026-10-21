// マイルストーンの並び: 新しい要望と要望の管理情報の選ぶ欄・リリースノートの一覧・設定の一覧を ID のバージョンの降順で出す。
// 選んだ ID は保ち、表示だけでは project.yaml を書き換えない。リリースノートの「マイルストーン」タブは編集の間は行を動かさず、
// 保存した後に降順に並べ直す。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { request: "" };

async function prepare(env: UiEnv) {
  // 登録の順は降順ではない（桁の違う ID を混ぜる）
  for (const [id, title] of [
    ["v0.9", "九"],
    ["v0.2", "二"],
    ["v0.10", "十"],
    ["v0.1", "一"],
  ])
    await env.p3(["milestone", "add", id, "--title", title]);
  ids.request = (JSON.parse(await env.p3(["request", "new", "既存の要望", "--milestone", "v0.2", "--json"])) as { id: string }).id;
}

const optionValues = (select: Locator) => select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

describe.skipIf(!inject("chromium").available)("マイルストーンの並び（ID のバージョンの降順）", () => {
  let s: Scenario;
  let yaml = "";
  const projectYaml = () => readFileSync(join(s.env.repo, ".p3", "project.yaml"), "utf8");
  const milestoneOf = async (id: string) => (JSON.parse(await s.env.p3(["request", "show", id, "--json"])) as { item: { milestone?: string } }).item.milestone;
  beforeAll(async () => {
    s = await openScenario("マイルストーンの並び", { prepare });
    yaml = projectYaml();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("要望の選ぶ欄は降順で、「（なし）」が先頭。選んだ ID はそのまま保存する", async () => {
    const { page, step } = s;
    let created = "";
    await step("新しい要望", async () => {
      await page.goto("/requests/new");
      const select = page.getByLabel("マイルストーン（任意）");
      await until.count(select.locator("option"), 5);
      expect(await optionValues(select)).toEqual(["", "v0.10", "v0.9", "v0.2", "v0.1"]);
      await page.getByLabel("タイトル").fill("新しい要望");
      await select.selectOption("v0.9");
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.url(page, /\/requests\/\d{6}-[a-z0-9]{5}$/);
      created = new URL(page.url()).pathname.split("/").pop()!;
      expect(await milestoneOf(created)).toBe("v0.9");
    });
    await step("既存の要望の管理情報", async () => {
      await page.goto(`/requests/${ids.request}`);
      const select = page.locator("label").filter({ has: page.getByText("マイルストーン", { exact: true }) }).locator("select");
      await until.value(select, "v0.2");
      expect(await optionValues(select)).toEqual(["", "v0.10", "v0.9", "v0.2", "v0.1"]);
      await select.selectOption("v0.10");
      await until.value(select, "v0.10");
      await expect.poll(() => milestoneOf(ids.request)).toBe("v0.10");
    });
    // 表示と選ぶだけでは project.yaml は変わらない（要望の保存は要望のファイル）
    expect(projectYaml()).toBe(yaml);
  });

  it("リリースノートの一覧は降順で、指定が無ければ先頭を選ぶ。URL の指定は保つ", async () => {
    const { page, step } = s;
    const nav = page.getByRole("navigation", { name: "マイルストーン" });
    await step("指定なし", async () => {
      await page.goto("/release-notes");
      await until.count(nav.getByRole("link"), 4);
      const shown = await nav.getByRole("link").evaluateAll((ls) => ls.map((l) => new URL((l as HTMLAnchorElement).href).searchParams.get("m")));
      expect(shown).toEqual(["v0.10", "v0.9", "v0.2", "v0.1"]);
      await until.visible(nav.locator('[aria-current="page"]').filter({ hasText: "v0.10" }));
    });
    await step("URL で v0.2 を指定", async () => {
      await page.goto("/release-notes?m=v0.2");
      await until.visible(nav.locator('[aria-current="page"]').filter({ hasText: "v0.2" }));
      expect(await nav.locator('[aria-current="page"]').count()).toBe(1);
    });
    expect(projectYaml()).toBe(yaml);
  });

  it("マイルストーンのタブは降順で出し、編集の間は行を動かさず正しい行を変える・消す。保存すると降順に並べ直す（保存の順は登録の順のまま）", async () => {
    const { page, step } = s;
    const panel = page.getByRole("tabpanel", { name: "マイルストーン" });
    const idInputs = panel.getByPlaceholder("v0.2", { exact: true });
    const shownIds = () => idInputs.evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value));
    const row = (k: number) => idInputs.nth(k).locator("xpath=..");
    await step("開いたときは降順", async () => {
      await page.goto("/release-notes?tab=milestones");
      await until.count(idInputs, 4);
      expect(await shownIds()).toEqual(["v0.10", "v0.9", "v0.2", "v0.1"]);
      expect(projectYaml()).toBe(yaml);
    });
    await step("v0.2 の ID を書き換えても行は動かず、入力を続けられる", async () => {
      const input = idInputs.nth(2);
      await input.click();
      await input.press("End");
      await input.press("Backspace");
      await page.keyboard.type("11");
      expect(await shownIds()).toEqual(["v0.10", "v0.9", "v0.11", "v0.1"]);
      expect(await input.evaluate((el) => el === document.activeElement)).toBe(true);
      await row(2).getByPlaceholder("名前").fill("十一");
    });
    await step("v0.1 の行を消し、行を足す（足した行は最後）", async () => {
      await row(3).getByRole("button", { name: "削除" }).click();
      expect(await shownIds()).toEqual(["v0.10", "v0.9", "v0.11"]);
      await panel.getByRole("button", { name: "＋ マイルストーンを追加" }).click();
      expect(await shownIds()).toEqual(["v0.10", "v0.9", "v0.11", ""]);
      await idInputs.nth(3).fill("v1.0");
      await row(3).getByPlaceholder("名前").fill("一・〇");
      expect(await shownIds()).toEqual(["v0.10", "v0.9", "v0.11", "v1.0"]);
      // 保存するまで project.yaml は変わらない
      expect(projectYaml()).toBe(yaml);
    });
    await step("保存すると降順に並べ直す。保存した中身は正しい行のもの", async () => {
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel.getByText("保存しました"));
      await expect.poll(shownIds).toEqual(["v1.0", "v0.11", "v0.10", "v0.9"]);
      const ms = JSON.parse(await s.env.p3(["milestone", "--json"])) as { id: string; title: string }[];
      expect(ms.map((m) => [m.id, m.title])).toEqual([
        ["v1.0", "一・〇"],
        ["v0.11", "十一"],
        ["v0.10", "十"],
        ["v0.9", "九"],
      ]);
      // project.yaml は登録の順のまま（v0.2 を書き換えた場所に v0.11、消した v0.1 は無く、足した v1.0 は最後）
      const saved = projectYaml();
      const at = (id: string) => saved.indexOf(`id: ${id}\n`);
      expect([at("v0.9"), at("v0.11"), at("v0.10"), at("v1.0")].every((x, i, a) => x >= 0 && (i === 0 || a[i - 1] < x)), saved).toBe(true);
      expect(saved).not.toContain("id: v0.1\n");
    });
  });
});
