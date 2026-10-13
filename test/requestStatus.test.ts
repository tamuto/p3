import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { PreflightEngine } from "../src/core/preflight/engine.ts";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import { checkStatusChange, reopenIfNeeded, resolvedIssue, StatusRuleError } from "../src/core/requestStatus.ts";
import { Workspace } from "../src/core/store/workspace.ts";
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

  it("未完了・タスク無し・読めないタスクがあれば拒む。置き換えられて残したタスクも数え、アーカイブしたものは数えない", async () => {
    const { ctx, req, tasks, dataDir } = await setup();
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("タスクがありません");
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await newTask(ctx, req.id, { title: "古い案（置き換えられて残した）", status: "todo" });
    await newTask(ctx, req.id, { title: "C", status: "done", relations: [{ type: "supersedes", target: "T002" }] });
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("T002(todo)");
    await tasks.archive("T002");
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).resolves.toBeUndefined();
    writeFileSync(join(dataDir, "requests", req.id, "tasks", "T009.md"), "---\n: [broken\n---\n");
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toBeInstanceOf(StatusRuleError);
    await expect(checkStatusChange(ctx.ws, req.id, "resolved")).rejects.toThrow("読めないタスクファイル");
    await expect(checkStatusChange(ctx.ws, req.id, "done")).resolves.toBeUndefined(); // 対応済以外は確かめない
  });

  it("未完了のタスクができたら進行中に戻す。完了のタスクを足す・済みを外すだけでは戻さない。完了済・見送りは戻さない", async () => {
    const { ctx, req, tasks } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done", checkedAt: "2026-10-10T00:00:00Z" });
    const resolve = () => ctx.ws.requests.update(req.id, { status: "resolved" });
    await resolve();
    await newTask(ctx, req.id, { title: "完了で足す", status: "done" });
    await tasks.update("T001", { checkedAt: undefined });
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

  it("再評価では対応済のままにし、実行中に変えたステータスを終わったときに上書きしない", async () => {
    const { ctx, req } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await ctx.ws.requests.update(req.id, { status: "resolved" });
    const ok = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, ok.id);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("resolved");

    // 実行中に人が完了済にした
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

  it("再評価のタスク化では進行中に戻す", async () => {
    const { ctx, req } = await setup();
    await newTask(ctx, req.id, { title: "A", status: "done" });
    await ctx.ws.requests.update(req.id, { status: "resolved", body: "- 追加の作業" });
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    await ctx.preflight.materialize(req.id, id);
    expect(ctx.ws.requests.get(req.id)?.status).toBe("active");
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
