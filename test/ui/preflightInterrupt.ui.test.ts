// 落ちたプロセスが残した Preflight の run（261103-gtfcg）: serve が開いたときに中断にした run の理由の表示と再実行、古い履歴の
// running の run の中断（頼む → 止まっていることを確かめて中断にする）、最新の run が実行中なら古い run を見ていても再実行しないこと、
// 中断を頼んでいる間の表示。状態は CLI と run のファイルで用意し、操作はブラウザで行う（Mock のエンジン。Docker は使わない）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { openScenario, until, type Scenario } from "./scenario.ts";
import type { UiEnv } from "./env.ts";

const ids = { gone: "", goneRun: "", old: "", oldRun: "", latestRun2: "", busy: "", busyOld: "", busyLatest: "" };

const runFile = (env: UiEnv, rid: string, run: string) => join(env.repo, ".p3", "requests", rid, "preflight", run, "run.json");
function patchRun(env: UiEnv, rid: string, run: string, patch: Record<string, unknown>) {
  const f = runFile(env, rid, run);
  const v = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...v, ...patch, finishedAt: undefined }, null, 2));
}
/** 別の環境で動いている（確かめられない）ことにする */
const otherEnv = { instance: "0123456789abcdef01234567", pid: 1, start: "1" };

async function prepare(env: UiEnv) {
  const newRequest = async (title: string) => (JSON.parse(await env.p3(["request", "new", title, "--body", "-", "--json"], `- ${title}\n`)) as { id: string }).id;
  const runOnce = async (rid: string) => {
    await env.p3(["preflight", rid, "--engine", "mock", "--json"]);
    return (JSON.parse(await env.p3(["drafts", rid, "--json"])) as { id: string }).id;
  };
  // 1. 終わった CLI のプロセスが残した running の run（serve が開いたときに中断にする）
  ids.gone = await newRequest("落ちた run の回復");
  ids.goneRun = await runOnce(ids.gone);
  patchRun(env, ids.gone, ids.goneRun, { status: "running", before: "draft" });
  await env.p3(["request", "set", ids.gone, "status=preflight"]);
  // 2. 古い履歴に残った、確かめられない running の run（最新は完了）
  ids.old = await newRequest("古い履歴の中断");
  ids.oldRun = await runOnce(ids.old);
  ids.latestRun2 = await runOnce(ids.old);
  patchRun(env, ids.old, ids.oldRun, { status: "running", owner: otherEnv });
  // 3. 最新の run が実行中（確かめられない・中断を頼んでいる）で、古い run は完了
  ids.busy = await newRequest("最新が実行中");
  ids.busyOld = await runOnce(ids.busy);
  ids.busyLatest = await runOnce(ids.busy);
  patchRun(env, ids.busy, ids.busyLatest, { status: "running", owner: otherEnv });
  writeFileSync(join(env.repo, ".p3", "requests", ids.busy, "preflight", ids.busyLatest, "cancel-request.json"), JSON.stringify({ at: "2026-11-03T03:00:00.000Z", by: "human:cli" }));
}

describe.skipIf(!inject("chromium").available)("落ちたプロセスが残した Preflight の run", () => {
  let s: Scenario;
  beforeAll(async () => {
    s = await openScenario("残った run", { prepare });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("serve が開いたときに中断にした run は理由を出し、もう一度 Preflight を実行できる", async () => {
    const { page, step } = s;
    await step("中断の理由を出す", async () => {
      await page.goto(`/requests/${ids.gone}`);
      await until.visible(page.getByRole("status").filter({ hasText: "中断した run" }));
      await until.visible(page.getByText(/実行していたプロセスが終わっていたので中断にしました/));
      // 評価の失敗とは扱わない（Preflight を通さずに作る案内は出さない）
      expect(await page.getByRole("link", { name: /Preflight を通さずにタスクを作成/ }).count()).toBe(0);
    });
    await step("もう一度実行できる", async () => {
      const again = page.getByRole("button", { name: "▶ もう一度 Preflight" });
      await until.enabled(again);
      await again.click();
      const latest = async () => JSON.parse(await s.env.p3(["drafts", ids.gone, "--json"])) as { id: string; status: string };
      await expect.poll(async () => (await latest()).status, { timeout: 15_000 }).toBe("completed");
      expect((await latest()).id).not.toBe(ids.goneRun);
      await until.enabled(page.getByRole("button", { name: "▶ もう一度 Preflight" }));
    });
  });

  it("古い履歴の running の run を選んで中断を頼み、止まっていることを確かめて中断にする。最新は変えない", async () => {
    const { page, step } = s;
    await step("古い run を選ぶ（最新は完了しているので再実行できる）", async () => {
      await page.goto(`/requests/${ids.old}?run=${ids.oldRun}`);
      await until.visible(page.getByRole("button", { name: "中止" }));
      await until.enabled(page.getByRole("button", { name: "▶ もう一度 Preflight" }));
      await until.visible(page.getByText(/この run を実行しているプロセスを確かめられません/));
    });
    await step("中止は頼むだけ（まだ中断にしない）", async () => {
      await page.getByRole("button", { name: "中止" }).click();
      await until.visible(page.getByRole("status").filter({ hasText: /中断を頼みました/ }));
      const run = JSON.parse(await s.env.p3(["drafts", ids.old, "--run", ids.oldRun, "--json"])) as { status: string };
      expect(run.status).toBe("running");
    });
    await step("止まっていることを確かめて中断にする", async () => {
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "止まっていることを確かめて中断にする" }).click();
      await until.visible(page.getByText(/止まっていることを human:web が確かめて中断にしました/));
      const run = JSON.parse(await s.env.p3(["drafts", ids.old, "--run", ids.oldRun, "--json"])) as { status: string; interrupted?: { acknowledgedBy?: string } };
      expect(run).toMatchObject({ status: "failed", interrupted: { acknowledgedBy: "human:web" } });
      const latest = JSON.parse(await s.env.p3(["drafts", ids.old, "--json"])) as { id: string; status: string };
      expect(latest).toMatchObject({ id: ids.latestRun2, status: "completed" });
    });
  });

  it("最新の run が実行中なら、完了した古い run を見ていても再実行しない。中断を頼んでいる間はそれを出す", async () => {
    const { page, step } = s;
    await step("古い完了した run を見ても再実行できない", async () => {
      await page.goto(`/requests/${ids.busy}?run=${ids.busyOld}`);
      await until.disabled(page.getByRole("button", { name: "実行中…" }));
      expect(await page.getByRole("button", { name: "中止" }).count()).toBe(0);
    });
    await step("最新の run では、中断を頼んでいることと確かめる操作を出す", async () => {
      await page.goto(`/requests/${ids.busy}?run=${ids.busyLatest}`);
      await until.visible(page.getByRole("status").filter({ hasText: /中断を頼んでいます/ }));
      await until.visible(page.getByRole("button", { name: "もう一度中止を頼む" }));
      await until.visible(page.getByRole("button", { name: "止まっていることを確かめて中断にする" }));
      await until.disabled(page.getByRole("button", { name: "実行中…" }));
    });
  });
});
