// 完了時の条件と見直しが必要（候補）の画面: タスク詳細で完了と人の済みの記録を分けて読めること、当時と現在の理由、人の済みを変えないこと、
// 品質差分の明示の取り込みの注意、要望の概要・進捗（完了済みも含む絞り込み）・対応済みの一覧からの発見と詳細への移動、記録なしの文言、
// 更新の反映、幅 375 / 1280 ではみ出さないことを確かめる。状態は CLI で用意する。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_STD = `請求書の PDF に個人情報を出さない（${"氏名・住所・電話番号・メールアドレス・口座番号".repeat(3)}）`;
const LONG_REASON = `社内のセキュリティ基準 2026 年版で保存期間が変わった ${"https://example.com/".concat("very-long-path-segment/".repeat(6))}`;
const ids = { a: "", old: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  await env.p3(["quality", "add", "--text", LONG_STD, "--command", "pnpm test", "--success", "終了コード 0"]);
  // 済みにしたタスク（T001）と、完了だけのタスク（T002）。要望は完了済まで進める
  ids.a = (await j(["request", "new", "請求書の書き出し", "--body", "-"], "請求書を PDF で保存する\n")).id;
  await env.p3(["new", "PDF で保存する", "--req", ids.a, "--criterion", "請求書を PDF で保存できる"]);
  await env.p3(["new", "保存先を選ぶ", "--req", ids.a]);
  await env.p3(["move", "T001", "done", "--req", ids.a, "--evidence", "A1=met:保存のテストが通る"]);
  await env.p3(["check", "T001", "--req", ids.a]);
  await env.p3(["move", "T002", "done", "--req", ids.a]);
  await env.p3(["request", "set", ids.a, "status=resolved"]);
  await env.p3(["request", "set", ids.a, "status=done"]);
  // 完了した後に、品質基準を変え、前提の変更を記録する
  await env.p3(["quality", "set", "Q1", "--command", "pnpm test --coverage", "--success", "終了コード 0"]);
  await env.p3(["premise", ids.a, "add", "--target", "T001", "--reason", LONG_REASON, "--condition", "基準 2026 版"]);
  // 記録の無い古い完了（直接編集で完了にしたもの）
  ids.old = (await j(["request", "new", "古い要望"])).id;
  await env.p3(["new", "古い作業", "--req", ids.old, "--quality", "none"]);
  const file = join(env.repo, ".p3", "requests", ids.old, "tasks", "T001.md");
  await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", "status: done"));
}

describe.skipIf(!inject("chromium").available)("完了時の条件と見直し候補", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("完了時の条件と見直し候補", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タスク詳細: 当時と現在の理由を読め、人の済みは変わらない。完了時の条件は記録を選んで読める", async () => {
    const { page, step, env } = s;
    const review = page.getByRole("region", { name: "見直し", exact: true });
    await step("候補と理由（当時・現在）を、人の済みと別に出す", async () => {
      await page.goto(`/requests/${ids.a}?task=T001`);
      await until.visible(review.getByText("見直しが必要（候補） 2件"));
      await until.visible(review.getByText("品質基準が変わった"));
      await until.visible(review.getByText("前提の変更が記録された"));
      await until.visible(review.getByText(/pnpm test --coverage/));
      await until.visible(review.getByText(/今の実装が不適合だと判定したものではありません/));
      await until.visible(page.getByText(/人が確認済み（最終確認/));
    });
    await step("完了時の条件: 最新は人の済みの記録。選ぶと完了の記録も読める", async () => {
      const rec = page.getByRole("complementary").locator("details").filter({ hasText: "完了時の条件" });
      await rec.locator("summary").click();
      await until.visible(rec.getByText("C2 人の済み（人の最終確認。AI の承認ではありません）", { exact: true }));
      await rec.getByLabel("記録を選ぶ").selectOption("C1");
      await until.visible(rec.getByText("C1 タスクの完了", { exact: true }));
      await until.visible(rec.getByText(/当時の証拠: 満たした/));
    });
    await step("品質差分の明示の取り込みには、済みが外れる注意が出たまま", async () => {
      await until.visible(page.getByText(/済みの後なら済みが外れます/));
    });
    await step("表示しただけでは状態・済みは変わらない", async () => {
      const t = JSON.parse(await env.p3(["show", `${ids.a}/T001`, "--json"])) as { item: { status: string; checkedAt?: string; completionRecords: unknown[] } };
      expect(t.item.status).toBe("done");
      expect(t.item.checkedAt).toBeTruthy();
      expect(t.item.completionRecords).toHaveLength(2);
    });
  });

  it("要望の概要・進捗・対応済みの一覧から候補を見つけ、詳細へ進める（完了済みの要望も）", async () => {
    const { page, step } = s;
    await step("要望の概要: 自分のタスクの件数と、タスクを開く操作", async () => {
      await page.goto(`/requests/${ids.a}`);
      const notice = page.getByRole("region", { name: "要望の見直し" });
      await until.visible(notice.getByText("見直しが必要（候補）: 自分のタスク 2 件"));
      await notice.getByRole("button", { name: "当時と現在を見る" }).first().click();
      await until.visible(page.getByRole("region", { name: "見直し", exact: true }).getByText("品質基準が変わった"));
    });
    await step("進捗: 既定では完了済みを隠し、見直し候補のみで完了済みの要望も出す", async () => {
      await page.goto("/");
      await until.visible(page.getByText("古い要望").first());
      expect(await page.getByText("請求書の書き出し").count()).toBe(0);
      await page.getByLabel("見直し候補のみ").check();
      await until.visible(page.getByText("請求書の書き出し").first());
      await until.visible(page.getByText("見直し 2", { exact: true }));
      await until.visible(page.getByText("見直し候補 2 件・1 要望"));
    });
    await step("対応済みの一覧: 済みのタスクの印から詳細を開く", async () => {
      await page.goto(`/requests/${ids.a}/done`);
      await until.visible(page.getByText(/見直しが必要（候補）の済みのタスクが 1 件あります/));
      await page.getByRole("button", { name: "T001 の当時と現在の条件を見る" }).click();
      await until.visible(page.getByRole("region", { name: "見直し", exact: true }).getByText("前提の変更が記録された"));
    });
  });

  it("記録なしは候補なしと別の文言で出す", async () => {
    const { page, step } = s;
    await step("記録の無い古い完了", async () => {
      await page.goto(`/requests/${ids.old}?task=T001`);
      const review = page.getByRole("region", { name: "見直し", exact: true });
      await until.visible(review.getByText("記録なし", { exact: true }));
      await until.visible(review.getByText(/完了したときの条件の記録がありません/));
      expect(await page.getByText("見直しが必要（候補）").count()).toBe(0);
    });
  });

  it("幅 375 / 1280: 長い品質基準・理由・コミットではみ出さず、操作に届く", async () => {
    for (const width of [1280, 375]) {
      const p = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}`,
        async () => {
          await p.goto(`/requests/${ids.a}?task=T001`);
          await until.visible(p.getByRole("region", { name: "見直し", exact: true }).getByText("品質基準が変わった"));
          const rec = p.getByRole("complementary").locator("details").filter({ hasText: "完了時の条件" });
          await rec.locator("summary").click();
          await until.visible(rec.getByText(/取得/).first());
          expect(await pageOverflow(p)).toEqual([]);
          expect(await reachable(rec.getByLabel("記録を選ぶ"), "記録を選ぶ")).toEqual([]);
          await p.goto(`/requests/${ids.a}`);
          const btn = p.getByRole("region", { name: "要望の見直し" }).getByRole("button", { name: "当時と現在を見る" }).first();
          await until.visible(btn);
          expect(await reachable(btn, "当時と現在を見る")).toEqual([]);
          expect(await pageOverflow(p)).toEqual([]);
        },
        p,
      );
    }
  });

  it("更新の反映: 条件を戻すと候補の件数が変わる（再読み込みなしで）", async () => {
    const { page, step, env } = s;
    await step("品質基準を戻すと、品質の理由が消えて前提の変更だけになる", async () => {
      await page.goto(`/requests/${ids.a}?task=T001`);
      const review = page.getByRole("region", { name: "見直し", exact: true });
      await until.visible(review.getByText("見直しが必要（候補） 2件"));
      await env.p3(["quality", "set", "Q1", "--command", "pnpm test", "--success", "終了コード 0"]);
      await until.visible(review.getByText("見直しが必要（候補） 1件"));
      expect(await review.getByText("品質基準が変わった").count()).toBe(0);
    });
  });
});
