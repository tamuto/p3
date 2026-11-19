import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { METRIC_DEFINITIONS, selectTaskReview, type MetricsInput } from "../packages/tasks/src/features/metrics/core/definitions.ts";
import { metricsReport } from "../packages/tasks/src/features/metrics/core/index.ts";
import { updateTask } from "../packages/tasks/src/core/requestOps.ts";
import type { MetricResult } from "../packages/tasks/src/features/metrics/shared/metrics.ts";
import type { ReworkEntry } from "../packages/tasks/src/features/records/shared/reworkHistory.ts";
import type { TaskReviewListItem, TaskReviewResult, TaskReviewRun } from "../packages/tasks/src/shared/taskReview.ts";
import type { Request, Task } from "../packages/tasks/src/shared/types.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/**
 * 開発の指標の手戻りとタスクレビューの所見（core/metrics/definitions.ts）: 1操作1件・欠損と記録なしの区別、最新の完了したレビューの選び方、
 * 未達判定と意図しない変更の候補の区別、レビューなし・読めない・所見ゼロの区別、表示で何も書かず AI も動かさないことを確かめる
 */

const metric = (id: string, i: MetricsInput) => METRIC_DEFINITIONS.find((x) => x.id === id)!.compute(i);
const count = (m: Pick<MetricResult, "breakdown">, key: string) => m.breakdown.find((b) => b.key === key)?.count;
const task = (id: string, status: Task["status"], extra: Partial<Task> = {}): Task =>
  ({ id, request: "r", ref: `r/${id}`, title: id, status, labels: [], areas: [], outputs: [], repo: null, body: "", rev: 1, createdAt: "", updatedAt: "", ...extra }) as Task;
const entry = (id: string, rev: number, cause: ReworkEntry["cause"], reopened: boolean, unchecked: boolean): ReworkEntry => ({
  id,
  at: "2026-11-01T00:00:00.000Z",
  rev,
  cause,
  reopened,
  unchecked,
  from: { status: "done", checked: unchecked },
  to: { status: reopened ? "doing" : "done", checked: false },
});
const input = (tasks: Task[], extra: Partial<MetricsInput["requests"][number]> = {}): MetricsInput => ({
  requests: [{ request: { id: "r" } as Request, tasks, brokenTasks: [], reviews: {}, ...extra }],
  manual: { records: [] },
});

describe("手戻り", () => {
  it("再開と済みの解除を示す1件は1件、同じ rev の重なりも1件。履歴なし・壊れた履歴・読めないファイルを観測と欠損に分ける", () => {
    const r = metric(
      "rework",
      input(
        [
          task("T001", "doing", { reworkHistory: [entry("R1", 3, "reopen", true, true)] }),
          task("T002", "done", { reworkHistory: [entry("R1", 4, "explicit", false, true), entry("R2", 4, "explicit", false, true), entry("R3", 6, "acceptance", false, true)] }),
          task("T003", "done"),
          task("T004", "done", { reworkProblems: ["reworkHistory が並びになっていません"] }),
        ],
        { brokenTasks: ["T005"] },
      ),
    );
    expect(r).toMatchObject({ state: "ok", value: 3, targets: 5, observed: 3, missing: 2 });
    expect(count(r, "cause_reopen")).toBe(1);
    expect(count(r, "cause_explicit")).toBe(1);
    expect(count(r, "cause_acceptance")).toBe(1);
    expect(count(r, "tasks_with_rework")).toBe(2);
    expect(count(r, "tasks_without_history")).toBe(1);
    expect(r.missingItems.map((m) => m.target)).toEqual(["r/T005", "r/T004"]);
  });

  it("済みの完了タスクを作業中に戻した1操作は、保存した履歴から1件と数える", async () => {
    const { ctx } = await makeProject();
    const req = await newRequest(ctx, { title: "要望" });
    const t = await newTask(ctx, req.id, { title: "作業" });
    await updateTask(ctx, req.id, t.id, { status: "done", record: "r" }, { actor: "human:a" });
    await updateTask(ctx, req.id, t.id, { checked: true }, { actor: "human:a" });
    await updateTask(ctx, req.id, t.id, { status: "doing" }, { actor: "human:a" });
    const m = (await metricsReport(ctx)).metrics.find((x) => x.id === "rework")!;
    expect(m).toMatchObject({ value: 1, observed: 1 });
    expect(count(m, "cause_reopen")).toBe(1);
  });

  it("壊れたタスクだけなら欠損で出せず、0 件と言わない", () => {
    expect(metric("rework", input([], { brokenTasks: ["T001"] }))).toMatchObject({ state: "no_data", value: null, missing: 1 });
    expect(metric("rework", input([]))).toMatchObject({ state: "no_targets", value: null });
  });
});

const run = (id: string, patch: Partial<TaskReviewRun> = {}): TaskReviewRun => ({
  id,
  request: "r",
  task: "T001",
  status: "completed",
  engine: "mock",
  startedAt: "2026-11-01T00:00:00.000Z",
  finishedAt: "2026-11-01T01:00:00.000Z",
  inputHash: "h",
  log: [],
  ...patch,
});
const ok = (r: TaskReviewRun): TaskReviewListItem => ({ state: "ok", run: r, inputHash: "h", items: 1 });

describe("レビューの選び方", () => {
  it("完了時刻の新しい完了した run、同時刻は run ID の大きい方。読めない記録・完了時刻の無い完了の run は欠損、完了が無ければなし", () => {
    const a = run("TR-20261101-000000-aaaa", { finishedAt: "2026-11-01T03:00:00.000Z" });
    const b = run("TR-20261101-010000-bbbb", { finishedAt: "2026-11-01T02:00:00.000Z" });
    const c = run("TR-20261101-020000-cccc", { status: "failed" });
    expect(selectTaskReview([ok(c), ok(b), ok(a)])).toEqual({ state: "ok", run: a.id });
    const tie = run("TR-20261101-000000-zzzz", { finishedAt: a.finishedAt });
    expect(selectTaskReview([ok(a), ok(tie)])).toEqual({ state: "ok", run: tie.id });
    expect(selectTaskReview([ok(a), { state: "broken", id: "TR-20261102-000000-dddd", error: "x" }])).toMatchObject({ state: "missing" });
    expect(selectTaskReview([ok(a), ok(run("TR-20261101-000000-eeee", { finishedAt: undefined }))])).toMatchObject({ state: "missing" });
    expect(selectTaskReview([ok(c)])).toEqual({ state: "none" });
    expect(selectTaskReview([])).toEqual({ state: "none" });
  });
});

const result = (items: TaskReviewResult["items"], unplanned: number, checks: string[] = []): TaskReviewResult => ({
  overall: "o",
  items,
  unplanned: Array.from({ length: unplanned }, (_, i) => ({ text: `u${i}`, evidence: [] })),
  checks,
  coverage: { read: "", unread: "" },
});
const item = (verdict: "satisfied" | "missing" | "undetermined") => ({ item: "A1", verdict, reason: "", evidence: [], gaps: [] });

async function writeReview(dataDir: string, rid: string, tid: string, r: TaskReviewRun, res?: TaskReviewResult | string) {
  const dir = join(dataDir, "requests", rid, "task-reviews", tid, r.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({ ...r, request: rid, task: tid }));
  await writeFile(join(dir, "input.json"), JSON.stringify({ task: { id: tid }, items: [], targets: [], hash: "h" }));
  if (res !== undefined) await writeFile(join(dir, "review.json"), typeof res === "string" ? res : JSON.stringify(res));
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out[p] = `${(await stat(p)).mtimeMs}:${await readFile(p, "utf8")}`;
    }
  };
  await walk(dir);
  return out;
}

describe("タスクレビューの所見", () => {
  it("最新の1件だけを数え、未達判定と意図しない変更の候補を別の指標にし、レビューなし・読めない・所見ゼロを分ける。表示で何も書かない", async () => {
    const { ctx, dataDir } = await makeProject();
    const req = await newRequest(ctx, { title: "要望" });
    const done = async (title: string) => {
      const t = await newTask(ctx, req.id, { title });
      await updateTask(ctx, req.id, t.id, { status: "done", record: "r" }, { actor: "human:a" });
      return t.id;
    };
    const [t1, t2, t3, t4] = [await done("二回レビュー"), await done("所見なし"), await done("読めない"), await done("レビューなし")];
    await newTask(ctx, req.id, { title: "作業中" });
    // t1: 古い結果（不足 3）と新しい結果（不足 1・判断できない 1・意図しない変更 2・人が確かめる点 1）
    await writeReview(dataDir, req.id, t1, run("TR-20261101-000000-aaaa", { finishedAt: "2026-11-01T01:00:00.000Z" }), result([item("missing"), item("missing"), item("missing")], 5));
    await writeReview(dataDir, req.id, t1, run("TR-20261102-000000-bbbb", { finishedAt: "2026-11-02T01:00:00.000Z" }), result([item("missing"), item("undetermined"), item("satisfied")], 2, ["確かめて"]));
    await writeReview(dataDir, req.id, t2, run("TR-20261101-000000-cccc"), result([item("satisfied")], 0));
    await writeReview(dataDir, req.id, t3, run("TR-20261101-000000-dddd"), "{ broken");
    void t4;
    const before = await snapshot(dataDir);
    const r = await metricsReport(ctx);
    const miss = r.metrics.find((m) => m.id === "review_missing")!;
    const unplanned = r.metrics.find((m) => m.id === "review_unplanned")!;
    expect(miss).toMatchObject({ state: "ok", value: 1, targets: 4, observed: 2, missing: 1 });
    expect(unplanned).toMatchObject({ state: "ok", value: 2, targets: 4, observed: 2, missing: 1 });
    expect(count(miss, "tasks_not_reviewed")).toBe(1);
    expect(count(miss, "tasks_zero")).toBe(1);
    expect(count(miss, "undetermined")).toBe(1);
    expect(count(miss, "checks")).toBe(1);
    expect(miss.missingItems.map((m) => m.target)).toEqual([`${req.id}/${t3}`]);
    // 読むだけ: ファイル（タスク・レビューの履歴）は変わらず、新しいレビューの run もできない
    expect(await snapshot(dataDir)).toEqual(before);
    expect(ctx.taskReview.running()).toBe(0);
  });

  it("完了タスクのどれもレビューが無ければ「記録なし」で、0 件と言わない", async () => {
    const { ctx } = await makeProject();
    const req = await newRequest(ctx, { title: "要望" });
    const t = await newTask(ctx, req.id, { title: "x" });
    await updateTask(ctx, req.id, t.id, { status: "done", record: "r" }, { actor: "human:a" });
    const m = (await metricsReport(ctx)).metrics.find((x) => x.id === "review_missing")!;
    expect(m).toMatchObject({ state: "unrecorded", value: null, targets: 1, observed: 0, missing: 0 });
  });
});
