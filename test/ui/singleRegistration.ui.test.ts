// プロジェクトを跨ぐ serve で登録が1つだけのとき: 入口（/）は一覧を飛ばしてそのプロジェクトを開く。ヘッダーの「プロジェクトの一覧…」
// からは1つでも一覧を出す。一覧に戻ったら読み直し、途中で足した登録が出る。2つになれば入口は一覧を出す。
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";

const P3_BIN = fileURLToPath(new URL("../../bin/p3.mjs", import.meta.url));

describe.skipIf(!inject("chromium").available)("登録が1つのときのプロジェクトを跨ぐ serve", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("登録が1つ", { serveArgs: ["--all-projects"] });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("入口は一覧を飛ばして開き、一覧は求めれば出る。一覧に戻ると、途中で足した登録が出る", async () => {
    const { page, step } = s;
    const switcher = page.getByLabel("プロジェクト", { exact: true });

    await step("入口（/）は一覧を飛ばして、ただ1つのプロジェクトを開く", async () => {
      await page.goto("/");
      await until.url(page, /\/projects\/uitest\/$/);
      await until.value(switcher, "uitest");
    });

    await step("ヘッダーの「プロジェクトの一覧…」からは、1つでも一覧を出す", async () => {
      await switcher.selectOption({ label: "プロジェクトの一覧…" });
      await until.url(page, /\/\?list$/);
      await until.visible(page.getByRole("link", { name: "uitest" }));
    });

    await step("一覧から開いたあとで登録を足し、一覧に戻ると読み直して出る", async () => {
      await page.getByRole("link", { name: "uitest" }).click();
      await until.url(page, /\/projects\/uitest\/$/);
      const repo = join(s.env.root, "later");
      await mkdir(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: s.env.env });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, env: s.env.env });
      execFileSync("node", [P3_BIN, "init", "--yes", "--project", "later"], { cwd: repo, env: s.env.env });
      await page.goBack();
      await until.url(page, /\/\?list$/);
      await until.visible(page.getByRole("link", { name: "later" }));
    });

    await step("登録が2つになれば、入口（/）は一覧を出す", async () => {
      await page.goto("/");
      await until.visible(page.getByRole("link", { name: "later" }));
      expect(new URL(page.url()).pathname).toBe("/");
    });
  });
});
