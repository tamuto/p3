import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MetricStore } from "../packages/observer/src/core/metricStore.ts";
import type { SystemKey } from "../packages/observer/src/shared/metric.ts";
import { createTask, updateRequest, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { completeMilestoneRequests, completionPlan } from "../packages/tasks/src/features/releaseNotes/core/completeRequests.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測のシステムの項目（docs/architecture.md「p3-observer」）: 要望・タスクの状態が変わったその場で tasks が値を書く。
 * 到達時間は要望ごとに1回、完了時の満たしていない基準は完了になるたび（基準なしは記録しない）、手戻りは完了から戻すたび。
 * 同じ状態の再送・成果物の追記では記録しない。記録に失敗しても操作は止めず、CLI・API の結果で知らせる
 */
async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "v1" }] });
  const r = await newRequest(p.ctx, { title: "請求", milestone: "v1" });
  const values = async (key: SystemKey) => (await new MetricStore(p.dataDir).get(key)).values.map((v) => ({ value: v.value, target: v.target, milestone: v.milestone, by: v.by }));
  return { ...p, rid: r.id, values };
}

describe("タスク", () => {
  it("完了になるたびに met でない基準の数（未達・未検証・証拠なし・古い証拠を含み、申告の met は含めない）、完了から戻すたびに手戻り 1", async () => {
    const { ctx, rid, values } = await setup();
    const { task } = await createTask(ctx, rid, { title: "実装", criteria: ["a", "b", "c", "d"] });
    const evidence = [
      { op: "record" as const, id: "A1", result: "met" as const, evidence: "申告", basis: { kind: "declaration" as const } },
      { op: "record" as const, id: "A2", result: "unmet" as const, evidence: "未達" },
      { op: "record" as const, id: "A3", result: "unverified" as const, evidence: "まだ" },
    ];
    await updateTask(ctx, rid, task.id, { status: "done", acceptance: evidence }, { actor: "ai:x" });
    // 同じ状態の再送・成果物の追記では記録しない
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateTask(ctx, rid, task.id, { outputs: ["https://example.test/pr/1"] });
    expect(await values("p3.task.criteria_unmet")).toEqual([{ value: 3, target: `${rid}/${task.id}`, milestone: "v1", by: "ai:x" }]);
    await updateTask(ctx, rid, task.id, { status: "doing" }, { actor: "human:a" });
    // 基準の文を変えると、その証拠は古い証拠になる
    await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "edit", id: "A1", text: "a2" }] });
    expect((await values("p3.task.criteria_unmet")).map((v) => v.value)).toEqual([4, 3]);
    expect(await values("p3.task.rework")).toEqual([{ value: 1, target: `${rid}/${task.id}`, milestone: "v1", by: "human:a" }]);
  });

  it("完了の状態で作ったタスクも記録し、基準の無いタスクは記録しない", async () => {
    const { ctx, rid, values } = await setup();
    await createTask(ctx, rid, { title: "済んだ作業", status: "done", criteria: ["a"] });
    await createTask(ctx, rid, { title: "基準なし", status: "done" });
    const { task } = await createTask(ctx, rid, { title: "基準なし2" });
    await updateTask(ctx, rid, task.id, { status: "done" });
    expect(await values("p3.task.criteria_unmet")).toEqual([expect.objectContaining({ value: 1, target: `${rid}/T001` })]);
  });
});

describe("要望", () => {
  it("初めて対応済・完了済になったとき、作成からの時間をそれぞれ1回だけ。戻して対応済にし直しても増えない", async () => {
    const { ctx, rid, values } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateRequest(ctx, rid, { status: "resolved" });
    await updateRequest(ctx, rid, { status: "active" });
    await updateRequest(ctx, rid, { status: "resolved" });
    await updateRequest(ctx, rid, { status: "done" }, { actor: "human:a" });
    const resolved = await values("p3.request.lead_time_resolved");
    expect(resolved).toEqual([{ value: expect.any(Number), target: rid, milestone: "v1", by: "p3" }]);
    expect(resolved[0].value).toBeGreaterThanOrEqual(0);
    expect(await values("p3.request.lead_time_done")).toEqual([expect.objectContaining({ target: rid, by: "human:a" })]);
  });

  it("対応済を経ずに完了済にしたら完了済の項目だけ。マイルストーンの一括完了でも記録する", async () => {
    const { ctx, rid, values } = await setup();
    const other = await newRequest(ctx, { title: "別", milestone: "v1" });
    for (const id of [rid, other.id]) {
      const { task } = await createTask(ctx, id, { title: "作業" });
      await updateTask(ctx, id, task.id, { status: "done" });
    }
    await updateRequest(ctx, rid, { status: "done" });
    expect(await values("p3.request.lead_time_resolved")).toEqual([]);
    await updateRequest(ctx, other.id, { status: "resolved" });
    const res = await completeMilestoneRequests(ctx, "v1", (await completionPlan(ctx, "v1")).basedOn, "human:a");
    expect(res.completed.map((x) => x.id)).toEqual([other.id]);
    expect((await values("p3.request.lead_time_done")).map((v) => v.target)).toEqual(expect.arrayContaining([rid, other.id]));
  });
});

describe("記録の失敗", () => {
  const breakValues = (dataDir: string, key: SystemKey) => {
    mkdirSync(join(dataDir, "observer", "metrics", "values"), { recursive: true });
    writeFileSync(join(dataDir, "observer", "metrics", "values", `${key}.json`), "壊れた");
  };

  it("操作はして、作成・単件の更新・一括完了の結果に項目・対象・理由を返す。API の結果にも入る", async () => {
    const { ctx, rid, dataDir } = await setup();
    breakValues(dataDir, "p3.task.criteria_unmet");
    breakValues(dataDir, "p3.request.lead_time_done");
    const created = await createTask(ctx, rid, { title: "済んだ作業", status: "done", criteria: ["a"] });
    expect(created.task.status).toBe("done");
    expect(created.observationSkipped).toEqual([expect.stringContaining(`p3.task.criteria_unmet（${rid}/T001）`)]);
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await send("PATCH", `/requests/${rid}/tasks/T001`, { status: "doing" });
    const patched = (await (await send("PATCH", `/requests/${rid}/tasks/T001`, { status: "done" })).json()) as { status: string; observationSkipped?: string[] };
    expect(patched).toMatchObject({ status: "done", observationSkipped: [expect.stringContaining("読めません")] });
    await updateRequest(ctx, rid, { status: "resolved" });
    const res = await completeMilestoneRequests(ctx, "v1", (await completionPlan(ctx, "v1")).basedOn);
    expect(res.completed.map((x) => x.id)).toEqual([rid]);
    expect(res.observationSkipped).toEqual([expect.stringContaining(`p3.request.lead_time_done（${rid}）`)]);
  });

  it("CLI は標準エラーと --json の結果で知らせ、終了コードは 0", async () => {
    const { root, rid } = await initialized();
    const add = p3(root, ["new", "作業", "--req", rid, "--criterion", "a", "--json"]);
    expect(add.code, add.err).toBe(0);
    breakValues(join(root, ".p3"), "p3.task.criteria_unmet");
    const r = p3(root, ["move", "T001", "done", "--req", rid, "--record", "変えた", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("観測の p3.task.criteria_unmet");
    expect(r.json()).toMatchObject({ status: "done", observationSkipped: [expect.stringContaining("p3.task.criteria_unmet")] });
  });
});
