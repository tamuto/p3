import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../src/shared/types.ts";
import { archiveTask, createRequest, createTask, OpRuleError, updateRequest, updateTask } from "../src/core/requestOps.ts";
import { StatusRuleError } from "../src/core/requestStatus.ts";
import { RepoTargetError } from "../src/core/workTargets.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/** 要望・タスクの変更の手順（CLI と API が同じものを呼ぶ） */
async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "最初" }] });
  const events: ServerEvent[] = [];
  p.ctx.ws.on((e) => events.push(e));
  const req = await newRequest(p.ctx, { title: "要望", status: "active" });
  return { ...p, events, rid: req.id };
}

describe("タスクの作成", () => {
  it("作業先を省くと既定（作業先にできる参照先が1つならそれ）で、ブランチを割り当て、変更を通知する", async () => {
    const { ctx, rid, events } = await setup();
    const { task, reopened } = await createTask(ctx, rid, { title: "A" }, "ai:test");
    expect(task).toMatchObject({ title: "A", status: "todo", repo: "main", updatedBy: "ai:test" });
    expect(reopened).toBeUndefined();
    expect(ctx.ws.requests.require(rid).workstreams).toEqual({ main: { branch: expect.stringContaining(rid) } });
    expect(events).toContainEqual({ type: "changed", kind: "task", request: rid, ref: task.ref });
  });

  it("作業先なし（null）はブランチを割り当てない。作業先にできない参照先は何も書かずに断る", async () => {
    const { ctx, rid } = await setup();
    expect((await createTask(ctx, rid, { title: "調査", repo: null })).task.repo).toBeNull();
    expect(ctx.ws.requests.require(rid).workstreams).toBeUndefined();
    await expect(createTask(ctx, rid, { title: "B", repo: "nope" })).rejects.toBeInstanceOf(RepoTargetError);
    await expect(createTask(ctx, rid, { title: "B", repoOutputs: [{ repo: "nope", output: "x" }] })).rejects.toBeInstanceOf(RepoTargetError);
    expect(ctx.ws.tasksOf(rid).list().map((t) => t.title)).toEqual(["調査"]);
  });

  it("対応済の要望に未完了のタスクを足すと進行中に戻し、戻したことを返す", async () => {
    const { ctx, rid, events } = await setup();
    const t = await newTask(ctx, rid, { title: "A", status: "done" });
    await updateRequest(ctx, rid, { status: "resolved" });
    const { reopened } = await createTask(ctx, rid, { title: "追加" });
    expect(reopened).toBe(rid);
    expect(ctx.ws.requests.require(rid).status).toBe("active");
    expect(events).toContainEqual({ type: "changed", kind: "request", request: rid, ref: undefined });
    expect(t.status).toBe("done");
  });
});

describe("タスクの更新", () => {
  it("済みは完了したタスクだけ（同じ更新で完了にするのはよい）。外すのはいつでも", async () => {
    const { ctx, rid } = await setup();
    const t = await newTask(ctx, rid, { title: "A" });
    await expect(updateTask(ctx, rid, t.id, { checked: true })).rejects.toBeInstanceOf(OpRuleError);
    expect(ctx.ws.tasksOf(rid).require(t.id).rev).toBe(1);
    const done = await updateTask(ctx, rid, t.id, { status: "done", checked: true });
    expect(done.task.checkedAt).toEqual(expect.any(String));
    expect((await updateTask(ctx, rid, t.id, { checked: false })).task.checkedAt).toBeUndefined();
  });

  it("置き換えられたタスクを作業中にすると警告を返し、変更はする。完了から戻すと対応済の要望を進行中に戻す", async () => {
    const { ctx, rid } = await setup();
    const old = await newTask(ctx, rid, { title: "古い", status: "done" });
    await newTask(ctx, rid, { title: "新しい", status: "done", relations: [{ type: "supersedes", target: old.id }] });
    await updateRequest(ctx, rid, { status: "resolved" });
    const r = await updateTask(ctx, rid, old.id, { status: "doing" });
    expect(r.task.status).toBe("doing");
    expect(r.warnings.map((w) => w.code)).toEqual(["superseded"]);
    expect(r.reopened).toBe(rid);
  });

  it("作業先を変えるとブランチを割り当てる。古い rev では何も書かない", async () => {
    const { ctx, rid } = await setup();
    const t = await newTask(ctx, rid, { title: "A", repo: null });
    await expect(updateTask(ctx, rid, t.id, { title: "x" }, { expectedRev: 9 })).rejects.toThrow("rev conflict");
    await updateTask(ctx, rid, t.id, { repo: "main" }, { expectedRev: 1 });
    expect(ctx.ws.requests.require(rid).workstreams?.main).toBeDefined();
  });

  it("アーカイブは変更を通知する", async () => {
    const { ctx, rid, events } = await setup();
    const t = await newTask(ctx, rid, { title: "A" });
    await archiveTask(ctx, rid, t.id);
    expect(ctx.ws.tasksOf(rid).get(t.id)).toBeUndefined();
    expect(events).toContainEqual({ type: "changed", kind: "task", request: rid, ref: t.ref });
  });
});

describe("要望の作成と更新", () => {
  it("作るときは下書き。マイルストーンは project.yaml にあるものだけ", async () => {
    const { ctx } = await setup();
    expect(await createRequest(ctx, { title: "新しい", milestone: "v1", status: "active" })).toMatchObject({ status: "draft", milestone: "v1", body: "", tags: [] });
    await expect(createRequest(ctx, { title: "x", milestone: "nope" })).rejects.toThrow(/マイルストーンがありません: nope/);
  });

  it("対応済にできるのは全タスクが完了のときだけ（何も書かない）", async () => {
    const { ctx, rid } = await setup();
    await newTask(ctx, rid, { title: "A" });
    const rev = ctx.ws.requests.require(rid).rev;
    await expect(updateRequest(ctx, rid, { status: "resolved" })).rejects.toBeInstanceOf(StatusRuleError);
    await expect(updateRequest(ctx, rid, { milestone: "nope" })).rejects.toBeInstanceOf(OpRuleError);
    expect(ctx.ws.requests.require(rid).rev).toBe(rev);
  });
});
