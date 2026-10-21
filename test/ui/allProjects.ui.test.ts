// プロジェクトを跨ぐ serve（p3 serve --all-projects）の画面: 一覧から選ぶ・切り替える・URL を直接開く・処理中に切り替える・
// 保存していない入力の確かめ・保存待ち・登録が変わったときの保存の拒否・開けないプロジェクト・ヘッダーの切り替えの欄（長い登録名・
// 1280 と 375・明暗）。Preflight は Mock（Docker は使わない）。
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, isDark, luminance, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { Page } from "playwright-core";
import type { UiEnv } from "./env.ts";

const P3_BIN = fileURLToPath(new URL("../../bin/p3.mjs", import.meta.url));
const second = { repo: "", dataDir: "" };
/** 長い登録名（ヘッダーの切り替えの欄の幅を確かめる） */
const LONG_NAME = "expense-receipts-upload-and-approval-history-for-month-end-closing";

/** 別のリポジトリにプロジェクトを作る。1つ目は uitest（makeUiEnv） */
async function makeProject(env: UiEnv, name: string, description: string) {
  const repo = join(env.root, name);
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: env.env });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  await writeFile(join(repo, "README.md"), `# ${description}\n`);
  execFileSync("node", [P3_BIN, "init", "--yes", "--project", name, "--description", description], { cwd: repo, env: env.env });
  return repo;
}

async function prepare(env: UiEnv) {
  second.repo = await makeProject(env, "second", "2つ目のプロジェクト");
  second.dataDir = join(second.repo, ".p3");
  await makeProject(env, LONG_NAME, "長い登録名のプロジェクト");
}

describe.skipIf(!inject("chromium").available)("プロジェクトを跨ぐ serve の画面", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("プロジェクトを跨ぐ", { prepare, serveArgs: ["--all-projects"] });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("一覧から選び、切り替え、URL を直接開け、処理中に切り替えても元のプロジェクトで続く", async () => {
    const { page, step } = s;
    const switcher = page.getByLabel("プロジェクト", { exact: true });
    let requestUrl = "";

    await step("入口は一覧で、1件目を勝手に開かない", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "uitest" }));
      await until.visible(page.getByRole("link", { name: "second" }));
      expect(new URL(page.url()).pathname).toBe("/");
    });

    await step("uitest を選び、要望を作る（行のどこを押しても開ける。どの画面でも今のプロジェクトが見える）", async () => {
      // 名前の文字ではなく、行の右端の余白を押す
      const row = page.getByRole("link", { name: "uitest" });
      const box = (await row.boundingBox())!;
      expect(box.width).toBeGreaterThan(300);
      await row.click({ position: { x: box.width - 40, y: box.height / 2 } });
      await until.url(page, /\/projects\/uitest\/$/);
      await until.value(switcher, "uitest");
      await page.getByRole("link", { name: /新しい要望/ }).first().click();
      await until.url(page, /\/projects\/uitest\/requests\/new$/);
      await until.value(switcher, "uitest");
      await page.getByLabel("タイトル").fill("uitest の要望");
      await page.getByLabel(/^内容/).fill("- 一つ目\n- 二つ目\n");
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.url(page, /\/projects\/uitest\/requests\/\d{6}-[a-z0-9]{5}$/);
      requestUrl = new URL(page.url()).pathname;
    });

    await step("Preflight を始めてすぐ second へ切り替える。second には uitest の要望が出ない", async () => {
      await page.getByRole("button", { name: "▶ Preflight を実行" }).click();
      await switcher.selectOption("second");
      await until.url(page, /\/projects\/second\/$/);
      await until.value(switcher, "second");
      await until.visible(page.getByText("未完了の要望はありません。"));
      expect(await page.getByText("uitest の要望").count()).toBe(0);
    });

    await step("uitest の要望の URL を直接開くと、Preflight は uitest で終わっている", async () => {
      await page.goto(requestUrl);
      await until.value(switcher, "uitest");
      await until.visible(page.getByText(/件のタスクに分割しました/).first(), 60_000);
      // 再読み込み・戻る
      await page.reload();
      await until.text(page.locator("main h1").first(), "uitest の要望");
      await page.goBack();
      await until.url(page, /\/projects\/second\/$/);
    });

    await step("CLI から見ても、それぞれのプロジェクトに分かれている", async () => {
      const ls = (args: string[]) => JSON.parse(execFileSync("node", [P3_BIN, ...args, "--json"], { cwd: s.env.repo, env: s.env.env, encoding: "utf8" })) as { request: { title: string } }[];
      expect(ls(["progress", "--project", "uitest"]).map((r) => r.request.title)).toContain("uitest の要望");
      expect(ls(["progress", "--project", "second"]).map((r) => r.request.title)).not.toContain("uitest の要望");
    });
  });

  it("保存していない入力があれば切り替える前に確かめ、残るか破棄するかを選べる", async () => {
    const { page, step } = s;
    const switcher = page.getByLabel("プロジェクト", { exact: true });
    const dialog = page.getByRole("dialog", { name: "保存していない入力があります" });

    await step("second の新しい要望に書きかけて、uitest へ切り替えようとする", async () => {
      await page.goto("/projects/second/requests/new");
      await page.getByLabel("タイトル").fill("書きかけ");
      await switcher.selectOption("uitest");
      await until.visible(dialog);
    });
    await step("「このプロジェクトに残る」で入力が残り、選択も戻る", async () => {
      await dialog.getByRole("button", { name: "このプロジェクトに残る" }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(new URL(page.url()).pathname).toBe("/projects/second/requests/new");
      await until.value(page.getByLabel("タイトル"), "書きかけ");
      await until.value(switcher, "second");
    });
    await step("「入力を破棄して切り替える」で切り替わる（送らない）", async () => {
      await switcher.selectOption("uitest");
      await dialog.getByRole("button", { name: "入力を破棄して切り替える" }).click();
      await until.url(page, /\/projects\/uitest\/$/);
      const titles = JSON.parse(execFileSync("node", [P3_BIN, "progress", "--project", "second", "--json"], { cwd: s.env.repo, env: s.env.env, encoding: "utf8" })) as { request: { title: string } }[];
      expect(titles.map((r) => r.request.title)).not.toContain("書きかけ");
    });
  });

  it("送っている保存があれば、保存待ちを（登録が変わった警告とは別に）出して選ぶ欄を止め、終わってから切り替える", async () => {
    const { page, step } = s;
    const switcher = page.getByLabel("プロジェクト", { exact: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await step("uitest で要望の作成を送り、サーバへの書き込みを止めておく", async () => {
      await page.route("**/api/projects/uitest/requests", async (route) => {
        if (route.request().method() === "POST") await held;
        await route.continue();
      });
      await page.goto("/projects/uitest/requests/new");
      await page.getByLabel("タイトル").fill("保存待ちの要望");
      await page.getByRole("button", { name: "作成", exact: true }).click();
    });
    await step("切り替えると、保存待ちの知らせが出て、選ぶ欄は押せない。警告は出ない", async () => {
      await switcher.selectOption("second");
      const dialog = page.getByRole("dialog", { name: "保存していない入力があります" });
      // 作成の画面は送るまで入力が残っているので、確かめが出たら破棄して進む（送った保存は待つ）
      if (await dialog.isVisible()) await dialog.getByRole("button", { name: "入力を破棄して切り替える" }).click();
      await until.visible(page.getByRole("status").filter({ hasText: "保存の完了を待っています" }));
      expect(await switcher.isDisabled()).toBe(true);
      expect(await page.getByRole("alert").filter({ hasText: "登録が変わりました" }).count()).toBe(0);
      expect(new URL(page.url()).pathname).toMatch(/^\/projects\/uitest\//);
    });
    await step("保存が終わると切り替わる（作成は uitest に残る）", async () => {
      release();
      await until.url(page, /\/projects\/second\/$/);
      await page.unroute("**/api/projects/uitest/requests");
      const titles = JSON.parse(execFileSync("node", [P3_BIN, "progress", "--project", "uitest", "--json"], { cwd: s.env.repo, env: s.env.env, encoding: "utf8" })) as { request: { title: string } }[];
      expect(titles.map((r) => r.request.title)).toContain("保存待ちの要望");
    });
  });

  it("開いている間にデータのフォルダが変わったら保存を断り、選び直しを案内する。登録に無いプロジェクトは一覧で理由を出す", async () => {
    const { page, step } = s;
    await step("second を開いてから、CLI でデータのフォルダを移して登録し直す", async () => {
      await page.goto("/projects/second/requests/new");
      await until.visible(page.getByLabel("タイトル"));
      const p3 = (...args: string[]) => execFileSync("node", [P3_BIN, ...args], { cwd: s.env.repo, env: s.env.env });
      const moved = join(s.env.root, "second-data");
      await rename(second.dataDir, moved);
      second.dataDir = moved;
      p3("project", "rm", "second");
      p3("project", "add", "second", moved);
      // サーバが一覧を読み直す（画面の選ぶ欄を開いたとき・入口と同じ）
      await fetch(`${s.serve.url}/api/projects`);
    });
    await step("古い画面からの作成は断られ、入力は残り、選び直しを案内する", async () => {
      await page.getByLabel("タイトル").fill("古い画面から");
      await page.getByRole("button", { name: "作成", exact: true }).click();
      await until.visible(page.getByRole("alert").filter({ hasText: "登録が変わりました" }));
      await until.value(page.getByLabel("タイトル"), "古い画面から");
      const titles = JSON.parse(execFileSync("node", [P3_BIN, "progress", "--project", "second", "--json"], { cwd: s.env.repo, env: s.env.env, encoding: "utf8" })) as { request: { title: string } }[];
      expect(titles.map((r) => r.request.title)).not.toContain("古い画面から");
    });
    await step("登録に無いプロジェクトの URL は、一覧で理由を出す", async () => {
      await page.goto("/projects/nope/");
      await until.visible(page.getByRole("alert").filter({ hasText: "「nope」を開けません" }));
      await until.visible(page.getByRole("link", { name: "uitest" }));
    });
  });

  for (const width of [1280, 375]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const theme = colorScheme === "dark" ? "暗い" : "明るい";
      it(`切り替えの欄はヘッダーのロゴの横にあり、長い登録名でも幅 ${width}・${theme}テーマで収まる`, async () => {
        const page = await s.open({ width, height: 700, colorScheme });
        const at = (what: string) => `幅 ${width}・${theme}・${what}`;
        for (const [what, path] of [
          ["進捗", "/"],
          ["新しい要望", "/requests/new"],
          ["設定", "/settings"],
        ] as const) {
          await s.step(
            at(what),
            async () => {
              await page.goto(`/projects/${LONG_NAME}${path}`);
              const header = page.getByRole("banner");
              const switcher = header.getByLabel("プロジェクト", { exact: true });
              await until.value(switcher, LONG_NAME);
              // 選ぶ欄はヘッダーの中に1つだけ。名前を別に出す帯・文字は無い
              expect(await page.getByLabel("プロジェクト", { exact: true }).count(), at("選ぶ欄の数")).toBe(1);
              const headerText = await header.evaluate((h) => {
                const c = h.cloneNode(true) as HTMLElement;
                c.querySelectorAll("select").forEach((e) => e.remove());
                return c.textContent ?? "";
              });
              expect(headerText, at("ヘッダーの名前の文字（選ぶ欄の外）")).not.toContain(LONG_NAME);
              await adjacentToLogo(page, switcher, at("ロゴとの並び"));
              expect(await isDark(page), at("テーマ")).toBe(colorScheme === "dark");
              expect(luminance(await switcher.evaluate((el) => getComputedStyle(el).backgroundColor)) < 0.3, at("選ぶ欄の背景")).toBe(colorScheme === "dark");
              expect(await pageOverflow(page), at("ページの横のはみ出し")).toEqual([]);
              for (const [name, l] of [
                ["切り替えの欄", switcher],
                ["再読み込み", header.getByRole("button", { name: /再読み込み|読み込み中/ })],
                ["新しい要望", header.getByRole("link", { name: /新しい要望/ })],
                ["ナビゲーション", header.locator("nav")],
              ] as const) {
                expect(await inViewport(page, l, name), at(name)).toEqual([]);
              }
            },
            page,
          );
        }
      });
    }
  }
});

/** 選ぶ欄がロゴのすぐ右（同じ行）にあること */
async function adjacentToLogo(page: Page, switcher: ReturnType<Page["locator"]>, where: string) {
  const logo = (await page.getByRole("banner").getByRole("img", { name: "infodb p3" }).boundingBox())!;
  const sel = (await switcher.boundingBox())!;
  const gap = sel.x - (logo.x + logo.width);
  expect(gap, `${where}: ロゴの右端から選ぶ欄までの間 ${gap}`).toBeGreaterThanOrEqual(0);
  expect(gap, `${where}: ロゴの右端から選ぶ欄までの間 ${gap}`).toBeLessThan(32);
  const overlap = Math.min(logo.y + logo.height, sel.y + sel.height) - Math.max(logo.y, sel.y);
  expect(overlap, `${where}: ロゴと選ぶ欄が同じ行にない`).toBeGreaterThan(0);
}

