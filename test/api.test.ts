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
    const created = await call("POST", `/requests/${rid}/tasks`, { title: "A", labels: ["x"] }, { "x-pcube-actor": "ai:claude" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "T001", ref: `${rid}/T001`, status: "todo", updatedBy: "ai:claude" });
    const patched = await call("PATCH", `/requests/${rid}/tasks/1`, { labels: [], outputs: ["https://example.com/pull/1"], rev: 1 });
    expect(patched.body.labels).toEqual([]);
    expect(patched.body.outputs).toEqual(["https://example.com/pull/1"]);
    expect((await call("GET", `/requests/${rid}/tasks/T1`)).body.task.title).toBe("A");
  });

  it("メモを書き足して Preflight を実行する。実行できなくてもメモは残し、その ID を返す", async () => {
    const { call, rid, ctx } = await setup();
    const note = await call("POST", `/requests/${rid}/notes`, { body: "Web は不要" }, { "x-pcube-actor": "human:a" });
    expect(note.status).toBe(201);
    expect(note.body).toMatchObject({ body: "Web は不要", createdBy: "human:a" });
    expect((await call("POST", `/requests/${rid}/notes`, { body: " " })).status).toBe(400);
    expect((await call("GET", `/requests/${rid}/notes`)).body).toMatchObject({ notes: [{ id: note.body.id, pending: true }], previous: null });

    const started = await call("POST", `/requests/${rid}/preflight`, { engine: "mock", note: "CLI だけ" });
    expect(started.status).toBe(202);
    expect(started.body.notes).toHaveLength(2);
    // 実行中にもう一度: 始められないが、メモは保存済みで ID が返る
    const busy = await call("POST", `/requests/${rid}/preflight`, { engine: "mock", note: "追加" });
    expect(busy.status).toBe(400);
    expect(busy.body).toMatchObject({ error: expect.stringContaining("実行中"), note: { body: "追加" } });
    await ctx.preflight.wait(rid, started.body.id);
    const listed = (await call("GET", `/requests/${rid}/notes`)).body;
    expect(listed.previous).toBe(started.body.id);
    expect(listed.notes.map((n: any) => n.pending)).toEqual([false, false, true]);
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
    expect((await call("PATCH", `/requests/${rid}`, { due: "10/8" })).status).toBe(400);
    expect((await call("PATCH", `/requests/${rid}`, { milestone: "nope" })).status).toBe(400);
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

  it("プロジェクト設定を保存できる。タスクのステータスは 未着手 / 作業中 / 完了 だけ", async () => {
    const { call, ctx, rid } = await setup();
    const t = await newTask(ctx, rid, { title: "A" });
    expect((await call("PATCH", `/requests/${rid}/tasks/${t.id}`, { status: "hold" })).status).toBe(400);
    expect((await call("PATCH", `/requests/${rid}/tasks/${t.id}`, { status: "doing" })).body.status).toBe("doing");
    const ok = await call("PUT", "/project", { name: "新しい名前", docs: ["docs"] });
    expect(ok.body).toMatchObject({ name: "新しい名前", docs: ["docs"] });
  });

  it("マイルストーン: 重複と使用中の削除を拒み、要望には定義済みのものだけ付けられる", async () => {
    const { call, rid } = await setup();
    const dup = await call("PUT", "/project", { milestones: [{ id: "v1", title: "a" }, { id: "v1", title: "b" }] });
    expect(dup.status).toBe(400);
    expect((await call("PUT", "/project", { milestones: [{ id: "v1", title: "最初", due: "2026-11-30" }] })).status).toBe(200);
    const r = await call("PATCH", `/requests/${rid}`, { milestone: "v1", due: "2026-11-01", tags: ["ui"] });
    expect(r.body).toMatchObject({ milestone: "v1", due: "2026-11-01", tags: ["ui"] });
    expect((await call("PUT", "/project", { milestones: [] })).body.error).toContain("使用中のマイルストーン");
    expect((await call("PATCH", `/requests/${rid}`, { milestone: null, due: null })).body).not.toHaveProperty("milestone");
    expect((await call("PUT", "/project", { milestones: [] })).status).toBe(200);
    // 作成のときから期限・マイルストーン・タグを付けられる
    await call("PUT", "/project", { milestones: [{ id: "v2", title: "次" }] });
    const created = await call("POST", "/requests", { title: "最初から", milestone: "v2", due: "2026-12-01", tags: ["ui"] });
    expect(created.body).toMatchObject({ milestone: "v2", due: "2026-12-01", tags: ["ui"], status: "draft" });
    expect((await call("POST", "/requests", { title: "x", milestone: "nope" })).status).toBe(400);
  });

  it("完了したタスクに人が「済み」を付け外しできる。完了前は 400", async () => {
    const { call, rid } = await setup();
    await call("POST", `/requests/${rid}/tasks`, { title: "A" });
    expect((await call("PATCH", `/requests/${rid}/tasks/T001`, { checked: true })).status).toBe(400);
    const done = await call("PATCH", `/requests/${rid}/tasks/T001`, { status: "done", checked: true });
    expect(done.body.checkedAt).toBeTruthy();
    expect((await call("PATCH", `/requests/${rid}/tasks/T001`, { checked: false })).body.checkedAt).toBeUndefined();
    const list = await call("GET", "/requests");
    expect(list.body[0].tasks).toEqual([expect.objectContaining({ id: "T001", status: "done", doneAt: expect.any(String) })]);
  });

  it("エンジンの状態を返す（Codex が未設定なら Mock）", async () => {
    const { call } = await setup();
    expect((await call("GET", "/engine")).body).toMatchObject({ name: "mock", ok: true });
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
