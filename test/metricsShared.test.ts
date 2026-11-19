import { describe, expect, it, vi } from "vitest";
import * as acceptance from "../packages/tasks/src/features/requirements/shared/acceptance.ts";
import { metricsReport, REVIEW_READ_CONCURRENCY } from "../packages/tasks/src/features/metrics/core/index.ts";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import type { P3Context } from "../packages/tasks/src/core/context.ts";
import { makeProject, newRequest } from "./helpers.ts";

/**
 * 指標のレポート（core/metrics）の共通処理（261120-3getg）: 5つの受け入れ基準の指標が1回の基準の集計を使うこと、完了タスクのレビューを
 * 要望をまたいだ上限つきで並行に読み、読み終わる順に関係なく要望・タスクの順で集計すること
 */

vi.mock("../packages/tasks/src/features/requirements/shared/acceptance.ts", async (orig) => {
  const m = await orig<typeof import("../packages/tasks/src/features/requirements/shared/acceptance.ts")>();
  return { ...m, acceptanceStatus: vi.fn(m.acceptanceStatus) };
});
const acceptanceStatus = vi.mocked(acceptance.acceptanceStatus);

/** 要望を n 件作り、それぞれに完了したタスクを per 件（どの要望も T001 から） */
async function project(n: number, per: number, criteria = false) {
  const { ctx } = await makeProject();
  const ids: string[] = [];
  for (let r = 0; r < n; r++) {
    const req = await newRequest(ctx, { title: `要望${r + 1}` });
    ids.push(req.id);
    for (let i = 0; i < per; i++) {
      const { task } = await createTask(ctx, req.id, { title: `作業${i + 1}`, ...(criteria ? { criteria: ["一", "二"] } : {}) });
      await updateTask(ctx, req.id, task.id, { status: "done" });
    }
  }
  return { ctx, ids };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** レビューの読み取りを差し替え、同時に読んでいる数（一覧の取得から結果の取得の終わりまで）を数える */
function watchReviews(ctx: P3Context, behave: (key: string, order: number) => { delay: number; fail?: boolean; run?: boolean }) {
  let inFlight = 0;
  let max = 0;
  let order = 0;
  const open = new Set<string>();
  const reviews = ctx.ws.taskReviews as unknown as { list: (key: string) => Promise<unknown[]>; get: (key: string, run: string) => Promise<unknown> };
  reviews.list = async (key) => {
    const b = behave(key, order++);
    inFlight += 1;
    max = Math.max(max, inFlight);
    open.add(key);
    await sleep(b.delay);
    const close = () => {
      inFlight -= 1;
      open.delete(key);
    };
    if (b.fail) {
      close();
      throw new Error(`読めない ${key}`);
    }
    if (!b.run) {
      close();
      return [];
    }
    return [{ state: "ok", id: `TR-${order}`, run: { id: `TR-20261101-000000-${String(order).padStart(4, "0")}`, status: "completed", finishedAt: "2026-11-01T00:00:00.000Z" } }];
  };
  reviews.get = async (key) => {
    await sleep(1);
    inFlight -= 1;
    open.delete(key);
    return {};
  };
  return { max: () => max, open };
}

describe("指標のレポートの共通処理", () => {
  it("1回のレポートで、5つの受け入れ基準の指標は基準の照合（タスクごと）を1回だけ使い、値はそろう", async () => {
    const { ctx, ids } = await project(2, 2, true);
    acceptanceStatus.mockClear();
    const r = await metricsReport(ctx);
    const calls = acceptanceStatus.mock.calls.map(([t]) => (t as { ref: string }).ref).sort();
    expect(calls).toEqual(ids.flatMap((id) => [`${id}/T001`, `${id}/T002`]).sort());
    const crit = r.metrics.filter((m) => m.id.startsWith("acceptance_"));
    expect(crit.map((m) => m.id)).toEqual(["acceptance_unmet", "acceptance_unverified", "acceptance_no_evidence", "acceptance_stale", "acceptance_met"]);
    for (const m of crit) expect(m).toMatchObject({ targets: 4, observed: 4, denominator: 8 });
    expect(crit.find((m) => m.id === "acceptance_no_evidence")!.value).toBe(8);
  });

  it("完了タスクのレビューを要望をまたいで並行に読み、同時に読む数はレポート全体の上限を超えない", async () => {
    // 要望の数も上限より多くする（要望ごとの上限では超えてしまう形）
    const per = 2;
    const n = REVIEW_READ_CONCURRENCY + 4;
    const { ctx } = await project(n, per);
    const w = watchReviews(ctx, () => ({ delay: 10, run: true }));
    const r = await metricsReport(ctx);
    expect(w.max()).toBeGreaterThanOrEqual(2);
    expect(w.max()).toBeLessThanOrEqual(REVIEW_READ_CONCURRENCY);
    expect(w.open.size).toBe(0);
    expect(r.metrics.find((m) => m.id === "review_missing")).toMatchObject({ targets: n * per, missing: n * per });
  });

  it("読み終わる順を入れ替え、一部の読み取りを失敗させても、同じタスク ID の別の要望と取り違えず、失敗したものだけを元の順の欠損に載せる", async () => {
    const { ctx, ids } = await project(3, 3);
    // 先に始めたものほど遅く終わる。要望2の T001 と要望3の T003 だけ失敗させる
    const failing = new Set([`${ids[1]}/T001`, `${ids[2]}/T003`]);
    watchReviews(ctx, (key, order) => ({ delay: (20 - order) * 3, fail: failing.has(key) }));
    const r = await metricsReport(ctx);
    const miss = r.metrics.find((m) => m.id === "review_missing")!;
    // 集計の順は要望 ID の順・タスクの順（作った順ではない）
    const expected = [...ids].sort().flatMap((id) => ["T001", "T002", "T003"].map((t) => `${id}/${t}`)).filter((k) => failing.has(k));
    expect(miss.missingItems.map((m) => m.target)).toEqual(expected);
    expect(miss.missingItems.map((m) => m.reason)).toEqual(expected.map((k) => `レビューの記録が読めません: 読めない ${k}`));
    expect(miss).toMatchObject({ targets: 9, missing: 2 });
  });
});
