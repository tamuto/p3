import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

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
  const req = await newRequest(p.ctx, { title: "要望" });
  return { ...p, call, rid: req.id };
}

describe("REST API", () => {
  it("要望を作るとフォルダごとの ID が振られ、一覧は進捗つきで返る", async () => {
    const { call } = await setup();
    const created = await call("POST", "/requests", { title: "新しい要望", body: "本文" }, { "x-pcube-actor": "human:a" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "新しい要望", status: "draft", updatedBy: "human:a" });
    const list = await call("GET", "/requests");
    expect(list.body.map((p: any) => p.request.id)).toContain(created.body.id);
    expect(list.body[0]).toMatchObject({ total: 0, done: 0, counts: { todo: 0, doing: 0, done: 0 } });
  });

  it("タスクは要望の中に作り、null で項目を消し、T3 / 3 でも指せる", async () => {
    const { call, rid } = await setup();
    const created = await call("POST", `/requests/${rid}/tasks`, { title: "A", due: "2026-10-20" }, { "x-pcube-actor": "ai:claude" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "T001", ref: `${rid}/T001`, status: "todo", updatedBy: "ai:claude" });
    const patched = await call("PATCH", `/requests/${rid}/tasks/1`, { due: null, outputs: ["https://example.com/pull/1"], rev: 1 });
    expect(patched.body.due).toBeUndefined();
    expect(patched.body.outputs).toEqual(["https://example.com/pull/1"]);
    expect((await call("GET", `/requests/${rid}/tasks/T1`)).body.task.title).toBe("A");
  });

  it("古い rev での更新は 409 と最新状態を返す", async () => {
    const { call, rid } = await setup();
    await call("POST", `/requests/${rid}/tasks`, { title: "A" });
    await call("PATCH", `/requests/${rid}/tasks/T001`, { status: "doing", rev: 1 });
    const stale = await call("PATCH", `/requests/${rid}/tasks/T001`, { status: "done" }, { "if-match": "1" });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ status: "doing", rev: 2 });
  });

  it("入力の検証に失敗したら 400、無い要望・タスクは 404", async () => {
    const { call, rid } = await setup();
    expect((await call("POST", `/requests/${rid}/tasks`, { title: "" })).status).toBe(400);
    expect((await call("POST", `/requests/${rid}/tasks`, { title: "A", due: "10/8" })).status).toBe(400);
    expect((await call("GET", `/requests/${rid}/tasks/T404`)).status).toBe(404);
    expect((await call("GET", "/requests/261001-nopee")).status).toBe(404);
  });

  it("関係は相対・絶対参照で張れ、循環は 400 で拒む。resolve は今の要望を優先する", async () => {
    const { call, ctx, rid } = await setup();
    const other = await newRequest(ctx, { title: "別の要望" });
    await newTask(ctx, rid, { title: "ガント", status: "doing" });
    await newTask(ctx, rid, { title: "かんばん" });
    await newTask(ctx, other.id, { title: "かんばんの色" });
    expect((await call("POST", `/requests/${rid}/tasks/T001/relations`, { type: "depends_on", target: "T002" })).status).toBe(200);
    const cycle = await call("POST", `/requests/${rid}/tasks/T002/relations`, { type: "depends_on", target: "T001" });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error).toContain("循環");
    const cross = await call("POST", `/requests/${rid}/tasks/T002/relations`, { type: "impacts", target: `${other.id}/T001` });
    expect(cross.body.relations).toEqual([{ type: "impacts", target: `${other.id}/T001`, origin: "human" }]);
    expect((await call("GET", `/requests/${rid}/tasks/T002`)).body.graph.incoming).toHaveLength(1);
    expect((await call("GET", `/requests/${rid}/tasks?status=doing`)).body.map((t: any) => t.id)).toEqual(["T001"]);
    const found = await call("GET", `/resolve?q=${encodeURIComponent("かんばん")}&request=${rid}`);
    expect(found.body.candidates[0].ref).toBe(`${rid}/T002`);
    const del = await call("DELETE", `/requests/${rid}/tasks/T001/relations?type=depends_on&target=T002`);
    expect(del.body.relations).toEqual([]);
  });

  it("プロジェクト設定: 使用中のステータスは消せず、重複を拒む", async () => {
    const { call, ctx, rid } = await setup();
    await newTask(ctx, rid, { title: "A", status: "doing" });
    const orphan = await call("PUT", "/project", { statuses: [{ id: "todo", label: "未着手" }] });
    expect(orphan.status).toBe(400);
    expect(orphan.body.error).toContain("doing");
    const dup = await call("PUT", "/project", { statuses: [{ id: "doing", label: "a" }, { id: "doing", label: "b" }] });
    expect(dup.status).toBe(400);
    const ok = await call("PUT", "/project", { name: "新しい名前", docs: ["docs"] });
    expect(ok.body).toMatchObject({ name: "新しい名前", docs: ["docs"] });
  });

  it("Preflight を API から実行し、案を直してタスク化する", async () => {
    const { call, ctx } = await setup();
    const rid = (await call("POST", "/requests", { title: "Export", body: "- CSV\n- ボタン" })).body.id;
    const started = await call("POST", `/requests/${rid}/preflight`, { engine: "mock" });
    expect(started.status).toBe(202);
    await ctx.preflight.wait(rid, started.body.id);
    expect((await call("GET", `/requests/${rid}/preflight/${started.body.id}`)).body.status).toBe("completed");
    await call("PATCH", `/requests/${rid}/preflight/${started.body.id}/drafts/D2`, { include: false });
    const tasks = await call("POST", `/requests/${rid}/preflight/${started.body.id}/materialize`);
    expect(tasks.body.map((t: any) => [t.id, t.title])).toEqual([["T001", "CSV"]]);
    const detail = await call("GET", `/requests/${rid}`);
    expect(detail.body.request.status).toBe("active");
    expect(detail.body.tasks).toHaveLength(1);
    expect(detail.body.runs).toHaveLength(1);
  });
});
