// 受け入れ基準と証拠の画面: タスク案の基準の編集（保存していない間はタスク化を止める）→ タスク化で写る、タスクの追加での基準の入力、
// タスク詳細で基準と証拠を並べて確かめ・直し、不足を完了の近くに出すこと、基準を変えると証拠が再確認になること、
// 取り直し・競合で入力を消さないこと、基準なしのタスク、アーカイブの閲覧、幅 375 での長い証拠・パス・キーボードでの到達を確かめる。
// 根拠の種類（結果と別のラベル・古い証拠の種類未記録・画面からの入力・進捗の申告のみの印・競合で入力を残すこと・幅 375 / 1280）も
// 確かめる。状態は CLI で用意する。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pageOverflow, reachable } from "./layout.ts";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const LONG_PATH = "src/web/components/expense/receipts/upload/ReceiptUploaderContainerWithAVeryLongName.tsx";
const ids = { tasks: "", drafts: "", basis: "" };
const MACHINE = { kind: "machine", command: "pnpm vitest run test/receipts.test.ts", result: "終了コード 0（12 件成功）", target: "app:3f2a1c0" };

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
  // 根拠: T001 は検査結果あり・申告のみ・読んで確認・未確認、T002 は根拠を記録する前の古い証拠（ファイルから basis を外す）
  ids.basis = (await j(["request", "new", "領収書の根拠を確かめる", "--body", "-"], "根拠の種類を見分ける。\n")).id;
  const rb = ["--req", ids.basis];
  await env.p3(["new", "領収書を添付する", ...rb, "--criterion", "画像を添付できる", "--criterion", "PDF を添付できる", "--criterion", "添付の上限を案内する", "--criterion", "古い端末で確かめる"]);
  await env.p3(
    ["move", "T001", "done", ...rb, "--record", "記録", "--evidence-json", "-"],
    JSON.stringify([
      { id: "A1", result: "met", evidence: "添付のテストが通った", basis: MACHINE },
      { id: "A2", result: "met", evidence: "PDF も添付できた" },
      { id: "A3", result: "met", evidence: "案内の文を確かめた", basis: { kind: "read", reference: "src/Receipt.tsx の案内の文" } },
      { id: "A4", result: "unverified", evidence: "古い端末が無い" },
    ]),
  );
  await env.p3(["new", "古い証拠のタスク", ...rb, "--criterion", "前からある基準"]);
  await env.p3(["move", "T002", "done", ...rb, "--record", "記録", "--evidence", "A1=met:前に確かめた"]);
  const file = join(env.repo, ".p3", "requests", ids.basis, "tasks", "T002.md");
  const src = await readFile(file, "utf8");
  const legacy = src.replace(/\n\s+basis:\n\s+kind: declaration/, "");
  if (legacy === src) throw new Error("古い証拠を作れません（basis の行が見つからない）");
  await writeFile(file, legacy);
}

describe.skipIf(!inject("chromium").available)("受け入れ基準と証拠", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("受け入れ基準", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("タスク詳細: 基準と証拠を並べ、不足を完了の近くに出す。証拠を残し、基準を変えると証拠が再確認になる", async () => {
    const { page, step, env } = s;
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }) });

    await step("不足の数と項目ごとの結果・証拠", async () => {
      await page.goto(`/requests/${ids.tasks}?task=T001`);
      await until.visible(page.getByText(/受け入れ基準: .*未達 1 件・証拠なし 1 件/));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A1" }).getByText("満たした", { exact: true }));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A2" }).getByText("満たせなかった"));
      await until.visible(panel.getByRole("listitem", { name: "受け入れ基準 A3" }).getByText("証拠なし"));
      await until.visible(panel.getByText(LONG_PATH));
      await until.visible(page.getByText(/人の最終確認は要望を完了済にして行います/));
    });

    await step("証拠の入力を取消で捨てる", async () => {
      await panel.getByRole("button", { name: "A3 の証拠を登録" }).click();
      await panel.getByLabel(/証拠（必須）/).fill("375 で確かめた");
      await panel.getByRole("button", { name: "取消" }).click();
      await until.visible(panel.getByRole("button", { name: "A3 の証拠を登録" }));
    });

    await step("証拠を保存すると不足が減る（満たしたは本文が要る）", async () => {
      await panel.getByRole("button", { name: "A3 の証拠を登録" }).click();
      await until.disabled(panel.getByRole("button", { name: "証拠を保存" }));
      await panel.getByLabel(/証拠（必須）/).fill("幅 375 で確かめた（test/ui/acceptance.ui.test.ts）");
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(page.getByText(/受け入れ基準: .*未達 1 件・申告のみの達成 2 件/));
      await until.visible(panel.getByText("幅 375 で確かめた（test/ui/acceptance.ui.test.ts）"));
    });

    await step("基準を変えると、その基準の証拠は再確認が必要になる", async () => {
      await panel.getByRole("button", { name: "基準を編集" }).click();
      await panel.getByLabel("受け入れ基準 A2").fill("差し戻しの理由を保存して再読み込みしても残る");
      await panel.getByRole("button", { name: "基準を保存" }).click();
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
      await until.visible(dialog.getByText("確かめていない", { exact: true }));
      // 根拠も読める（未検証の証拠は未確認）
      await until.visible(dialog.getByText("未確認", { exact: true }));
      // 閲覧専用（証拠・基準の編集の操作は出さない）
      expect(await dialog.getByRole("button", { name: /証拠を|基準を/ }).count()).toBe(0);
    });
  });

  it("根拠: 進捗に申告のみのタスク数を出し、詳細で結果と根拠を分けて読み、画面から根拠を入れる", async () => {
    const { page, step, env } = s;
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }) });
    const item = (id: string) => panel.getByRole("listitem", { name: `受け入れ基準 ${id}` });
    const showJson = async (t: string) => JSON.parse(await env.p3(["show", t, "--req", ids.basis, "--json"])) as { item: { acceptanceEvidence: { criterionId: string; basis?: Record<string, string> }[] } };

    await step("進捗の行に申告のみのタスク数、印から（キーボードで）タスクの詳細へ", async () => {
      await page.goto("/");
      const schedule = page.getByTestId("schedule");
      const row = schedule.getByRole("link").filter({ hasText: "領収書の根拠を確かめる" });
      await until.visible(row.getByText("申告のみ 2"));
      // 同じ日に完了した T001・T002 は1つの印にまとまる（一覧から選ぶ）
      const mark = page.getByRole("button", { name: /^T001 申告のみ 1、T002 申告のみ 1$/ });
      await mark.focus();
      await page.keyboard.press("Enter");
      const pick = page.getByRole("button", { name: /T001.*領収書を添付する.*申告のみ 1/ });
      await until.visible(pick);
      await pick.focus();
      await page.keyboard.press("Enter");
      await until.visible(panel.getByText(/満たしたと申告 3\/4、うち申告のみ 1（読んで確認 1・検査結果あり 1）/));
    });

    await step("結果と根拠は別のラベル。検査の項目・読んだもの", async () => {
      await page.goto(`/requests/${ids.basis}?task=T001`);
      await until.visible(item("A1").getByText("検査結果あり", { exact: true }));
      await until.visible(item("A1").getByText("結果", { exact: true }));
      await until.visible(item("A1").getByText("根拠", { exact: true }));
      await until.visible(item("A1").getByText(MACHINE.command));
      await until.visible(item("A1").getByText(MACHINE.target));
      await until.visible(item("A2").getByText("申告のみ", { exact: true }));
      await until.visible(item("A3").getByText("src/Receipt.tsx の案内の文"));
      await until.visible(item("A4").getByText("未確認", { exact: true }));
    });

    await step("古い証拠は「申告のみ（種類未記録）」", async () => {
      await page.goto(`/requests/${ids.basis}?task=T002`);
      await until.visible(item("A1").getByText("申告のみ（種類未記録）"));
      await until.visible(item("A1").getByText(/根拠の種類を記録する前の証拠です/));
    });

    await step("画面から検査結果ありを入れる（欄がそろうまで保存できない）。再読み込みと CLI で同じ値", async () => {
      await page.goto(`/requests/${ids.basis}?task=T001`);
      await panel.getByRole("button", { name: "A2 の証拠を編集" }).click();
      await panel.getByLabel(/根拠の種類/).selectOption({ label: "検査結果あり" });
      const save = panel.getByRole("button", { name: "証拠を保存" });
      await until.disabled(save);
      await until.visible(panel.getByText("検査のコマンド・結果・対象を書いてください"));
      await panel.getByLabel(/検査のコマンド/).fill("pnpm vitest run test/pdf.test.ts");
      await panel.getByLabel(/検査の結果（必須）/).fill("終了コード 0");
      await panel.getByLabel(/対象（必須）/).fill("app:9c1d2e3");
      await save.click();
      await until.visible(item("A2").getByText("pnpm vitest run test/pdf.test.ts"));
      await page.reload();
      await until.visible(item("A2").getByText("検査結果あり", { exact: true }));
      const t = await showJson("T001");
      expect(t.item.acceptanceEvidence.find((e) => e.criterionId === "A2")!.basis).toEqual({ kind: "machine", command: "pnpm vitest run test/pdf.test.ts", result: "終了コード 0", target: "app:9c1d2e3" });
      await until.visible(panel.getByText(/満たしたと申告 3\/4、うち申告のみ 0（読んで確認 1・検査結果あり 2）/));
    });

    await step("本文だけ直しても根拠は変わらない。読んで確認の参照先を入れられる", async () => {
      await panel.getByRole("button", { name: "A3 の証拠を編集" }).click();
      await until.value(panel.getByLabel(/読んだもの/), "src/Receipt.tsx の案内の文");
      await panel.getByLabel(/証拠（必須）/).fill("案内の文と上限の数を確かめた");
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(item("A3").getByText("案内の文と上限の数を確かめた"));
      const t = await showJson("T001");
      expect(t.item.acceptanceEvidence.find((e) => e.criterionId === "A3")!.basis).toEqual({ kind: "read", reference: "src/Receipt.tsx の案内の文" });
    });

    await step("根拠の種類を変えて保存できる", async () => {
      await panel.getByRole("button", { name: "A1 の証拠を編集" }).click();
      await panel.getByLabel(/根拠の種類/).selectOption({ label: "読んで確認" });
      await panel.getByLabel(/読んだもの/).fill("src/upload.ts の添付の処理");
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(item("A1").getByText("src/upload.ts の添付の処理"));
      expect((await showJson("T001")).item.acceptanceEvidence.find((e) => e.criterionId === "A1")!.basis).toEqual({ kind: "read", reference: "src/upload.ts の添付の処理" });
    });

    await step("競合しても根拠の入力を残し、最新に合わせて保存できる", async () => {
      await panel.getByRole("button", { name: "A4 の証拠を編集" }).click();
      await panel.getByLabel("作業した側の結果").selectOption({ label: "満たした" });
      await until.value(panel.getByLabel(/根拠の種類/), "declaration");
      await panel.getByLabel(/根拠の種類/).selectOption({ label: "検査結果あり" });
      await panel.getByLabel(/証拠（必須）/).fill("古い端末のエミュレータで確かめた");
      await panel.getByLabel(/検査のコマンド/).fill("pnpm test:legacy");
      await panel.getByLabel(/検査の結果（必須）/).fill("終了コード 0");
      await panel.getByLabel(/対象（必須）/).fill("app:未コミット");
      await env.p3(["evidence", "T001", "A3", "met", "外で直した", "--req", ids.basis]);
      await until.visible(panel.getByText(/編集中に他で更新されました/));
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(panel.getByRole("alert").filter({ hasText: /他で更新されました/ }));
      await until.value(panel.getByLabel(/検査のコマンド/), "pnpm test:legacy");
      await until.value(panel.getByLabel(/対象（必須）/), "app:未コミット");
      await panel.getByRole("button", { name: "最新に合わせる" }).click();
      await panel.getByRole("button", { name: "証拠を保存" }).click();
      await until.visible(item("A4").getByText("pnpm test:legacy"));
      expect((await showJson("T001")).item.acceptanceEvidence.find((e) => e.criterionId === "A4")!.basis).toMatchObject({ kind: "machine", target: "app:未コミット" });
    });

    await step("取消で根拠の入力を捨てる", async () => {
      await panel.getByRole("button", { name: "A2 の証拠を編集" }).click();
      await panel.getByLabel(/根拠の種類/).selectOption({ label: "申告のみ" });
      await panel.getByRole("button", { name: "取消" }).click();
      await until.visible(item("A2").getByText("検査結果あり", { exact: true }));
    });

    for (const width of [1280, 375]) {
      const narrow = await s.open({ width, height: 800 });
      await s.step(
        `幅 ${width}: 進捗の行が重ならず、詳細で根拠の入力と保存にキーボードで届く`,
        async () => {
          await narrow.goto("/");
          const row = narrow.getByTestId("schedule").getByRole("link").filter({ hasText: "領収書の根拠を確かめる" });
          await until.visible(row);
          expect(await pageOverflow(narrow)).toEqual([]);
          await narrow.goto(`/requests/${ids.basis}?task=T001`);
          const p = narrow.locator("section").filter({ has: narrow.getByRole("heading", { name: "受け入れ基準と作業した側の証拠" }) });
          await until.visible(p.getByText("pnpm test:legacy"));
          expect(await pageOverflow(narrow)).toEqual([]);
          const edit = p.getByRole("button", { name: "A1 の証拠を編集" });
          expect(await reachable(edit, "A1 の証拠を編集")).toEqual([]);
          await edit.focus();
          await narrow.keyboard.press("Enter");
          await p.getByLabel(/根拠の種類/).selectOption({ label: "検査結果あり" });
          await p.getByLabel(/検査のコマンド/).fill(`pnpm vitest run ${"test/very/long/path/segment/".repeat(4)}x.test.ts`);
          expect(await pageOverflow(narrow)).toEqual([]);
          expect(await reachable(p.getByLabel(/対象（必須）/), "対象")).toEqual([]);
          expect(await reachable(p.getByRole("button", { name: "取消" }), "取消")).toEqual([]);
          await p.getByRole("button", { name: "取消" }).click();
        },
        narrow,
      );
    }
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
