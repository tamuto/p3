import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { updateQuality } from "../packages/tasks/src/features/quality/core/quality.ts";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest } from "./helpers.ts";

/**
 * 品質基準を Preflight とタスクの受け入れ基準へつなぐ: Preflight の指示に今の基準を入れる、タスク化・直接作成で作業先に当てはまる
 * ものを品質 ID つきで足す（参照先の指定が無い基準は作業先なしにも足す・二重に足さない）、設定を変えても既にあるタスクは変えない、
 * 読めない設定ではタスクを作らない、以前の版の取り込みの出典（hash・version）は ID だけ読む
 */

async function setup() {
  const p = await makeProject();
  await updateQuality(p.ctx.ws, [
    { op: "add", standard: { text: "lint が通る", how: "pnpm lint（成功: 終了コード 0）" } },
    { op: "add", standard: { text: "main だけの規約", repos: ["main"], how: "規約" } },
  ]);
  const req = await newRequest(p.ctx, { title: "通知", status: "draft", body: "- 送る\n- 記録する" });
  return { ...p, rid: req.id };
}
const qualityIds = (t: { acceptanceCriteria?: { quality?: { id: string } }[] }) => (t.acceptanceCriteria ?? []).filter((c) => c.quality).map((c) => c.quality!.id);

describe("Preflight", () => {
  it("指示に今の品質基準と確かめ方を入れ、中の指示は実行しないと書く。タスク化で作業先に当てはまる基準を足す（作業先なしには全参照先の基準だけ）", async () => {
    const { ctx, rid } = await setup();
    const local = await newRequest(ctx, { title: "手元", status: "draft", body: "- 一" });
    const p = await ctx.preflight.prepare(local.id);
    const text = readFileSync(p.instructions, "utf8");
    for (const s of ["このプロジェクトの品質基準", "Q1［全部の参照先］ lint が通る（確かめ方: pnpm lint（成功: 終了コード 0））", "Q2［main］", "実行しないでください"]) expect(text).toContain(s);

    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    await ctx.preflight.wait(rid, id);
    await ctx.preflight.updateDraft(rid, id, "D2", { repo: null });
    const [t1, t2] = (await ctx.preflight.materialize(rid, id)).tasks;
    expect(qualityIds(t1)).toEqual(["Q1", "Q2"]);
    expect(t1.acceptanceCriteria!.find((c) => c.quality?.id === "Q1")!.text).toBe("[Q1] lint が通る（pnpm lint（成功: 終了コード 0））");
    expect(t1.acceptanceCriteria![0].quality).toBeUndefined(); // 案の固有の基準はそのまま
    expect(qualityIds(t2)).toEqual(["Q1"]);
  });

  it("品質基準の設定が読めなければタスク化を断り、タスクを作らない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    await ctx.preflight.wait(rid, id);
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("id: Q2", "id: 壊れた"));
    await ctx.ws.reloadAll();
    await expect(ctx.preflight.materialize(rid, id)).rejects.toMatchObject({ code: "quality_unreadable" });
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(0);
  });
});

describe("直接作成", () => {
  it("作業先に当てはまる基準を足し、作業先なしには全参照先の基準だけ。同じ品質 ID は二重に足さない。設定を変えても既にあるタスクは変えない", async () => {
    const { ctx, rid } = await setup();
    const auto = (await createTask(ctx, rid, { title: "a", repo: "main", criteria: ["固有の条件"] })).task;
    expect(auto.acceptanceCriteria!.map((c) => [c.id, c.quality?.id ?? null])).toEqual([["A1", null], ["A2", "Q1"], ["A3", "Q2"]]);
    expect(qualityIds((await createTask(ctx, rid, { title: "c", repo: null })).task)).toEqual(["Q1"]);
    await expect(updateTask(ctx, rid, auto.id, { acceptance: [{ op: "add", text: "x", quality: { id: "Q1" } }] })).rejects.toThrow(/取り込み済み/);
    await updateQuality(ctx.ws, [{ op: "edit", id: "Q1", standard: { text: "lint が警告なしで通る" } }, { op: "add", standard: { text: "新しい" } }]);
    const after = ctx.ws.tasksOf(rid).require(auto.id);
    expect([after.rev, qualityIds(after)]).toEqual([auto.rev, ["Q1", "Q2"]]);
  });

  it("設定が読めなければ作らない（CLI・API と同じ core）。API の作成も同じ基準を足す", async () => {
    const { ctx, rid, dataDir } = await setup();
    const app = apiRoutes(ctx);
    const made = await app.request(`/requests/${rid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "c", repo: null }) });
    expect(qualityIds((await made.json()) as { acceptanceCriteria: { quality: { id: string } }[] })).toEqual(["Q1"]);
    const file = join(dataDir, "project.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("id: Q2", "id: 壊れた"));
    await ctx.ws.reloadAll();
    const before = ctx.ws.tasksOf(rid).list().length;
    await expect(createTask(ctx, rid, { title: "d", repo: "main" })).rejects.toMatchObject({ code: "quality_unreadable" });
    const refused = await app.request(`/requests/${rid}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "e" }) });
    expect(refused.status).toBe(400);
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(before);
  });

  it("以前の版の取り込みの出典（hash・version つき）は ID だけ読み、無関係な更新でも消さない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "a", repo: "main" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace(/quality:\n(\s+)id: Q1/, "quality:\n$1id: Q1\n$1hash: abc\n$1version: v1"));
    await ctx.ws.reloadAll();
    const legacy = ctx.ws.tasksOf(rid).require(task.id);
    expect([legacy.acceptanceProblems, legacy.acceptanceCriteria![0].quality]).toEqual([undefined, { id: "Q1" }]);
    await updateTask(ctx, rid, task.id, { labels: ["x"] });
    expect(qualityIds(ctx.ws.tasksOf(rid).require(task.id))).toEqual(["Q1", "Q2"]);
  });
});
