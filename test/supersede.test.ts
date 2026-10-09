import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConflictError } from "../src/server/store/collection.ts";
import { supersededMarks } from "../src/server/supersede.ts";
import type { PreflightAssessment } from "../src/shared/types.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/**
 * 既存タスク T001〜T004 がある要望を再評価し、評価の impacts と案の relations に置き換えを書いた状態を作る。
 * Mock は置き換えを推論しないので、評価とタスク案のファイルを直接直す（ファイル契約は Codex と同じ）。
 */
async function setup() {
  const p = await makeProject();
  const { ctx } = p;
  const other = await newRequest(ctx, { title: "別の要望" });
  const otherTask = await newTask(ctx, other.id, { title: "別の要望のタスク" });
  const req = await newRequest(ctx, { title: "再評価する要望", status: "active", body: "- 新しい案 A\n- 新しい案 B" });
  for (const title of ["古い案 1", "古い案 2", "古い案 3"]) await newTask(ctx, req.id, { title });
  await newTask(ctx, req.id, { title: "完了済み", status: "done" });
  await ctx.ws.tasksOf(req.id).update("T002", { status: "doing" });

  const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
  await ctx.preflight.wait(req.id, id);
  const runFile = join(ctx.ws.preflight.runDir(req.id, id), "run.json");
  const editImpacts = (impacts: PreflightAssessment["impacts"]) => {
    const run = JSON.parse(readFileSync(runFile, "utf8"));
    run.assessment.impacts = impacts;
    writeFileSync(runFile, JSON.stringify(run));
  };
  const sup = (target: string, reason = "置き換え") => ({ target, type: "supersedes" as const, reason, confidence: 0.9 });
  editImpacts([
    sup(`${req.id}/T001`), // 評価だけ（絶対参照）
    sup(`${req.id}/T004`), // 完了済みは外す
    sup(`${req.id}/T009`), // 無いタスクは外す
    sup(otherTask.ref), // 別の要望は外す
    sup(req.id), // 要望そのものは外す
  ]);
  const rel = (target: string) => ({ type: "supersedes" as const, target, origin: "ai" as const, note: "案の置き換え" });
  await ctx.preflight.updateDraft(req.id, id, "D1", { relations: [rel("T002"), rel("T001")] }); // 相対参照・両方に出る T001
  await ctx.preflight.updateDraft(req.id, id, "D2", { relations: [rel("T003")], include: false }); // 不採用の案だけの関係
  return { ...p, req, other, runId: id };
}

describe("置き換えられるタスクの判定", () => {
  it("評価の impacts と採用案の relations から、同じ要望の未完了タスクだけを候補にする", async () => {
    const { ctx, req, runId } = await setup();
    const preview = await ctx.preflight.previewMaterialize(req.id, runId);
    expect(preview.include).toEqual(["D1"]);
    expect(preview.candidates.map((c) => [c.id, c.status, c.reasons.map((r) => r.source + (r.draft ?? ""))])).toEqual([
      ["T001", "todo", ["impact", "draftD1"]],
      ["T002", "doing", ["draftD1"]],
    ]);
    // 不採用を採用に戻すと候補が増える
    await ctx.preflight.updateDraft(req.id, runId, "D2", { include: true });
    expect((await ctx.preflight.previewMaterialize(req.id, runId)).candidates.map((c) => c.id)).toEqual(["T001", "T002", "T003"]);
    // プレビューはファイルを変えない
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
  });

  it("選ばなければ全部残し、印は保存済みの関係から出す（評価だけの置き換えは要望単位）", async () => {
    const { ctx, req, runId } = await setup();
    const r = await ctx.preflight.materialize(req.id, runId, "human:a");
    expect(r.tasks.map((t) => t.id)).toEqual(["T005"]);
    expect(r.archived).toEqual([]);
    expect(r.kept.map((c) => c.id)).toEqual(["T001", "T002"]);
    expect(ctx.ws.tasksOf(req.id).get("T005")?.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "supersedes", target: "T002" }), expect.objectContaining({ type: "supersedes", target: "T001" })]),
    );
    const marks = supersededMarks(ctx.ws);
    expect(marks.get(`${req.id}/T001`)?.map((m) => m.from)).toEqual([req.id, `${req.id}/T005`]);
    expect(marks.get(`${req.id}/T002`)?.map((m) => m.from)).toEqual([`${req.id}/T005`]);
    expect(marks.has(`${req.id}/T003`)).toBe(false); // 不採用の案だけにあった
  });

  it("選んだタスクだけをアーカイブする", async () => {
    const { ctx, req, runId } = await setup();
    const r = await ctx.preflight.materialize(req.id, runId, "human:a", { archive: [{ id: "T2", rev: 2 }] });
    expect(r.archived).toEqual(["T002"]);
    expect(r.kept.map((c) => c.id)).toEqual(["T001"]);
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T001", "T003", "T004", "T005"]);
    const run = await ctx.preflight.get(req.id, runId);
    expect(run?.materialization).toEqual({ created: { D1: "T005" }, archive: ["T002"], archived: ["T002"], done: true });
    await expect(ctx.preflight.materialize(req.id, runId)).rejects.toThrow("タスク化済み");
  });

  it("候補でないタスクや rev が変わったタスクを選ぶと、何も変えずに失敗する", async () => {
    const { ctx, req, runId } = await setup();
    await expect(ctx.preflight.materialize(req.id, runId, "a", { archive: [{ id: "T003" }] })).rejects.toThrow("候補ではありません");
    await ctx.ws.tasksOf(req.id).update("T001", { title: "誰かが直した" }); // プレビューの後に変わった
    await expect(ctx.preflight.materialize(req.id, runId, "a", { archive: [{ id: "T001", rev: 1 }] })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
    expect((await ctx.preflight.get(req.id, runId))?.materialized).toBeUndefined();
  });

  it("採用した案が無ければ失敗する", async () => {
    const { ctx, req, runId } = await setup();
    await ctx.preflight.updateDraft(req.id, runId, "D1", { include: false });
    await expect(ctx.preflight.materialize(req.id, runId)).rejects.toThrow("採用したタスク案がありません");
  });

  it("アーカイブの途中で失敗しても、やり直しでタスクを作り直さず、残りだけアーカイブする", async () => {
    const { ctx, req, runId, dataDir } = await setup();
    // T002 のアーカイブ先を塞いで、新しいタスクを作った後のアーカイブで失敗させる
    const archive = join(dataDir, "requests", req.id, "tasks", ".archive");
    await mkdir(archive, { recursive: true });
    writeFileSync(join(archive, "T002.md"), "塞ぐ");
    await expect(ctx.preflight.materialize(req.id, runId, "a", { archive: [{ id: "T001" }, { id: "T002" }] })).rejects.toThrow("上書きしません");
    // 古いタスクより先に新しいタスクができている
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T002", "T003", "T004", "T005"]);
    expect((await ctx.preflight.get(req.id, runId))?.materialization).toMatchObject({ archived: ["T001"], done: false });

    await rm(join(archive, "T002.md"));
    const r = await ctx.preflight.materialize(req.id, runId); // 同じ呼び出しでやり直す
    expect(r.tasks.map((t) => t.id)).toEqual(["T005"]);
    expect(r.archived).toEqual(["T001", "T002"]);
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T003", "T004", "T005"]);
  });
});
