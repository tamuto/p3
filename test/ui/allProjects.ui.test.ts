// プロジェクトを跨ぐ serve（p3 serve --all-projects）の画面: 一覧から選ぶ・切り替える・URL を直接開く・処理中に切り替える・
// 保存していない入力の確かめ・登録が変わったときの保存の拒否・開けないプロジェクト・狭い幅。Preflight は Mock（Docker は使わない）。
import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inViewport, pageOverflow } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const P3_BIN = fileURLToPath(new URL("../../bin/p3.mjs", import.meta.url));
const second = { repo: "", dataDir: "" };

/** 2つ目のプロジェクト（second）を別のリポジトリに作る。1つ目は uitest（makeUiEnv） */
async function prepare(env: UiEnv) {
  second.repo = join(env.root, "second");
  second.dataDir = join(second.repo, ".p3");
  await mkdir(second.repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: second.repo, env: env.env });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  await writeFile(join(second.repo, "README.md"), "# 2つ目\n");
  execFileSync("node", [P3_BIN, "init", "--yes", "--project", "second", "--description", "2つ目のプロジェクト"], { cwd: second.repo, env: env.env });
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

  it("スマホの幅（375）でも、今のプロジェクトと切り替えが画面に収まる", async () => {
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375 の幅で開く",
      async () => {
        await page.goto("/projects/uitest/");
        const switcher = page.getByLabel("プロジェクト", { exact: true });
        await until.value(switcher, "uitest");
        expect(await inViewport(page, switcher, "プロジェクトの切り替え")).toEqual([]);
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
