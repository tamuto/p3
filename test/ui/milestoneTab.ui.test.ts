// リリースノートの「マイルストーン」タブ: 0 件からの追加・編集・削除・リリース済みの付け外しと保存、使用中・ノートありの ID の保護、
// タブの往復で両方の書きかけが残ること、外での変更の知らせ、設定（プロジェクトの基本）とマイルストーンが互いを巻き戻さないこと、
// 旧 URL（?m=）と不正な ?tab=、project.yaml に無いノート、幅 1280 / 375 での収まりを確かめる。Docker も ChatGPT も使わない。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";

interface Ms {
  id: string;
  title: string;
  due?: string;
  done?: boolean;
}

describe.skipIf(!inject("chromium").available)("リリースノートのマイルストーンのタブ", () => {
  let s: Scenario;
  const milestones = async () => JSON.parse(await s.env.p3(["milestone", "--json"])) as Ms[];
  const projectYaml = () => join(s.env.repo, ".p3", "project.yaml");
  const panel = (page: Page) => page.getByRole("tabpanel", { name: "マイルストーン" });
  const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
  const idInputs = (page: Page) => panel(page).getByLabel("ID", { exact: true });
  const shownIds = (page: Page) => idInputs(page).evaluateAll((is) => is.map((i) => (i as HTMLInputElement).value));
  /** 今その ID が出ている行（ID の入力の値で探す） */
  const row = async (page: Page, id: string) => {
    const i = (await shownIds(page)).indexOf(id);
    if (i < 0) throw new Error(`行がありません: ${id}`);
    return panel(page).getByRole("listitem").nth(i);
  };
  const reload = (page: Page) => page.getByRole("button", { name: "再読み込み" }).click();

  beforeAll(async () => {
    s = await openScenario("リリースノートのマイルストーンのタブ");
  });
  afterAll(async () => {
    await s?.close();
  });

  it("0 件のときはノートのタブから管理のタブへ進み、最初の 1 件を足して保存できる。旧 ?m= と不正な ?tab= はノートのタブ", async () => {
    const { page, step } = s;
    await step("0 件の案内から管理のタブへ", async () => {
      await page.goto("/release-notes?tab=bogus");
      expect(await tab(page, "リリースノート").getAttribute("aria-selected")).toBe("true");
      await page.getByRole("link", { name: "「マイルストーン」タブ" }).click();
      await until.url(page, /tab=milestones/);
      await until.visible(panel(page).getByText("マイルストーンがありません"));
    });
    await step("追加して保存する", async () => {
      await panel(page).getByRole("button", { name: "＋ マイルストーンを追加" }).click();
      // 足した行の ID に入力の位置が移る
      expect(await idInputs(page).first().evaluate((el) => el === document.activeElement)).toBe(true);
      await page.keyboard.type("v1");
      await panel(page).getByLabel("名前").fill("最初のリリース");
      await panel(page).getByLabel("期限").fill("2026-11-30");
      await until.visible(tab(page, "マイルストーン").getByText("●"));
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("status").filter({ hasText: "保存しました" }));
      expect(await milestones()).toEqual([{ id: "v1", title: "最初のリリース", due: "2026-11-30" }]);
      expect(await tab(page, "マイルストーン").getByText("●").count()).toBe(0);
    });
    await step("読み直しても残り、ノートのタブに出る。?m= で開け、タブを移っても選択を保つ", async () => {
      await page.goto("/release-notes?tab=milestones");
      await until.count(idInputs(page), 1);
      expect(await shownIds(page)).toEqual(["v1"]);
      await page.goto("/release-notes?m=v1");
      expect(await tab(page, "リリースノート").getAttribute("aria-selected")).toBe("true");
      const nav = page.getByRole("navigation", { name: "マイルストーン" });
      await until.visible(nav.locator('[aria-current="page"]').filter({ hasText: "v1" }));
      // キーボードでタブを移る（→ と ←）
      await tab(page, "リリースノート").focus();
      await page.keyboard.press("ArrowRight");
      await until.url(page, /tab=milestones/);
      expect(new URL(page.url()).searchParams.get("m")).toBe("v1");
      await page.keyboard.press("ArrowLeft");
      await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBeNull();
      expect(new URL(page.url()).searchParams.get("m")).toBe("v1");
    });
  });

  it("リリース済みの付け外しは保存で反映し、ノートの本文・要望を変えない。ノートの保存はリリース済みを変えない。タブを往復しても両方の入力が残る", async () => {
    const { page, step } = s;
    const rid = (JSON.parse(await s.env.p3(["request", "new", "検索", "--milestone", "v1", "--json"])) as { id: string }).id;
    const body = page.locator("#rn-body");
    await step("ノートを書いて保存する", async () => {
      await page.goto("/release-notes?m=v1");
      await body.fill("## 最初のリリース\n");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones())[0].done).toBeUndefined();
    });
    await step("ノートに書きかけ、管理のタブでリリース済みに付けて往復しても、両方の入力が残る", async () => {
      await body.fill("## 最初のリリース\n\n- 書きかけ\n");
      await tab(page, "マイルストーン").click();
      await (await row(page, "v1")).getByLabel("リリース済み").check();
      await until.visible(tab(page, "リリースノート").getByText("●"));
      await until.visible(tab(page, "マイルストーン").getByText("●"));
      await tab(page, "リリースノート").click();
      await until.value(body, "## 最初のリリース\n\n- 書きかけ\n");
      await tab(page, "マイルストーン").click();
      expect(await (await row(page, "v1")).getByLabel("リリース済み").isChecked()).toBe(true);
    });
    await step("保存するとリリース済みになり、ノート・要望は変わらず、書きかけのノートも残る", async () => {
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones())[0].done).toBe(true);
      expect(await s.env.p3(["release-notes", "export", "v1"])).toBe("## 最初のリリース\n");
      expect((JSON.parse(await s.env.p3(["request", "show", rid, "--json"])) as { item: { status: string; milestone: string } }).item).toMatchObject({ status: "draft", milestone: "v1" });
      await tab(page, "リリースノート").click();
      await until.value(body, "## 最初のリリース\n\n- 書きかけ\n");
      await until.visible(page.getByRole("navigation", { name: "マイルストーン" }).getByText(/リリース済み/));
    });
    await step("ノートを保存してもリリース済みは変わらない。外すのも保存で反映する", async () => {
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones())[0].done).toBe(true);
      await tab(page, "マイルストーン").click();
      await (await row(page, "v1")).getByLabel("リリース済み").uncheck();
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones())[0].done).toBeUndefined();
      expect(await s.env.p3(["release-notes", "export", "v1"])).toBe("## 最初のリリース\n\n- 書きかけ\n");
    });
  });

  it("要望・ノートのある ID は変えられず消せない（理由を出す）。保存の失敗では入力を残す。消した・変えた ID は保存で反映する", async () => {
    const { page, step } = s;
    await s.env.p3(["milestone", "add", "v2", "--title", "次"]);
    await s.env.p3(["milestone", "add", "v3", "--title", "その次"]);
    await s.env.p3(["milestone", "add", "v0", "--title", "ノートだけ"]);
    await s.env.p3(["release-notes", "save", "v0", "--body", "ノートだけのマイルストーン"]);
    const rid = (JSON.parse(await s.env.p3(["request", "new", "通知", "--milestone", "v2", "--json"])) as { id: string }).id;
    await step("要望・ノートのある行は ID が読み取り専用で、削除できず、理由が出る", async () => {
      await page.goto("/release-notes?tab=milestones");
      await until.count(idInputs(page), 4);
      expect(await shownIds(page)).toEqual(["v3", "v2", "v1", "v0"]);
      const v2 = await row(page, "v2");
      await until.visible(v2.getByText(/要望 1 件が使っているので/));
      expect(await v2.getByLabel("ID", { exact: true }).getAttribute("readonly")).not.toBeNull();
      expect(await v2.getByRole("button", { name: "削除" }).isDisabled()).toBe(true);
      const v0 = await row(page, "v0");
      await until.visible(v0.getByText(/リリースノートがあるので/));
      expect(await v0.getByLabel("ID", { exact: true }).getAttribute("readonly")).not.toBeNull();
      expect(await v0.getByRole("button", { name: "削除" }).isDisabled()).toBe(true);
      expect(await (await row(page, "v3")).getByRole("button", { name: "削除" }).isDisabled()).toBe(false);
    });
    await step("重複する ID・不正な日付は保存を拒まれ、入力が残る", async () => {
      await (await row(page, "v3")).getByLabel("ID", { exact: true }).fill("v2");
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("alert").filter({ hasText: /重複/ }));
      expect(await shownIds(page)).toEqual(["v2", "v2", "v1", "v0"]);
      await idInputs(page).first().fill("v4");
      await page.route("**/api/project", (route) =>
        // 日付の欄からは不正な値を入れられないので、送る本文の期限だけを差し替える
        route.request().method() === "PUT"
          ? route.continue({ postData: JSON.stringify({ milestones: (route.request().postDataJSON() as { milestones: Ms[] }).milestones.map((m, i) => (i ? m : { ...m, due: "2026/11/30" })) }) })
          : route.continue(),
      );
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("alert").filter({ hasText: /due/ }));
      await page.unroute("**/api/project");
      expect(await shownIds(page)).toEqual(["v4", "v2", "v1", "v0"]);
      expect((await milestones()).map((m) => m.id)).toEqual(["v3", "v2", "v1", "v0"]);
    });
    await step("使っている ID を外から外すと、サーバの規則で拒まれ理由が出る", async () => {
      // 画面の印より後に要望が付いた（画面は古い）: 消そうとするとサーバが止める
      await panel(page).getByRole("button", { name: "元に戻す" }).click();
      await (await row(page, "v3")).getByRole("button", { name: "削除" }).click();
      await s.env.p3(["request", "set", rid, "milestone=v3"]);
      await reload(page);
      // 読み直しても書きかけ（v3 を消した）は残る
      await until.visible(panel(page).getByText(/要望 1 件が使っているので/).first());
      expect(await shownIds(page)).toEqual(["v2", "v1", "v0"]);
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("alert").filter({ hasText: /使用中のマイルストーンは消せません: v3/ }));
      await s.env.p3(["request", "set", rid, "milestone=v2"]);
      await reload(page);
    });
    await step("使っていない行は消せる（保存で反映）", async () => {
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones()).map((m) => m.id)).toEqual(["v2", "v1", "v0"]);
    });
  });

  it("編集中に外で変わったら入力を残して知らせ、読み直せる。設定の基本とマイルストーンの保存は互いを巻き戻さない", async () => {
    const { page, step } = s;
    await step("編集中に CLI で足されると知らせ、入力は残る。読み直すと最新になる", async () => {
      await page.goto("/release-notes?tab=milestones");
      await until.count(idInputs(page), 3);
      await (await row(page, "v2")).getByLabel("名前").fill("書きかけの名前");
      await s.env.p3(["milestone", "add", "v5", "--title", "外で足した"]);
      await reload(page);
      await until.visible(panel(page).getByText(/編集中にマイルストーンが他で変わりました/));
      expect(await shownIds(page)).toEqual(["v2", "v1", "v0"]);
      await until.value((await row(page, "v2")).getByLabel("名前"), "書きかけの名前");
      await panel(page).getByRole("button", { name: "入力を捨てて最新を読み直す" }).click();
      await until.count(idInputs(page), 4);
      expect(await shownIds(page)).toEqual(["v5", "v2", "v1", "v0"]);
    });
    await step("設定の基本を編集中に外でマイルストーンが変わっても、基本の保存で巻き戻らない", async () => {
      await page.goto("/settings?tab=project");
      await page.getByLabel("プロジェクト名").fill("新しい名前");
      await s.env.p3(["milestone", "add", "v6", "--title", "外で足した2"]);
      await reload(page);
      // マイルストーンの変更は基本の「他で変わった」に数えない
      expect(await page.getByText(/編集中に設定が他で変わりました/).count()).toBe(0);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(page.getByText("保存しました"));
      expect((await milestones()).map((m) => m.id)).toContain("v6");
      expect(readFileSync(projectYaml(), "utf8")).toContain("name: 新しい名前");
    });
    await step("マイルストーンを編集中に外で基本が変わっても、マイルストーンの保存で巻き戻らない", async () => {
      await page.goto("/release-notes?tab=milestones");
      await until.count(idInputs(page), 5);
      await (await row(page, "v6")).getByLabel("名前").fill("直した名前");
      await s.env.p3(["config", "set", "name=外の名前"]);
      await reload(page);
      await panel(page).getByRole("button", { name: "保存", exact: true }).click();
      await until.visible(panel(page).getByRole("status").filter({ hasText: "保存しました" }));
      expect((await milestones()).find((m) => m.id === "v6")?.title).toBe("直した名前");
      expect(readFileSync(projectYaml(), "utf8")).toContain("name: 外の名前");
    });
  });

  it("project.yaml に無いノートは、管理のタブでは定義として出さずに知らせ、ノートのタブで読める", async () => {
    const { page, step } = s;
    await s.env.p3(["release-notes", "save", "v5", "--body", "孤立したノート"]);
    // project.yaml を直接編集して v5 を消す（ノートは残る）
    const yaml = readFileSync(projectYaml(), "utf8");
    writeFileSync(projectYaml(), yaml.replace(/ {2}- id: v5\n(?: {4}.*\n)*/, ""));
    await step("管理のタブ", async () => {
      await page.goto("/release-notes?tab=milestones");
      await reload(page);
      await until.visible(panel(page).getByText(/project\.yaml に無いマイルストーンのノート: v5/));
      expect(await shownIds(page)).not.toContain("v5");
    });
    await step("ノートのタブ", async () => {
      await page.goto("/release-notes?m=v5");
      await until.visible(page.getByText("⚠ project.yaml にありません"));
      await until.value(page.locator("#rn-body"), "孤立したノート");
    });
  });

  for (const width of [1280, 375]) {
    it(`幅 ${width} で、管理のタブの主な操作に届き、ページが横にはみ出さない`, async () => {
      const page = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await page.goto("/release-notes?tab=milestones");
          await until.count(idInputs(page), 4);
          // 理由の出る行（長い文が折り返す）も含めて測る
          expect(await pageOverflow(page)).toEqual([]);
          const first = panel(page).getByRole("listitem").first();
          await first.scrollIntoViewIfNeeded();
          for (const [l, what] of [
            [first.getByLabel("ID", { exact: true }), "ID"],
            [first.getByLabel("リリース済み"), "リリース済み"],
            [first.getByRole("button", { name: "削除" }), "削除"],
          ] as const)
            expect(await inViewport(page, l, what)).toEqual([]);
          const save = panel(page).getByRole("button", { name: "保存", exact: true });
          await save.scrollIntoViewIfNeeded();
          expect(await inViewport(page, save, "保存")).toEqual([]);
          expect(await inViewport(page, panel(page).getByRole("button", { name: "＋ マイルストーンを追加" }), "追加")).toEqual([]);
        },
        page,
      );
      await page.context().close();
    });
  }
});
