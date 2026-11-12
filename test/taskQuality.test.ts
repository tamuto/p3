import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localInstructions } from "../src/core/preflight/instructions.ts";
import { updateQuality } from "../src/core/quality.ts";
import { createTask, importQuality, updateTask } from "../src/core/requestOps.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { acceptanceStatus } from "../src/shared/acceptance.ts";
import { taskQualityDiff } from "../src/shared/quality.ts";
import { makeProject, newRequest } from "./helpers.ts";

/**
 * 品質基準を Preflight とタスクの受け入れ基準へつなぐ: Preflight の run に固定して指示に入れる、タスク化・直接作成で作業先に当てはまる
 * ものを出典つきで取り込む（作業先なしは明示だけ・二重に足さない）、設定を変えてもタスクは変わらず差分を明示して取り込む
 * （変わった条件の証拠は再確認・済みは外れる）、読めない出典を黙って基準なしにしない
 */

async function setup() {
  const p = await makeProject();
  await updateQuality(p.ctx.ws, [
    { op: "add", standard: { text: "lint が通る", check: { kind: "machine", command: "pnpm lint", success: "終了コード 0" } } },
    { op: "add", standard: { text: "main だけの規約", repos: ["main"], check: { kind: "manual", reference: "規約" } } },
    { op: "add", standard: { text: "除外した基準", check: { kind: "manual", reference: "r" } } },
    { op: "exempt", id: "Q3", reason: "対象外" },
  ]);
  const req = await newRequest(p.ctx, { title: "通知", status: "draft", body: "- 送る\n- 記録する" });
  return { ...p, rid: req.id };
}

describe("Preflight", () => {
  it("始めたときの品質基準を run に固定して指示に入れ、タスク化で作業先の案に出典つきで足す（作業先なしの案には足さない）", async () => {
    const { ctx, rid } = await setup();
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    await ctx.preflight.wait(rid, id);
    // 実行中・後に設定を変えても、run の版を使う
    await updateQuality(ctx.ws, [{ op: "add", standard: { text: "後から足した", check: { kind: "manual", reference: "r" } } }]);
    const run = (await ctx.preflight.get(rid, id))!;
    expect(run.quality).toMatchObject({ state: "set", standards: [{ id: "Q1" }, { id: "Q2" }, { id: "Q3" }] });
    await ctx.preflight.updateDraft(rid, id, "D2", { repo: null });
    const r = await ctx.preflight.materialize(rid, id);
    const [t1, t2] = r.tasks;
    expect(t1.acceptanceCriteria!.filter((c) => c.quality).map((c) => c.quality!.id)).toEqual(["Q1", "Q2"]);
    expect(t1.acceptanceCriteria!.find((c) => c.quality?.id === "Q1")!.text).toBe("[Q1] lint が通る（検査: pnpm lint（成功: 終了コード 0））");
    expect(t1.acceptanceCriteria![0].quality).toBeUndefined(); // 案の固有の基準はそのまま
    expect(t2.acceptanceCriteria!.some((c) => c.quality)).toBe(false);
  });

  it("手元のエージェントの指示にも同じ品質基準を入れ、中の指示は実行しないと書く", async () => {
    const { ctx, rid } = await setup();
    const p = await ctx.preflight.prepare(rid);
    const text = readFileSync(p.instructions, "utf8");
    for (const s of ["このプロジェクトの品質基準", "Q1［全部の参照先］ lint が通る", "Q2［main］", "適用の除外: 対象外", "実行しないでください"]) expect(text).toContain(s);
    expect(localInstructions).toBeTypeOf("function");
  });
});

describe("直接作成と明示の取り込み", () => {
  it("作業先があれば当てはまるものを取り込み、none は取り込まず、作業先なしは明示したものだけ。同じ品質 ID は二重に足さない", async () => {
    const { ctx, rid } = await setup();
    const auto = (await createTask(ctx, rid, { title: "a", repo: "main", criteria: ["固有の条件"] })).task;
    expect(auto.acceptanceCriteria!.map((c) => [c.id, c.quality?.id ?? null])).toEqual([["A1", null], ["A2", "Q1"], ["A3", "Q2"]]);
    expect((await createTask(ctx, rid, { title: "b", repo: "main", quality: "none" })).task.acceptanceCriteria).toBeUndefined();
    expect((await createTask(ctx, rid, { title: "c", repo: null })).task.acceptanceCriteria).toBeUndefined();
    const explicit = (await createTask(ctx, rid, { title: "d", repo: null, quality: ["Q1"] })).task;
    expect(explicit.acceptanceCriteria!.map((c) => c.quality?.id)).toEqual(["Q1"]);
    await expect(createTask(ctx, rid, { title: "e", repo: null, quality: ["Q9"] })).rejects.toThrow(/Q9/);
    await expect(updateTask(ctx, rid, auto.id, { acceptance: [{ op: "add", text: "x", quality: { id: "Q1", hash: "h", version: "v" } }] })).rejects.toThrow(/取り込み済み/);
  });

  it("設定を変えてもタスクは変わらない。差分を明示して取り込むと、変わった条件の証拠は再確認・済みは外れる。消えた基準・除外も示す", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "a", repo: "main" });
    await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "pnpm lint 0" }, { op: "record", id: "A2", result: "met", evidence: "読んだ" }] });
    await updateTask(ctx, rid, task.id, { checked: true });
    const before = ctx.ws.tasksOf(rid).require(task.id);
    await updateQuality(ctx.ws, [
      { op: "edit", id: "Q1", standard: { check: { kind: "machine", command: "pnpm lint --max-warnings 0", success: "終了コード 0" } } },
      { op: "exempt", id: "Q2", reason: "やめた" },
      { op: "add", standard: { text: "新しい基準", check: { kind: "manual", reference: "r" } } },
    ]);
    expect(ctx.ws.tasksOf(rid).require(task.id).rev).toBe(before.rev);
    const diff = taskQualityDiff(before.acceptanceCriteria!, ctx.ws.project.quality, "main");
    expect(diff.map((d) => `${d.kind}:${d.quality}`)).toEqual(["change:Q1", "exempt:Q2", "add:Q4"]);
    const r = await importQuality(ctx, rid, task.id, ["change:Q1", "add:Q4"]);
    expect(r.checkCleared).toBeTruthy();
    const st = acceptanceStatus(r.task)!;
    expect(st.items.map((i) => [i.id, i.state])).toEqual([["A1", "stale"], ["A2", "met"], ["A3", "missing"]]);
    expect(r.task.acceptanceCriteria![0].quality!.version).toBe(ctx.ws.project.qualityVersion);
    await expect(importQuality(ctx, rid, task.id, ["add:Q9"])).rejects.toThrow(/取り込める差分にありません/);
    const rest = await importQuality(ctx, rid, task.id, undefined);
    expect(rest.applied).toEqual(["exempt:Q2"]);
    expect(taskQualityDiff(rest.task.acceptanceCriteria!, ctx.ws.project.quality, "main")).toEqual([]);
  });

  it("読めない出典は問題として知らせ（基準なしにしない）、API でも差分を読んで取り込める", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "a", repo: "main" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace(/quality:\n(\s+)id: Q1/, "quality:\n$1id: 1"));
    await ctx.ws.reloadAll();
    const broken = ctx.ws.tasksOf(rid).require(task.id);
    expect(broken.acceptanceProblems?.join("")).toMatch(/出典/);
    expect(acceptanceStatus(broken)).toBeTruthy();
    const { task: t2 } = await createTask(ctx, rid, { title: "b", repo: "main", quality: "none" });
    const app = apiRoutes(ctx);
    const d = (await (await app.request(`/requests/${rid}/tasks/${t2.id}/quality-diff`)).json()) as { diff: { kind: string; quality: string }[] };
    expect(d.diff.map((x) => `${x.kind}:${x.quality}`)).toEqual(["add:Q1", "add:Q2"]);
    const res = await app.request(`/requests/${rid}/tasks/${t2.id}/quality-import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: ["add:Q2"] }) });
    expect(((await res.json()) as { applied: string[] }).applied).toEqual(["add:Q2"]);
    const made = await app.request(`/requests/${rid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "c", repo: null, quality: ["Q1"] }) });
    expect(((await made.json()) as { acceptanceCriteria: { quality: { id: string } }[] }).acceptanceCriteria.map((c) => c.quality.id)).toEqual(["Q1"]);
  });
});
