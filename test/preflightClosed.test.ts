import { describe, expect, it } from "vitest";
import { preflightClosedReason } from "../packages/tasks/src/shared/preflightClosed.ts";
import { PreflightClosedError } from "../packages/tasks/src/core/preflight/service.ts";
import { createRequest, updateRequest } from "../packages/tasks/src/core/requestOps.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * タスク化した後の要望は再評価しない（shared/preflightClosed.ts）: 進行中・対応済・完了済は始めない・状態を戻してもタスク化・分割の採用の記録が
 * あれば始めない（予約だけは数えない）・直接足したタスクだけの要望は始められる・開始に付けるメモも残さない・子の要望は評価できる
 */
const bullets = (n: number) => Array.from({ length: n }, (_, i) => `- 項目${i + 1}`).join("\n");

describe("始められるかの判定", () => {
  it("状態と、実際に作ったタスク・子の記録で決める", () => {
    expect(preflightClosedReason("active", [])).toContain("進行中");
    expect(preflightClosedReason("resolved", [])).toContain("対応済");
    expect(preflightClosedReason("done", [])).toContain("完了済");
    for (const s of ["draft", "preflight", "reviewed", "rejected"] as const) expect(preflightClosedReason(s, [])).toBeUndefined();
    const made = { id: "PF-1", materialization: { created: { D1: "T001" }, archive: [], archived: [], done: false } };
    expect(preflightClosedReason("draft", [made])).toContain("PF-1 のタスク化");
    expect(preflightClosedReason("rejected", [{ id: "PF-2", materialized: ["T001"] }])).toContain("PF-2 のタスク化");
    expect(preflightClosedReason("draft", [{ id: "PF-3", adoption: { reserved: { C1: "261122-aaaaa" }, created: ["C1"], keys: ["C1"], done: true } }])).toContain("PF-3 の分割の採用");
    // 予約だけ（作る前に落ちた）・何も作っていないタスク化の途中は数えない
    expect(preflightClosedReason("draft", [{ id: "PF-4", adoption: { reserved: { C1: "261122-aaaaa" }, created: [], keys: ["C1"], done: false } }])).toBeUndefined();
    expect(preflightClosedReason("draft", [{ id: "PF-5", materialization: { created: {}, archive: [], archived: [], done: false } }])).toBeUndefined();
  });
});

describe("Preflight の開始", () => {
  it("タスク化した後は通常の実行も手元の評価の準備も始めず、状態を戻しても始めない。直接足したタスクだけなら始められる", async () => {
    const { ctx } = await makeProject();
    const direct = await newRequest(ctx, { title: "直接足した", status: "draft", body: bullets(2) });
    await newTask(ctx, direct.id, { title: "先に足したタスク" });
    const r0 = await ctx.preflight.start(direct.id, { engine: "mock" });
    expect((await ctx.preflight.wait(direct.id, r0.id))?.status).toBe("completed");

    const req = await newRequest(ctx, { title: "タスク化する", status: "draft", body: bullets(2) });
    const first = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, first.id);
    await ctx.preflight.materialize(req.id, first.id);
    await expect(ctx.preflight.start(req.id, { engine: "mock" })).rejects.toThrow(/進行中の要望は、タスク化した後なので再評価しません。変えたいことは新しい要望を登録してください/);
    await expect(ctx.preflight.prepare(req.id)).rejects.toBeInstanceOf(PreflightClosedError);
    // タスクを未着手に戻して要望を下書きにしても、タスク化の記録があるので始めない。見送りにしても同じ
    await ctx.ws.requests.update(req.id, { status: "draft" });
    await expect(ctx.preflight.start(req.id, { engine: "mock" })).rejects.toThrow(`${first.id} のタスク化をした要望なので再評価しません`);
    await updateRequest(ctx, req.id, { status: "rejected" });
    await expect(ctx.preflight.start(req.id, { engine: "mock" })).rejects.toBeInstanceOf(PreflightClosedError);
    expect((await ctx.preflight.list(req.id)).map((r) => r.id)).toEqual([first.id]);
  });

  it("分割を採用した親は再評価しないが、子は（採用で作った子も直接登録した子も）評価でき、子のタスク化で祖先が進行中に戻る", async () => {
    const { ctx } = await makeProject();
    const parent = await createRequest(ctx, { title: "大きい要望", body: bullets(6) });
    const r = await ctx.preflight.start(parent.id, { engine: "mock" });
    await ctx.preflight.wait(parent.id, r.id);
    const { created } = await ctx.preflight.adopt(parent.id, r.id, "human:a");
    await expect(ctx.preflight.start(parent.id, { engine: "mock" })).rejects.toThrow(/分割の採用をした要望なので再評価しません|再評価しません/);
    const direct = await createRequest(ctx, { title: "直接登録した子", body: bullets(2), parent: parent.id });
    for (const id of [created[0].id, direct.id]) {
      const c = await ctx.preflight.start(id, { engine: "mock" });
      expect((await ctx.preflight.wait(id, c.id))?.status).toBe("completed");
    }
    // 親を対応済にしてから子をタスク化すると、親は進行中に戻る（今までどおり）
    await ctx.ws.requests.update(parent.id, { status: "resolved" });
    const run = (await ctx.preflight.list(direct.id))[0];
    const m = await ctx.preflight.materialize(direct.id, run.id);
    expect(m.tasks.length).toBeGreaterThan(0);
    expect(ctx.ws.requests.require(parent.id).status).toBe("active");
  });

  it("API はメモを残さずに 409（preflight_closed）、タスク化の前なら今までどおりメモを付けて始める", async () => {
    const { ctx } = await makeProject();
    const app = apiRoutes(ctx);
    const post = (rid: string, body: object) => app.request(`/requests/${rid}/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "mock", ...body }) });
    const req = await newRequest(ctx, { title: "API", status: "draft", body: bullets(2) });
    const res = await post(req.id, { note: "最初のメモ" });
    expect(res.status).toBe(202);
    const run = (await res.json()) as { id: string };
    await ctx.preflight.wait(req.id, run.id);
    await ctx.preflight.materialize(req.id, run.id);
    const closed = await post(req.id, { note: "タスク化の後のメモ" });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ code: "preflight_closed", error: expect.stringContaining("新しい要望を登録してください") });
    expect((await ctx.ws.notes.list(req.id)).notes.map((n) => n.body)).toEqual(["最初のメモ"]);
  });
});

describe("CLI", () => {
  it("タスク化した後の preflight・--prepare は終了コード 1 で新しい要望を案内し、メモも run も残さない。--note-only は使える", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    expect(p3(root, ["accept", rid], { P3_ACTOR: "human:test" }).code).toBe(0);
    const runs = () => p3(root, ["drafts", rid, "--json"]).json().id as string;
    const last = runs();
    for (const args of [["preflight", rid, "--engine", "mock", "--note", "開始のメモ"], ["preflight", rid, "--prepare", "--note", "開始のメモ"]]) {
      const r = p3(root, args, { P3_ACTOR: "ai:test" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("新しい要望を登録してください");
      expect(r.err).not.toContain("p3 new");
    }
    expect(runs()).toBe(last);
    expect(p3(root, ["notes", rid, "--json"]).json().notes).toEqual([]);
    expect(p3(root, ["preflight", rid, "--note", "記録として残すメモ", "--note-only"]).code).toBe(0);
  });
});
