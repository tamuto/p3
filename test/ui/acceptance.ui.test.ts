// 受け入れ基準と証拠の画面: タスク案の基準の編集（保存していない間はタスク化を止める）→ タスク化で写る、タスクの追加での基準の入力、
// タスク詳細で基準と証拠を並べて確かめ・直し、不足があっても人が「済み」にできること、保存していない入力がある間は済みを止めること、
// 済みの後の変更で済みが外れて理由が出ること、取り直し・競合で入力を消さないこと、基準なしのタスク、アーカイブの閲覧、
// 幅 375 での長い証拠・パス・キーボードでの到達を確かめる。状態は CLI で用意する。
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_PATH = "src/web/components/expense/receipts/upload/ReceiptUploaderContainerWithAVeryLongName.tsx";
const ids = { tasks: "", drafts: "" };

async function prepare(env: UiEnv) {
  const j = async (args: string[], input?: string) => JSON.parse(await env.p3([...args, "--json"], input)) as { id: string };
  ids.tasks = (await j(["request", "new", "経費の申請を見直す", "--body", "-"], "申請の画面を見直す。\n")).id;
  const req = ["--req", ids.tasks];
  // T001: 基準つき。完了と同時に A1 満たした・A2 満たせなかった（A3 は証拠なし）
  await env.p3(["new", "申請の一覧を直す", ...req, "--criterion", "一覧に申請が出る", "--criterion", "差し戻しの理由を保存できる", "--criterion", "幅 375 で横にはみ出さない"]);
  await env.p3(
    ["move", "T001", "done", ...req, "--record", "記録", "--evidence-file", "-"],
    `## A1 met\n- \`pnpm -s check\` が通った\n- ${LONG_PATH}\n- https://example.com/${"long-path-segment/".repeat(8)}result\n\n## A2 unmet\nAPI の競合のケースが失敗した\n`,
  );
  // T002: 基準なし
  await env.p3(["new", "基準のないタスク", ...req]);
  // T003: 基準と証拠のあるタスクをアーカイブ
  await env.p3(["new", "捨てる案", ...req, "--criterion", "捨てる前の基準"]);
  await env.p3(["evidence", "T003", "A1", "unverified", "確かめていない", ...req]);
  await env.p3(["archive", "T003", ...req]);
  // 案のままの要望（Mock の案は基準つき）
  ids.drafts = (await j(["request", "new", "案の基準を直す", "--body", "-"], "- CSV を書き出す\n- 画面にボタンを置く\n")).id;
  await env.p3(["preflight", ids.drafts, "--engine", "mock"]);
}

describe.skipIf(!inject("chromium").available)("受け入れ基準と証拠", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("受け入れ基準", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タスク詳細: 基準と証拠を並べ、不足を済みの近くに出す。証拠を残し、保存していない間は済みを止め、済みの後の変更で済みが外れる", async () => {
    const { page, step, env } = s;
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }) });
    const check = page.getByRole("button", { name: "済みにする" });

    await step("不足の数と項目ごとの結果・証拠", async () => {
      await page.goto(`/requests/${ids.tasks}?task=T001`);
      await until.visible(page.getByText(/受け入れ基準: 未達 1 件・証拠なし 1 件/));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A1" }).getByText("満たした"));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A2" }).getByText("満たせなかった"));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A3" }).getByText("証拠なし"));
      await until.visible(panel.getByText(LONG_PATH));
      await until.enabled(check);
    });

    await step("証拠を編集している間は済みを止め、取消で戻る", async () => {
      await panel.getByRole("button", { name: "A3 の証拠を登録" }).click();
      await panel.getByLabel(/証拠（必須）/).fill("375 で確かめた");
      await until.disabled(check);
      await until.visible(page.getByText(/保存していない入力があります/));
      await panel.getByRole("button", { name: "取消" }).click();
      await until.enabled(check);
    });

    await step("証拠を保存すると不足が減る（満たしたは本文が要る）", async () => {
      await panel.getByRole("button", { name: "A3 の証拠を登録" }).click();
      await until.disabled(panel.getByRole("button", { name: "証拠を保存" }));
      await panel.getByLabel(/証拠（必須）/).fill("幅 375 で確かめた（test/ui/acceptance.ui.test.ts）");
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(page.getByText(/受け入れ基準: 未達 1 件。/));
      await until.visible(panel.getByText("幅 375 で確かめた（test/ui/acceptance.ui.test.ts）"));
    });

    await step("不足があっても済みにでき、基準を変えると済みが外れて理由が出る", async () => {
      await check.click();
      await until.visible(page.getByRole("button", { name: "済みを外す" }));
      await panel.getByRole("button", { name: "基準を編集" }).click();
      await panel.getByLabel("受け入れ基準 A2").fill("差し戻しの理由を保存して再読み込みしても残る");
      await panel.getByRole("button", { name: "基準を保存" }).click();
      await until.visible(page.getByText(/人の「済み」を外しました/));
      await until.visible(check);
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A2" }).getByText("再確認が必要"));
    });

    await step("外で変わったら入力を残して知らせ、最新に合わせて保存できる", async () => {
      await panel.getByRole("button", { name: "A2 の証拠を編集" }).click();
      const box = panel.getByLabel(/理由/);
      await box.fill("画面の入力");
      await env.p3(["evidence", "T001", "A1", "met", "外で直した証拠", "--req", ids.tasks]);
      await until.visible(panel.getByText(/編集中に他で更新されました/));
      await until.value(box, "画面の入力");
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(panel.getByRole("alert").filter({ hasText: /他で更新されました/ }));
      await until.value(box, "画面の入力");
      await panel.getByRole("button", { name: "最新に合わせる" }).click();
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(panel.getByText("画面の入力"));
      await until.visible(panel.getByText("外で直した証拠"));
    });

    await step("基準なしのタスクは「受け入れ基準なし」と従来の操作", async () => {
      await page.goto(`/requests/${ids.tasks}?task=T002`);
      await until.visible(panel.getByText("受け入れ基準なし"));
      await until.visible(panel.getByRole("button", { name: "基準を足す" }));
    });

    await step("アーカイブの詳細でも基準と証拠を読める", async () => {
      await page.goto(`/requests/${ids.tasks}/archive?archived=T003`);
      const dialog = page.getByRole("dialog", { name: /アーカイブしたタスク/ });
      await until.visible(dialog.getByText("捨てる前の基準"));
      await until.visible(dialog.getByText("確かめていない"));
      // 閲覧専用（証拠・基準の編集の操作は出さない）
      expect(await dialog.getByRole("button", { name: /証拠を|基準を/ }).count()).toBe(0);
    });
  });

  it("タスクの追加で基準を入れて作れる（キーボードで追加・並べ替え）", async () => {
    const { page, step, env } = s;
    await step("基準を2件入れて作る", async () => {
      await page.goto(`/requests/${ids.tasks}/board`);
      await page.getByRole("button", { name: "＋ タスクを追加" }).click();
      const dialog = page.getByRole("dialog", { name: /タスクを追加/ });
      await dialog.getByLabel("題").fill("基準つきで作る");
      await dialog.getByRole("button", { name: "項目を追加" }).click();
      await page.keyboard.type("後に足す基準");
      await dialog.getByRole("button", { name: "項目を追加" }).click();
      await page.keyboard.type("先に来る基準");
      await dialog.getByRole("button", { name: "新しい項目 2 を上へ" }).click();
      await dialog.getByRole("button", { name: "作成" }).click();
      await dialog.waitFor({ state: "hidden" });
    });
    const t = JSON.parse(await env.p3(["criteria", "T004", "--req", ids.tasks, "--json"])) as { criteria: { id: string; text: string }[] };
    expect(t.criteria).toEqual([
      { id: "A1", text: "先に来る基準" },
      { id: "A2", text: "後に足す基準" },
    ]);
  });

  it("案の詳細で基準を直し、保存していない間はタスク化を止め、タスク化で写る", async () => {
    const { page, step, env } = s;
    const detail = page.getByRole("dialog");
    const materialize = page.getByRole("button", { name: /件をタスク化/ });
    await step("案の詳細で基準を編集する（閉じても入力は残り、タスク化を止める）", async () => {
      await page.goto(`/requests/${ids.drafts}`);
      await until.visible(materialize);
      await page.getByRole("button", { name: "内容を見る" }).first().click();
      await detail.getByRole("button", { name: "基準を編集" }).click();
      await detail.getByRole("button", { name: "A1 を削除" }).click();
      await detail.getByRole("button", { name: "項目を追加" }).click();
      await page.keyboard.type("CSV の列の順が仕様どおり");
      await until.visible(detail.getByText(/保存していない変更があります/));
      await detail.getByRole("button", { name: "閉じる" }).click();
      await until.disabled(materialize);
      await until.visible(page.getByText(/保存していない受け入れ基準があります/));
    });
    await step("保存するとタスク化でき、基準が ID ごと写る", async () => {
      await page.getByRole("button", { name: "内容を見る" }).first().click();
      await detail.getByRole("button", { name: "基準を保存" }).click();
      await until.visible(detail.getByText("CSV の列の順が仕様どおり"));
      await detail.getByRole("button", { name: "閉じる" }).click();
      await until.enabled(materialize);
      await materialize.click();
      await until.visible(page.getByText(/をタスク化しました/));
    });
    const t = JSON.parse(await env.p3(["criteria", "T001", "--req", ids.drafts, "--json"])) as { criteria: { id: string; text: string }[] };
    expect(t.criteria.map((c) => c.id)).toEqual(["A2", "A3"]);
    expect(t.criteria[1].text).toBe("CSV の列の順が仕様どおり");
  });

  it("幅 375: 長い証拠・パス・リンクがはみ出さず、キーボードで証拠の編集と保存に届く", async () => {
    // 前のテストで変えた A1 に、長いパス・リンクの証拠を入れ直す
    await s.env.p3(["evidence", "T001", "A1", "met", "--body", "-", "--req", ids.tasks], `- ${LONG_PATH}\n- https://example.com/${"long-path-segment/".repeat(8)}result\n`);
    const page = await s.open({ width: 375, height: 700 });
    await s.step(
      "375 のタスク詳細",
      async () => {
        await page.goto(`/requests/${ids.tasks}?task=T001`);
        const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }) });
        await until.visible(panel.getByText(LONG_PATH));
        expect(await pageOverflow(page)).toEqual([]);
        expect(await reachable(panel.getByRole("button", { name: "A1 の証拠を編集" }), "A1 の証拠を編集")).toEqual([]);
        await panel.getByRole("button", { name: "A1 の証拠を編集" }).focus();
        await page.keyboard.press("Enter");
        await panel.getByLabel(/証拠（必須）/).press("End");
        await page.keyboard.type(" 追記");
        expect(await pageOverflow(page)).toEqual([]);
        expect(await reachable(panel.getByRole("button", { name: "証拠を保存" }), "証拠を保存")).toEqual([]);
        await panel.getByRole("button", { name: "取消" }).click();
        await page.goto(`/requests/${ids.drafts}`);
        await page.getByRole("button", { name: "内容を見る" }).first().click();
        expect(await pageOverflow(page)).toEqual([]);
      },
      page,
    );
  });
});
