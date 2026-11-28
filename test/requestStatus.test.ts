import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import type { PreflightEngine } from "../packages/tasks/src/core/preflight/engine.ts";
import { MockEngine } from "../packages/tasks/src/core/preflight/mockEngine.ts";
import { checkStatusChange, reopenIfNeeded, resolvedIssue, StatusRuleError } from "../packages/tasks/src/core/requestStatus.ts";
import { Workspace } from "../packages/tasks/src/core/store/workspace.ts";
import { makeProject, newRequest, newTask, openTestProject } from "./helpers.ts";

async function setup() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "要望", status: "active" });
  return { ...p, req, tasks: p.ctx.ws.tasksOf(req.id) };
}

describe("要望の対応済", () => {
  it("保存して読み直せる。既存のステータスもそのまま読める", async () => {
    const { ctx, dataDir, req } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await ctx.ws.requests.update(req.id, { status: "resolved" });
    const old = await newRequest(ctx, { title: "古い", status: "rejected" });
    const ws = new Workspace(dataDir);
    await ws.load();
    expect(ws.requests.get(req.id)?.status).toBe("resolved");
    expect(ws.requests.get(old.id)?.status).toBe("rejected");
  });

  it("全タスクが完了なら、人の済みが無くても対応済にできる", async () => {
    const { ctx, req } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await newTask(ctx, req.id, { title: "B", status: "done" });
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).resolves.toBeUndefined();
  });

  it("未完了・タスク無し・読めないタスクがあれば拒む。アーカイブしたものは数えない", async () => {
    const { ctx, req, tasks, dataDir } = await setup();
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("タスクがありません");
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await newTask(ctx, req.id, { title: "古い案", status: "todo" });
    await newTask(ctx, req.id, { title: "C", status: "done" });
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("T002(todo)");
    await tasks.archive("T002");
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).resolves.toBeUndefined();
    writeFileSync(join(dataDir, "requests", req.id, "tasks", "T009.md"), "---\n: [broken\n---\n");
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toBeInstanceOf(StatusRuleError);
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("読めないタスクファイル");
    await expect(checkStatusChange(ctx.ws, req.id, "done")).resolves.toBeUndefined(); // 対応済以外は確かめない
  });

  it("未完了のタスクができたら進行中に戻す。完了のタスクを足すだけでは戻さない。完了済・見送りは戻さない", async () => {
    const { ctx, req, tasks } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done" });
    const resolve = () => ctx.ws.requests.update(req.id, { status: "resolved" });
    await resolve();
    await newTask(ctx, req.id, { title: "完了で足す", status: "done" });
    expect(await reopenIfNeeded(ctx.ws, req.id)).toBe(false);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("resolved");

    await tasks.update("T001", { status: "doing" }); // 完了から戻した
    expect(resolvedIssue(ctx.ws, ctx.ws.requests.get(req.id)!)).toContain("T001");
    expect(await reopenIfNeeded(ctx.ws, req.id, "ai:x")).toBe(true);
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "active", updatedBy: "ai:x" });

    await ctx.ws.requests.update(req.id, { status: "done" });
    await newTask(ctx, req.id, { title: "完了済の後" });
    expect(await reopenIfNeeded(ctx.ws, req.id)).toBe(false);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("done");
  });

  it("実行中に変えたステータスを、終わったときに上書きしない（タスク化した後の要望は再評価しない: test/preflightClosed.test.ts）", async () => {
    const { ctx } = await setup();
    // 実行中に人が見送りにした
    let release!: () => void;
    const slow: PreflightEngine = {
      name: "codex",
      status: async () => ({ name: "codex", ok: true, detail: "" }),
      run: () => new Promise((_, reject) => (release = () => reject(new Error("落ちた")))),
    };
    const ctx2 = await openTestProject(ctx.ws.dataDir, { mock: new MockEngine({ delay: 0 }), codex: slow });
    const draft = await newRequest(ctx2, { title: "初めての評価", status: "draft" });
    const run = await ctx2.preflight.start(draft.id, { engine: "codex" });
    expect(ctx2.ws.requests.get(draft.id)?.status).toBe("preflight");
    await ctx2.ws.requests.update(draft.id, { status: "rejected" });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await ctx2.preflight.wait(draft.id, run.id);
    expect(ctx2.ws.requests.get(draft.id)?.status).toBe("rejected");
  });
});

describe("対応済の API", () => {
  it("条件を満たさなければ 400 で何も変えず、満たせば対応済。未完了のタスクを足すと進行中に戻し reopened を返す", async () => {
    const { ctx, req } = await setup();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    await newTask(ctx, req.id, { title: "A" });
    const before = ctx.ws.requests.get(req.id)!;
    const ng = await call("PATCH", `/requests/${req.id}`, { status: "resolved" });
    expect(ng.status).toBe(400);
    expect(ng.body.error).toContain("T001(todo)");
    expect(ctx.ws.requests.get(req.id)).toMatchObject({ status: "active", rev: before.rev });

    await call("PATCH", `/requests/${req.id}/tasks/T001`, { status: "done" });
    expect((await call("PATCH", `/requests/${req.id}`, { status: "resolved", rev: before.rev })).body.status).toBe("resolved");
    expect((await call("GET", `/requests/${req.id}`)).body.issue).toBeNull();
    const added = await call("POST", `/requests/${req.id}/tasks`, { title: "追加" });
    expect(added.body.reopened).toBe(req.id);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("active");
  });
});
