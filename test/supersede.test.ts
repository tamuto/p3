import { writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { supersededMarks } from "../src/core/supersede.ts";
import type { SupersedeCandidate } from "../src/shared/types.ts";
import { archiveSelection, markText, warningText } from "../src/web/lib/supersede.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/**
 * 既存タスク T001〜T004 がある要望を再評価し、案の supersedes に置き換えを書いた状態を作る。
 * Mock は置き換えを推論しないので、評価とタスク案のファイルを直接直す（ファイル契約は Codex と同じ）。
 */
async function setup() {
  const p = await makeProject();
  const { ctx } = p;
  const other = await newRequest(ctx, { title: "別の要望" });

  const req = await newRequest(ctx, { title: "再評価する要望", status: "active", body: "- 新しい案 A\n- 新しい案 B" });
  for (const title of ["古い案 1", "古い案 2", "古い案 3"]) await newTask(ctx, req.id, { title });
  await newTask(ctx, req.id, { title: "完了済み", status: "done" });
  await ctx.ws.tasksOf(req.id).update("T002", { status: "doing" });

  const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
  await ctx.preflight.wait(req.id, id);
  // 採用する D1 は T002・T001・完了済みの T004・無い T009 を置き換えると書き、不採用の D2 は T003
  await ctx.preflight.updateDraft(req.id, id, "D1", { supersedes: ["T002", "T1", "T004", "T009"] });
  await ctx.preflight.updateDraft(req.id, id, "D2", { supersedes: ["T003"], include: false });
  return { ...p, req, other, runId: id };
}

describe("置き換えられるタスクの判定", () => {
  it("採用案の supersedes から、同じ要望の今ある未完了タスクだけを候補にする", async () => {
    const { ctx, req, runId } = await setup();
    const preview = await ctx.preflight.previewMaterialize(req.id, runId);
    expect(preview.include).toEqual(["D1"]);
    expect(preview.candidates.map((c) => [c.id, c.status, c.reasons.map((r) => r.draft)])).toEqual([
      ["T001", "todo", ["D1"]],
      ["T002", "doing", ["D1"]],
    ]);
    // 不採用を採用に戻すと候補が増える
    await ctx.preflight.updateDraft(req.id, runId, "D2", { include: true });
    expect((await ctx.preflight.previewMaterialize(req.id, runId)).candidates.map((c) => c.id)).toEqual(["T001", "T002", "T003"]);
    // プレビューはファイルを変えない
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
  });

  it("選ばなければ全部残し、印は保存済みの関係から出す", async () => {
    const { ctx, req, runId } = await setup();
    const r = await ctx.preflight.materialize(req.id, runId, "human:a");
    expect(r.tasks.map((t) => t.id)).toEqual(["T005"]);
    expect(r.archived).toEqual([]);
    expect(r.kept.map((c) => c.id)).toEqual(["T001", "T002"]);
    expect(ctx.ws.tasksOf(req.id).get("T005")?.relations).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "supersedes", target: "T002" }), expect.objectContaining({ type: "supersedes", target: "T001" })]),
    );
    const marks = supersededMarks(ctx.ws);
    expect(marks.get(`${req.id}/T001`)?.map((m) => m.from)).toEqual([`${req.id}/T005`]);
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
    expect(run?.materialization).toEqual({ created: { D1: "T005" }, archive: ["T002"], archived: ["T002"], done: true, workstreams: expect.any(Object) });
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

describe("置き換えの API", () => {
  async function withApi() {
    const p = await setup();
    const app = apiRoutes(p.ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { ...p, call, base: `/requests/${p.req.id}/preflight/${p.runId}/materialize` };
  }

  it("確認は何も変えず、選んだものだけアーカイブし、印と着手の警告を返す", async () => {
    const { call, base, req } = await withApi();
    const preview = await call("GET", base);
    expect(preview.body.candidates.map((c: any) => c.id)).toEqual(["T001", "T002"]);
    expect((await call("GET", `/requests/${req.id}`)).body.tasks).toHaveLength(4);

    const r = await call("POST", base, { archive: [{ id: "T002", rev: preview.body.candidates[1].rev }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ tasks: [{ id: "T005" }], archived: ["T002"], kept: [{ id: "T001" }] });

    const detail = (await call("GET", `/requests/${req.id}`)).body;
    expect(Object.keys(detail.superseded).sort()).toEqual(["T001", "T004"]); // 完了済みにも印は出る（画面では出さない）。アーカイブした T002 には出さない
    expect((await call("GET", `/requests/${req.id}/tasks/T001`)).body.superseded.map((m: any) => m.from)).toEqual([`${req.id}/T005`]);
    const moved = await call("PATCH", `/requests/${req.id}/tasks/T001`, { status: "doing" });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ status: "doing", warnings: [{ code: "superseded" }] });
    expect((await call("PATCH", `/requests/${req.id}/tasks/T005`, { status: "doing" })).body.warnings).toBeUndefined();
  });

  it("全部選ぶ・何も選ばない・候補外・変わった rev", async () => {
    const all = await withApi();
    const cs = (await all.call("GET", all.base)).body.candidates;
    expect((await all.call("POST", all.base, { archive: cs.map((c: any) => ({ id: c.id, rev: c.rev })) })).body.archived).toEqual(["T001", "T002"]);

    const none = await withApi();
    expect((await none.call("POST", none.base, {})).body).toMatchObject({ archived: [], kept: [{ id: "T001" }, { id: "T002" }] });

    const bad = await withApi();
    expect((await bad.call("POST", bad.base, { archive: [{ id: "T003" }] })).status).toBe(400);
    await bad.ctx.ws.tasksOf(bad.req.id).update("T001", { title: "変わった" });
    const conflict = await bad.call("POST", bad.base, { archive: [{ id: "T001", rev: 1 }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.current).toMatchObject({ id: "T001", title: "変わった" });
  });
});

describe("画面の置き換えの表示と選択", () => {
  const cand = (id: string, rev: number): SupersedeCandidate => ({ id, ref: `r/${id}`, title: id, status: "todo", rev, reasons: [] });

  it("印の文言は同じ要望の中を短く", () => {
    expect(markText([{ from: "r/T005" }, { from: "r/T006" }], "r")).toBe("置き換え ← T005, T006");
    expect(markText(undefined, "r")).toBe("");
  });

  it("送るのは今の候補にある選択だけで、候補として見た rev をつける", () => {
    expect(archiveSelection([cand("T001", 3), cand("T002", 1)], new Set(["T002", "T009"]))).toEqual([{ id: "T002", rev: 1 }]);
    expect(archiveSelection([], new Set(["T001"]))).toEqual([]);
  });

  it("応答の警告を文言にする", () => {
    expect(warningText({ warnings: [{ message: "a" }, { message: "b" }] })).toBe("a / b");
    expect(warningText({})).toBe("");
  });
});
