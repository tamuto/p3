import { describe, expect, it, vi } from "vitest";
import * as shared from "../packages/tasks/src/features/records/shared/reviewCandidate.ts";
import { createTask, recordPremise, updateRequest, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { progress } from "../packages/tasks/src/core/ops.ts";
import { makeProject, newRequest } from "./helpers.ts";

/**
 * 進捗（core/ops.ts の progress）は、1回の呼び出しの中で見直しの診断を使い回す（261120-89k52）: タスクは要望 ID を含む参照、要望自身は
 * 要望 ID ごとに1回だけ診断し、タスク行と要望の件数（自身・自分のタスク・配下）に同じ結果を使う。次の呼び出しでは診断し直す
 */

vi.mock("../packages/tasks/src/features/records/shared/reviewCandidate.ts", async (orig) => {
  const m = await orig<typeof import("../packages/tasks/src/features/records/shared/reviewCandidate.ts")>();
  return { ...m, diagnoseTask: vi.fn(m.diagnoseTask), diagnoseRequest: vi.fn(m.diagnoseRequest) };
});
const diagnoseTask = vi.mocked(shared.diagnoseTask);
const diagnoseRequest = vi.mocked(shared.diagnoseRequest);

/** 親 P（進行中）・子 C（対応済）・孫 G（対応済）。どの要望にも T001 があり、診断の結果が違う */
async function setup() {
  const { ctx } = await makeProject();
  const p = await newRequest(ctx, { title: "親" });
  const c = await newRequest(ctx, { title: "子", parent: p.id });
  const g = await newRequest(ctx, { title: "孫", parent: c.id });
  for (const [r, n] of [[p, 2], [c, 1], [g, 2]] as const) for (let i = 0; i < n; i++) await createTask(ctx, r.id, { title: `${r.title}の作業${i + 1}` });
  await updateTask(ctx, p.id, "T001", { status: "done" }); // P/T002 は未完了のまま
  for (const t of ["T001", "T002"]) await updateTask(ctx, g.id, t, { status: "done" });
  await updateRequest(ctx, g.id, { status: "resolved" });
  await updateTask(ctx, c.id, "T001", { status: "done" });
  await updateRequest(ctx, c.id, { status: "resolved" });
  // 候補: P/T001・G/T001・C 自身（C/T001・G/T002・G 自身は差分なし）
  await recordPremise(ctx, p.id, { op: "add", targets: ["T001"], reason: "r", condition: "c" });
  await recordPremise(ctx, g.id, { op: "add", targets: ["T001"], reason: "r", condition: "c" });
  await recordPremise(ctx, c.id, { op: "add", targets: [c.id], reason: "r", condition: "c" });
  return { ctx, p: p.id, c: c.id, g: g.id };
}

const callsBy = <T>(fn: { mock: { calls: unknown[][] } }, key: (a: T) => string) => {
  const n = new Map<string, number>();
  for (const [a] of fn.mock.calls) n.set(key(a as T), (n.get(key(a as T)) ?? 0) + 1);
  return n;
};

describe("進捗の見直しの診断を呼び出しの中で共有する", () => {
  it("各タスク（要望ごと）と各要望自身の診断は1回だけで、タスク行と要望の件数（自身・自分のタスク・配下）が同じ結果を使う", async () => {
    const { ctx, p, c, g } = await setup();
    diagnoseTask.mockClear();
    diagnoseRequest.mockClear();
    const rows = Object.fromEntries(progress(ctx).map((x) => [x.request.id, x]));

    const tasks = callsBy<{ ref: string }>(diagnoseTask, (t) => t.ref);
    expect([...tasks.keys()].sort()).toEqual([`${p}/T001`, `${p}/T002`, `${c}/T001`, `${g}/T001`, `${g}/T002`].sort());
    expect([...tasks.values()].every((n) => n === 1)).toBe(true);
    const reqs = callsBy<{ id: string }>(diagnoseRequest, (r) => r.id);
    expect([...reqs.keys()].sort()).toEqual([p, c, g].sort());
    expect([...reqs.values()].every((n) => n === 1)).toBe(true);

    // 同じタスク ID でも要望ごとの結果（A3）
    const state = (rid: string, tid: string) => rows[rid].tasks.find((t) => t.id === tid)?.review;
    expect([state(p, "T001"), state(p, "T002"), state(c, "T001"), state(g, "T001"), state(g, "T002")]).toEqual(["candidate", undefined, "none", "candidate", "none"]);
    // 件数: 自身・自分のタスク・配下（子孫の要望自身と、そのタスクを1回ずつ）
    expect(rows[p].review).toEqual({ tasks: 1, below: 2 }); // 配下: C 自身 + G/T001
    expect(rows[c].review).toMatchObject({ self: { state: "candidate" }, tasks: 0, below: 1 }); // 配下: G/T001
    expect(rows[g].review).toMatchObject({ self: { state: "none" }, tasks: 1, below: 0 });
  });

  it("同じコンテキストで前提の変更を記録して取り直すと、新しい診断と自分・祖先の件数が返る（呼び出しをまたいで覚えない）", async () => {
    const { ctx, p, c, g } = await setup();
    progress(ctx);
    await recordPremise(ctx, g, { op: "add", targets: ["T002"], reason: "r2", condition: "c2" });
    diagnoseTask.mockClear();
    const rows = Object.fromEntries(progress(ctx).map((x) => [x.request.id, x]));
    expect(rows[g].tasks.find((t) => t.id === "T002")?.review).toBe("candidate");
    expect(rows[g].review).toMatchObject({ tasks: 2, below: 0 });
    expect(rows[c].review).toMatchObject({ tasks: 0, below: 2 });
    expect(rows[p].review).toEqual({ tasks: 1, below: 3 });
    expect([...callsBy<{ ref: string }>(diagnoseTask, (t) => t.ref).values()].every((n) => n === 1)).toBe(true);
  });
});
