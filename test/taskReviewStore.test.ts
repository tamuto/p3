import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OwnerProbe } from "../src/core/preflight/owner.ts";
import { createTask, updateTask } from "../src/core/requestOps.ts";
import { ReviewCancelRefused, ReviewStoreError, RunControl } from "../src/core/reviewRuns.ts";
import { newTaskReviewRunId, parseTaskReviewKey } from "../src/core/taskReview/store.ts";
import type { TaskReviewInput, TaskReviewResult, TaskReviewRun } from "../src/shared/taskReview.ts";
import { makeProject, newRequest } from "./helpers.ts";

/**
 * タスクの AI レビューの履歴（core/taskReview/store.ts）と、実行中の run の扱いの共通部分（core/reviewRuns.ts の RunControl）:
 * 保存先・ID・パスの確かめ・二重の開始・終わった run の書き換えの拒否・所有者の回復・取消の要求と中断・遅れて届いた結果
 */

const input = (ref: string, hash = "h1"): TaskReviewInput => ({
  version: 1,
  request: { id: ref.split("/")[0], title: "要望", status: "active", body: "" },
  task: { id: ref.split("/")[1], ref, title: "t", status: "done", body: "", outputs: [] },
  items: [{ id: "A1", kind: "criterion", text: "送れる" }],
  targets: [],
  viewpoint: { source: "builtin", text: "既定", hash: "v" },
  notes: [],
  files: [],
  extractedAt: new Date().toISOString(),
  hash,
});
const result: TaskReviewResult = { overall: "所見", items: [{ item: "A1", verdict: "missing", reason: "無い", evidence: [], gaps: [] }], unplanned: [], checks: [], coverage: { read: "差分", unread: "" } };
const probe = (state: "dead" | "unknown" | "alive"): OwnerProbe => ({
  self: () => ({ instance: "me", pid: 1, start: "1" }),
  startOf: () => (state === "dead" ? null : state === "alive" ? "1" : undefined),
});

async function setup() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "要望" });
  const { task } = await createTask(p.ctx, req.id, { title: "送る", criteria: ["送れる"] });
  await updateTask(p.ctx, req.id, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] });
  await updateTask(p.ctx, req.id, task.id, { checked: true });
  const store = p.ctx.ws.taskReviews;
  const key = `${req.id}/${task.id}`;
  const run = (over: Partial<TaskReviewRun> = {}): TaskReviewRun => ({
    id: newTaskReviewRunId(),
    request: req.id,
    task: task.id,
    status: "running",
    engine: "mock",
    startedAt: new Date().toISOString(),
    inputHash: "h1",
    log: [],
    ...over,
  });
  return { ...p, rid: req.id, tid: task.id, key, store, run };
}

describe("保存", () => {
  it("要望のフォルダの task-reviews/<タスク>/<run>/ に材料のファイル・input・run を置き、結果は終わってから。タスクのファイルには書かない", async () => {
    const { store, key, run, dataDir, rid, tid, ctx } = await setup();
    const before = readFileSync(join(dataDir, "requests", rid, "tasks", `${tid}.md`), "utf8");
    const r = run();
    await store.create(input(key), new Map([["diff/main/1.patch", Buffer.from("+x\n")], ["code/main/abc/src/a.ts", Buffer.from("a")]]), r);
    const dir = join(dataDir, "requests", rid, "task-reviews", tid, r.id);
    expect(existsSync(join(dir, "input.json"))).toBe(true);
    expect(readFileSync(join(dir, "material", "diff/main/1.patch"), "utf8")).toBe("+x\n");
    expect(await store.materialFiles(key, r.id)).toEqual(["code/main/abc/src/a.ts", "diff/main/1.patch"]);
    expect(existsSync(join(dir, "review.json"))).toBe(false);
    await store.finish(key, r.id, { status: "completed" }, result);
    const rec = await store.get(key, r.id);
    expect(rec).toMatchObject({ run: { status: "completed" }, result: { overall: "所見" } });
    expect(await store.list(key)).toEqual([expect.objectContaining({ state: "ok", items: 1, verdicts: { missing: 1 } })]);
    expect(await store.tasksWithHistory(rid)).toEqual([tid]);
    // タスクの状態・済み・基準・証拠・要望の状態は変えない
    expect(readFileSync(join(dataDir, "requests", rid, "tasks", `${tid}.md`), "utf8")).toBe(before);
    expect(ctx.ws.requests.get(rid)!.status).toBe("active");
  });

  it("同じ run は作り直さない。ID・キー・材料のパスの外を指すものは断る。シンボリックリンクの run は一覧に出さない", async () => {
    const { store, key, run, dataDir, rid, tid } = await setup();
    const r = run();
    await store.create(input(key), new Map(), r);
    await expect(store.create(input(key), new Map(), r)).rejects.toMatchObject({ code: "exists" });
    for (const k of ["../x/T001", `${rid}/../T001`, `${rid}/T001/x`, "x/T001", `${rid}/TX`]) expect(() => parseTaskReviewKey(k), k).toThrow(ReviewStoreError);
    await expect(store.readRun(key, "../../x")).rejects.toMatchObject({ code: "bad_id" });
    await expect(store.create(input(key), new Map([["../escape.txt", Buffer.from("x")]]), run())).rejects.toMatchObject({ code: "bad_id" });
    await expect(store.create(input(key), new Map([["a/../../b", Buffer.from("x")]]), run())).rejects.toMatchObject({ code: "bad_id" });
    const outside = join(dataDir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dataDir, "requests", rid, "task-reviews", tid, "TR-20260101-000000-abcd"));
    expect(await store.runIds(key)).toEqual([r.id]);
  });

  it("壊れた記録は無いと分けて一覧に出す（隠さない）。過去の成功も残す", async () => {
    const { store, key, run, dataDir, rid, tid } = await setup();
    const ok = run({ startedAt: "2026-01-01T00:00:00.000Z" });
    await store.create(input(key), new Map(), ok);
    await store.finish(key, ok.id, { status: "completed" }, result);
    const bad = run({ id: "TR-20260102-000000-0000", startedAt: "2026-01-02T00:00:00.000Z" });
    await store.create(input(key), new Map(), bad);
    writeFileSync(join(dataDir, "requests", rid, "task-reviews", tid, bad.id, "run.json"), "{ 壊れた");
    const list = await store.list(key);
    expect(list.map((x) => x.state)).toEqual(["broken", "ok"]);
    await expect(store.get(key, "TR-20260103-000000-0000")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.get(key, bad.id)).rejects.toMatchObject({ code: "broken" });
  });

  it("タスクをアーカイブしても履歴は残って読める", async () => {
    const { store, key, run, ctx, rid, tid } = await setup();
    const r = run();
    await store.create(input(key), new Map(), r);
    await ctx.ws.tasksOf(rid).archive(tid);
    expect((await store.get(key, r.id)).run.id).toBe(r.id);
    expect(await store.tasksWithHistory(rid)).toEqual([tid]);
  });
});

describe("実行中の run の扱い（共通）", () => {
  it("同じタスクは同時に1つだけ（並行して始めても1つ）。別のタスクは独立", async () => {
    const { store, key, run, ctx, rid } = await setup();
    const control = new RunControl(store, new Set<string>(), probe("alive"));
    const start = () =>
      store.withLock(key, async () => {
        if (await control.runningLocked(key)) throw new Error("running");
        await store.create(input(key), new Map(), run({ owner: { instance: "me", pid: 1, start: "1" } }));
      });
    const results = await Promise.allSettled([start(), start(), start()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.runIds(key)).toHaveLength(1);
    const { task: other } = await createTask(ctx, rid, { title: "別" });
    const key2 = `${rid}/${other.id}`;
    await store.withLock(key2, async () => {
      expect(await control.runningLocked(key2)).toBeUndefined();
      await store.create(input(key2), new Map(), run({ task: other.id }));
    });
    expect(await store.runIds(key2)).toHaveLength(1);
  });

  it("終わった run は書き換えない（終わり・ログの書き足し・取消を断る）", async () => {
    const { store, key, run } = await setup();
    const r = run();
    await store.create(input(key), new Map(), r);
    await store.finish(key, r.id, { status: "failed", failure: "error", error: "x" });
    await expect(store.finish(key, r.id, { status: "completed" }, result)).rejects.toMatchObject({ code: "finished" });
    await expect(store.updateRunning(key, r.id, (x) => x)).rejects.toMatchObject({ code: "finished" });
    const control = new RunControl(store, new Set<string>(), probe("alive"));
    await expect(control.cancel(key, r.id, "human:a", { label: r.id })).rejects.toBeInstanceOf(ReviewCancelRefused);
  });

  it("死んだと確かめられた所有者は crashed にし、分からない所有者は残す（人が明示して中断できる。動いている所有者は断る）", async () => {
    const { store, key, run } = await setup();
    const owner = { instance: "me", pid: 99999, start: "5" };
    const dead = run({ owner });
    await store.create(input(key), new Map(), dead);
    await store.withLock(key, () => new RunControl(store, new Set<string>(), probe("dead")).recoverLocked(key));
    expect((await store.readRun(key, dead.id)).status).toBe("failed");
    expect((await store.readRun(key, dead.id)).failure).toBe("crashed");
    // 分からない所有者（同じ起動の時刻で、生きているかは確かめられない）
    const unknown = run({ owner: { instance: "me", pid: 99999, start: "1" } });
    await store.create(input(key), new Map(), unknown);
    const u = new RunControl(store, new Set<string>(), probe("unknown"));
    await store.withLock(key, () => u.recoverLocked(key));
    expect((await store.readRun(key, unknown.id)).status).toBe("running");
    await expect(new RunControl(store, new Set<string>(), probe("alive")).cancel(key, unknown.id, "human:a", { acknowledgeStopped: true, label: "x" })).rejects.toMatchObject({ code: "owner_alive" });
    const out = await u.cancel(key, unknown.id, "human:a", { acknowledgeStopped: true, label: "x" });
    expect(out.run).toMatchObject({ status: "cancelled", abandoned: { by: "human:a" } });
  });

  it("ほかのプロセスの run の取消は要求を書き、中断した後に届いた結果は取り込まない", async () => {
    const { store, key, run } = await setup();
    const r = run({ owner: { instance: "me", pid: 1, start: "1" } });
    await store.create(input(key), new Map(), r);
    const other = new RunControl(store, new Set<string>(), probe("unknown"));
    const req = await other.cancel(key, r.id, "human:a", { label: "x" });
    expect(req).toMatchObject({ requested: true, run: { status: "running", cancelRequested: { by: "human:a" } } });
    // 実行している側が取消の要求を見つける
    const mine = new RunControl(store, new Set([r.id]), probe("alive"));
    const abort = new AbortController();
    const stop = mine.watch(key, r.id, [], abort, 10);
    await new Promise((res) => setTimeout(res, 80));
    stop();
    expect(abort.signal.aborted).toBe(true);
    // 人が中断した後に結果が届いても、取り込まず今の記録を返す
    await other.cancel(key, r.id, "human:a", { acknowledgeStopped: true, label: "x" });
    const end = await mine.end(key, r.id, { status: "completed" }, result);
    expect(end.status).toBe("cancelled");
    await expect(store.readResult(key, r.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
