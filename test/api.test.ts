import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newTask } from "./helpers.ts";

async function setup() {
  const p = await makeProject();
  const app = apiRoutes(p.ctx);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...p, call };
}

describe("REST API", () => {
  it("タスクを作り、変更者をヘッダから記録し、null で項目を消す", async () => {
    const { call } = await setup();
    const created = await call("POST", "/tasks", { title: "A", estimate: 2, assignee: "x" }, { "x-pcube-actor": "ai:claude" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "TASK-0001", status: "backlog", updatedBy: "ai:claude" });
    const patched = await call("PATCH", "/tasks/TASK-0001", { assignee: null, progress: 50, rev: 1 });
    expect(patched.body.assignee).toBeUndefined();
    expect(patched.body.progress).toBe(50);
  });

  it("古い rev での更新は 409 と最新状態を返す", async () => {
    const { call } = await setup();
    await call("POST", "/tasks", { title: "A" });
    await call("PATCH", "/tasks/TASK-0001", { status: "ready", rev: 1 });
    const stale = await call("PATCH", "/tasks/TASK-0001", { status: "done" }, { "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ status: "ready", rev: 2 });
  });

  it("入力の検証に失敗したら 400、無い ID は 404", async () => {
    const { call } = await setup();
    expect((await call("POST", "/tasks", { title: "" })).status).toBe(400);
    expect((await call("POST", "/tasks", { title: "A", due: "10/8" })).status).toBe(400);
    expect((await call("GET", "/tasks/TASK-0404")).status).toBe(404);
  });

  it("関係の追加は循環を 400 で拒み、一覧の絞り込みと resolve が使える", async () => {
    const { call, ctx } = await setup();
    await newTask(ctx, { title: "ガント", status: "ready" });
    await newTask(ctx, { title: "かんばん" });
    expect((await call("POST", "/tasks/TASK-0001/relations", { type: "depends_on", target: "TASK-0002" })).status).toBe(200);
    const cycle = await call("POST", "/tasks/TASK-0002/relations", { type: "depends_on", target: "TASK-0001" });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toContain("循環");
    const detail = await call("GET", "/tasks/TASK-0002");
    expect(detail.body.graph.incoming).toHaveLength(1);
    expect((await call("GET", "/tasks?status=ready")).body.map((t: any) => t.id)).toEqual(["TASK-0001"]);
    expect((await call("GET", `/resolve?q=${encodeURIComponent("かんばん")}`)).body.match).toBe("TASK-0002");
    const del = await call("DELETE", "/tasks/TASK-0001/relations?type=depends_on&target=TASK-0002");
    expect(del.body.relations).toEqual([]);
  });

  it("プロジェクト設定: 使用中のステータスは消せず、メンバーの重複を拒む", async () => {
    const { call, ctx } = await setup();
    await newTask(ctx, { title: "A", status: "ready" });
    const orphan = await call("PUT", "/project", { statuses: [{ id: "backlog", label: "B" }] });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error).toContain("ready");
    const dup = await call("PUT", "/project", {
      members: [
        { id: "a", name: "A", kind: "human" },
        { id: "a", name: "B", kind: "human" },
      ],
    });
    expect(dup.status).toBe(400);
    const ok = await call("PUT", "/project", { name: "新しい名前", docs: ["docs"], members: [{ id: "a", name: "A", kind: "ai" }] });
    expect(ok.body).toMatchObject({ name: "新しい名前", docs: ["docs"] });
    expect((await call("GET", "/project")).body.project.members[0].kind).toBe("ai");
  });

  it("Preflight を API から実行し、案を直してタスク化する", async () => {
    const { call, ctx } = await setup();
    await call("POST", "/requests", { title: "Export", body: "- CSV\n- ボタン" });
    const started = await call("POST", "/requests/REQ-0001/preflight", { engine: "mock" });
    expect(started.status).toBe(202);
    await ctx.preflight.wait("REQ-0001", started.body.id);
    const run = await call("GET", `/requests/REQ-0001/preflight/${started.body.id}`);
    expect(run.body.status).toBe("completed");
    await call("PATCH", `/requests/REQ-0001/preflight/${started.body.id}/drafts/T2`, { include: false });
    const tasks = await call("POST", `/requests/REQ-0001/preflight/${started.body.id}/materialize`);
    expect(tasks.body.map((t: any) => t.title)).toEqual(["CSV"]);
    const detail = await call("GET", "/requests/REQ-0001");
    expect(detail.body.request.status).toBe("accepted");
    expect(detail.body.tasks).toHaveLength(1);
  });
});
