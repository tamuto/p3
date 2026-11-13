// 設定の「品質基準」: 未設定の案内（続けられる・P3 はコマンドを実行しない）、基準の直接の追加（init なし）と複数の参照先・全参照先の保存と
// 再読み込み、テンプレートの中身を確かめて編集中の一覧へ足す、対象・確認の方法・除外の理由を直して保存、CLI で同じ基準が残ること、
// 保存済みの一覧（文が見出し・対象・確認の方法・適用・出典・ID の説明）、編集と保存で既存の ID が変わらないこと、意図して空の表示、
// 編集中に外で変わったら入力を残して保存させないこと、幅 375 / 1280・明暗ではみ出さず、キーボードで保存と取消に届くこと。
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { isDark, pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

type Standards = { quality: { state: string; config?: { standards: { id: string; text: string; repos?: string[]; check: { kind: string }; exempt?: { reason: string } }[]; templates?: unknown[] } } };
const read = async (env: UiEnv) => (JSON.parse(await env.p3(["quality", "--json"])) as Standards).quality;

describe.skipIf(!inject("chromium").available)("品質基準の設定", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質基準");
  });
  afterAll(async () => {
    await s?.close();
  });

  it("未設定の案内 → テンプレートを確かめて足す → 編集して保存 → CLI でも同じ。外で変わったら入力を残して保存させない", async () => {
    const { page, step, env } = s;
    const save = page.getByRole("button", { name: "品質基準を保存" });

    await step("未設定の案内とテンプレート", async () => {
      await page.goto("/settings?tab=quality");
      const intro = page.getByRole("status").filter({ hasText: "品質基準は未設定です" });
      await until.visible(intro);
      // 未設定のまま続けられること・P3 はコマンドを実行しないことが初めの案内にある
      await until.visible(intro.getByText(/未設定のまま作業を続けられます/));
      await until.visible(intro.getByText(/P3 は検査のコマンドを実行しません/));
      await until.visible(page.getByRole("button", { name: "空のまま設定する" }));
      await intro.getByRole("button", { name: "テンプレートを見る" }).click();
      await page.getByRole("button", { name: "採用する前に中身を確かめる" }).first().click();
      await until.visible(page.getByText("プロジェクトのコーディング規約（命名・書式・エラーの扱い）に従う"));
      await page.getByRole("button", { name: "編集中の一覧へ足す" }).click();
      await until.visible(page.getByText("保存していない変更があります"));
    });

    await step("対象・確認の方法・除外の理由を直して保存する", async () => {
      const second = page.getByRole("group", { name: "新しい基準 2", exact: true });
      await second.getByLabel(/確認の方法/).selectOption("machine");
      await second.getByLabel("コマンド").fill("pnpm lint");
      await second.getByLabel("成功の条件").fill("終了コード 0");
      await second.getByLabel(/適用から除外する/).check();
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: /除外の理由が空です/ }));
      await second.getByLabel("除外の理由").fill("小さい CLI なので層が無い");
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      const q = await read(env);
      expect(q.config!.standards).toHaveLength(4);
      expect(q.config!.standards[1]).toMatchObject({ id: "Q2", check: { kind: "machine" }, exempt: { reason: "小さい CLI なので層が無い" } });
      expect(q.config!.templates).toEqual([{ id: "basic", version: 1 }]);
    });

    await step("保存済みの一覧: 文が見出しで、対象・確認の方法・適用・出典を分け、ID の意味を示す", async () => {
      const list = page.getByRole("list", { name: "保存済みの品質基準" });
      const q2 = list.getByRole("listitem").nth(1);
      await until.visible(q2.getByRole("heading", { level: 4 }));
      expect(await q2.getByRole("heading", { level: 4 }).textContent()).toBe((await read(env)).config!.standards[1].text);
      for (const label of ["対象", "確認の方法", "適用", "出典"]) await until.visible(q2.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }));
      await until.visible(q2.getByRole("definition").filter({ hasText: "全参照先" }));
      await until.visible(q2.getByRole("definition").filter({ hasText: /pnpm lint/ }));
      await until.visible(q2.getByRole("definition").filter({ hasText: "除外（理由: 小さい CLI なので層が無い）" }));
      await until.visible(q2.getByRole("definition").filter({ hasText: /テンプレート .*（basic@1）/ }));
      await until.visible(q2.getByText(/ID: Q2/));
      await until.visible(page.getByText(/点数や順位ではありません/));
      // 版・採用したテンプレートは主な内容から分けて、開いたときに見る
      const tech = page.locator("details").filter({ hasText: "設定の版・テンプレートの採用状況" });
      await tech.getByText("設定の版・テンプレートの採用状況").click();
      await until.visible(tech.getByRole("definition").filter({ hasText: "共通の基本（basic@1）" }));
    });

    await step("編集中に外で変わったら入力を残して、保存させない", async () => {
      await page.getByRole("button", { name: "品質基準を編集" }).click();
      await page.getByLabel("Q1 の文", { exact: true }).fill("画面で直した規約");
      await env.p3(["quality", "rm", "Q4"]);
      await until.visible(page.getByText(/編集中に品質基準が他で変わりました/));
      await until.disabled(save);
      await until.value(page.getByLabel("Q1 の文", { exact: true }), "画面で直した規約");
      await page.getByRole("button", { name: "元に戻す" }).click();
      await until.visible(page.getByText(/保存済み: 3 件/));
    });
  });

  for (const [width, colorScheme] of [
    [375, "light"],
    [1280, "dark"],
  ] as const) {
    it(`幅 ${width}・${colorScheme === "dark" ? "暗い" : "明るい"}テーマ: 一覧・編集・テンプレートがはみ出さず、キーボードで保存と取消に届く`, async () => {
      const page: Page = await s.open({ width, height: 700, colorScheme });
      await s.step(
        `${width}`,
        async () => {
          await page.goto("/settings?tab=quality");
          const edit = page.getByRole("button", { name: "品質基準を編集" });
          await until.visible(edit);
          expect(await isDark(page)).toBe(colorScheme === "dark");
          expect(await pageOverflow(page)).toEqual([]);
          await edit.focus();
          await page.keyboard.press("Enter");
          const add = page.getByRole("button", { name: "基準を足す" });
          await until.visible(add);
          await add.focus();
          await page.keyboard.press("Enter");
          await page.getByRole("button", { name: "テンプレートを見る" }).click();
          await page.getByRole("button", { name: "採用する前に中身を確かめる" }).first().click();
          await until.visible(page.getByRole("button", { name: "編集中の一覧へ足す" }));
          expect(await pageOverflow(page)).toEqual([]);
          expect(await reachable(page.getByRole("button", { name: "品質基準を保存" }), "保存")).toEqual([]);
          // 取消（元に戻す）もキーボードで押せて、編集をやめる
          const cancel = page.getByRole("button", { name: "元に戻す" });
          expect(await reachable(cancel, "元に戻す")).toEqual([]);
          await cancel.focus();
          await page.keyboard.press("Enter");
          await until.visible(edit);
        },
        page,
      );
      await page.context().close();
    });
  }
});

describe.skipIf(!inject("chromium").available)("品質基準を未設定から直接足す", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("品質基準の直接の追加", {
      prepare: async (env) => {
        await env.p3(["repo", "add", "app"]);
        await env.p3(["repo", "add", "infra"]);
      },
    });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("init なしで基準を追加し、複数の参照先・全参照先で保存して再読み込みと CLI で読める。編集しても既存の ID は変わらない", async () => {
    const { page, step, env } = s;
    const save = page.getByRole("button", { name: "品質基準を保存" });

    await step("未設定から「基準を追加」で、2つの参照先を選んで保存する", async () => {
      await page.goto("/settings?tab=quality");
      await page.getByRole("status").filter({ hasText: "品質基準は未設定です" }).getByRole("button", { name: "基準を追加" }).click();
      const row = page.getByRole("group", { name: "新しい基準 1", exact: true });
      await row.getByLabel("新しい基準 1 の文").fill("API の変更は利用者向けの文書も直す");
      await row.getByLabel("確かめ方・参照の資料").fill("docs/how-to-use.md と照らす");
      await row.getByLabel(/参照先を選ぶ/).check();
      // 個別に選ぶなら1つ以上（選ばずに保存すると断る）
      await save.click();
      await until.visible(page.getByRole("alert").filter({ hasText: /1つ以上選んでください/ }));
      const repos = row.getByRole("group", { name: "新しい基準 1 の対象の参照先" });
      await repos.getByLabel("app", { exact: true }).check();
      await repos.getByLabel("infra", { exact: true }).check();
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      const q = await read(env);
      expect(q.state).toBe("set");
      expect(q.config!.standards).toEqual([expect.objectContaining({ id: "Q1", text: "API の変更は利用者向けの文書も直す", repos: ["app", "infra"] })]);
    });

    await step("再読み込みしても対象が残り、CLI で足した基準と一緒に並ぶ", async () => {
      await env.p3(["quality", "add", "--text", "lint を通す", "--command", "pnpm lint", "--success", "終了コード 0"]);
      await page.reload();
      const list = page.getByRole("list", { name: "保存済みの品質基準" });
      await until.count(list.getByRole("listitem"), 2);
      await until.visible(list.getByRole("listitem").nth(0).getByRole("definition").filter({ hasText: "app、infra" }));
      await until.visible(list.getByRole("listitem").nth(1).getByRole("definition").filter({ hasText: "全参照先" }));
      await until.visible(list.getByRole("listitem").nth(1).getByRole("definition").filter({ hasText: "独自に追加した基準" }));
    });

    await step("編集で Q1 を全参照先に戻し、Q2 を消して新しい基準を足しても、Q1 の ID は変わらず番号は使い直さない", async () => {
      await page.getByRole("button", { name: "品質基準を編集" }).click();
      const q1 = page.getByRole("group", { name: "Q1", exact: true });
      await until.visible(q1.getByText(/保存しても変わりません/));
      await q1.getByLabel("全参照先").check();
      await page.getByRole("group", { name: "Q2", exact: true }).getByRole("button", { name: "この基準を消す" }).click();
      await page.getByRole("button", { name: "基準を足す" }).click();
      const added = page.getByRole("group", { name: "新しい基準 2", exact: true });
      await added.getByLabel("新しい基準 2 の文").fill("画面の文言は用語集に従う");
      await added.getByLabel("確かめ方・参照の資料").fill("docs/glossary.md");
      await save.click();
      await until.visible(page.getByText("品質基準を保存しました"));
      const q = await read(env);
      expect(q.config!.standards.map((x) => [x.id, x.repos ?? null])).toEqual([
        ["Q1", null],
        ["Q3", null],
      ]);
    });
  });
});
