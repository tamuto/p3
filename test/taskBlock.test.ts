import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listTasks, progress } from "../src/core/ops.ts";
import { createTask, updateTask } from "../src/core/requestOps.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { applyBlockOp, BLOCK_LIMITS, BlockInputError, blockWarnings } from "../src/shared/taskBlock.ts";
import { makeProject, newRequest, newTask, tempDir } from "./helpers.ts";

/**
 * 作業中のタスクの止まっている理由（shared/taskBlock.ts・core/requestOps.ts）: 付ける・直す・解除・付け直しと履歴、since を保つこと、
 * 空・上限、作業中でない付与・止まったままの移動を断ること、解除と移動の一括、rev の競合、壊れた直接編集、一覧の絞り込みと進捗の集計、
 * CLI と API の同等性
 */

const at = (status: "todo" | "doing" | "done" = "doing", now = "2026-11-12T00:00:00.000Z") => ({ now, actor: "ai:test", status });

describe("規則（shared）", () => {
  it("付ける → 直す（since を保つ）→ 同じ内容は何もしない → 解除（回答が要る）→ 付け直すと since が新しい", () => {
    let s = applyBlockOp({}, { op: "set", reason: " テストが通らない ", decision: "API を変えてよいか" }, at())!;
    expect(s.block).toMatchObject({ reason: "テストが通らない", decision: "API を変えてよいか", since: "2026-11-12T00:00:00.000Z", updatedBy: "ai:test" });
    expect(s.blockHistory).toEqual([{ action: "set", at: "2026-11-12T00:00:00.000Z", by: "ai:test", after: { reason: "テストが通らない", decision: "API を変えてよいか", since: "2026-11-12T00:00:00.000Z" } }]);
    expect(applyBlockOp(s, { op: "set", reason: "テストが通らない", decision: "API を変えてよいか" }, at())).toBeUndefined();
    s = applyBlockOp(s, { op: "set", reason: "テストが通らない（再現手順あり）" }, at("doing", "2026-11-12T01:00:00.000Z"))!;
    expect(s.block).toMatchObject({ since: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T01:00:00.000Z" });
    expect(s.block!.decision).toBeUndefined();
    expect(s.blockHistory!.at(-1)).toMatchObject({ action: "update", before: { decision: "API を変えてよいか" }, after: { reason: "テストが通らない（再現手順あり）" } });
    expect(() => applyBlockOp(s, { op: "clear", resolution: "  " }, at())).toThrow(BlockInputError);
    s = applyBlockOp(s, { op: "clear", resolution: "API は変えてよい" }, at("doing", "2026-11-12T02:00:00.000Z"))!;
    expect(s.block).toBeUndefined();
    expect(s.blockHistory!.at(-1)).toMatchObject({ action: "clear", resolution: "API は変えてよい", before: { reason: "テストが通らない（再現手順あり）" } });
    expect(applyBlockOp(s, { op: "clear", resolution: "x" }, at())).toBeUndefined();
    s = applyBlockOp(s, { op: "set", reason: "別の理由" }, at("doing", "2026-11-12T03:00:00.000Z"))!;
    expect(s.block!.since).toBe("2026-11-12T03:00:00.000Z");
    expect(s.blockHistory).toHaveLength(4);
  });

  it("空白だけ・上限を超える・作業中でない付与・読めない値の操作は断る", () => {
    expect(() => applyBlockOp({}, { op: "set", reason: " \n " }, at())).toThrow(BlockInputError);
    expect(() => applyBlockOp({}, { op: "set", reason: "x".repeat(BLOCK_LIMITS.reason + 1) }, at())).toThrow(/2000 文字まで/);
    expect(() => applyBlockOp({}, { op: "set", reason: "r", decision: "x".repeat(BLOCK_LIMITS.decision + 1) }, at())).toThrow(BlockInputError);
    expect(() => applyBlockOp({}, { op: "clear", resolution: "x".repeat(BLOCK_LIMITS.resolution + 1) }, at())).toThrow(BlockInputError);
    expect(() => applyBlockOp({}, { op: "set", reason: "r" }, at("todo"))).toThrow(expect.objectContaining({ code: "block_not_doing" }));
    expect(() => applyBlockOp({ blockProblems: ["x"] }, { op: "clear", resolution: "r" }, at())).toThrow(/ファイルの block/);
    expect(blockWarnings({ status: "done", block: { reason: "r", since: "s", updatedAt: "s" } })).toEqual([expect.stringContaining("作業中でないのに停止")]);
  });
});

async function setup() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "要望" });
  const { task } = await createTask(p.ctx, req.id, { title: "t", criteria: ["一"] });
  await updateTask(p.ctx, req.id, task.id, { status: "doing" });
  const file = join(p.dataDir, "requests", req.id, "tasks", `${task.id}.md`);
  return { ...p, rid: req.id, tid: task.id, file };
}

describe("保存（core）", () => {
  it("旧いタスクは停止の項目なしで読み書きでき、付けた値と履歴は保存し直して読める", async () => {
    const { ctx, rid, tid, file } = await setup();
    expect(readFileSync(file, "utf8")).not.toContain("block");
    await updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "前提が崩れた", decision: "仕様を確かめたい" } }, { actor: "ai:test" });
    await ctx.ws.reloadAll();
    const t = ctx.ws.tasksOf(rid).require(tid);
    expect(t.block).toMatchObject({ reason: "前提が崩れた", decision: "仕様を確かめたい", updatedBy: "ai:test" });
    expect(t.blockHistory).toHaveLength(1);
    expect(t.status).toBe("doing");
  });

  it("止まったまま未着手・完了へは動かせない。解除と移動を一緒に指定すれば一緒に保存し、付与と非作業中への移動は断る。解除は状態・日時・済みを変えない", async () => {
    const { ctx, rid, tid } = await setup();
    await updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "止まった" } });
    const before = ctx.ws.tasksOf(rid).require(tid);
    await expect(updateTask(ctx, rid, tid, { status: "done" })).rejects.toMatchObject({ code: "blocked" });
    await expect(updateTask(ctx, rid, tid, { status: "todo" })).rejects.toMatchObject({ code: "blocked" });
    expect(ctx.ws.tasksOf(rid).require(tid).rev).toBe(before.rev);
    // 解除だけ: 状態・日時は変わらない
    const cleared = await updateTask(ctx, rid, tid, { blockOp: { op: "clear", resolution: "答えた" } });
    expect(cleared.task).toMatchObject({ status: "doing", startedAt: before.startedAt });
    expect(cleared.task.doneAt).toBeUndefined();
    // 付与と非作業中への移動は一緒にできない
    await expect(updateTask(ctx, rid, tid, { status: "done", blockOp: { op: "set", reason: "x" } })).rejects.toMatchObject({ code: "block_not_doing" });
    // 解除と完了を一緒に
    await updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "また止まった" } });
    const both = await updateTask(ctx, rid, tid, { status: "done", record: "r", blockOp: { op: "clear", resolution: "解決した" } });
    expect(both.task).toMatchObject({ status: "done" });
    expect(both.task.block).toBeUndefined();
    expect(both.task.blockHistory!.map((h) => h.action)).toEqual(["set", "clear", "set", "clear"]);
    // 完了の後も基準・記録・履歴は残る
    expect(both.task.acceptanceCriteria).toHaveLength(1);
  });

  it("rev が違えば何も書かない", async () => {
    const { ctx, rid, tid } = await setup();
    const t = ctx.ws.tasksOf(rid).require(tid);
    await expect(updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "r" } }, { expectedRev: t.rev + 1 })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.tasksOf(rid).require(tid).block).toBeUndefined();
  });

  it("直接編集で読めない値は問題として知らせ、操作は断り、関係のない更新では元の値を残す。完了に停止が残っていれば警告し、解除で直せる", async () => {
    const { ctx, rid, tid, file } = await setup();
    writeFileSync(file, readFileSync(file, "utf8").replace(/^rev:/m, "block: 壊れた値\nrev:"));
    await ctx.ws.reloadAll();
    const t = ctx.ws.tasksOf(rid).require(tid);
    expect(t.blockProblems).toEqual([expect.stringContaining("block が読めません")]);
    await expect(updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "r" } })).rejects.toBeInstanceOf(BlockInputError);
    await updateTask(ctx, rid, tid, { title: "改題" });
    expect(readFileSync(file, "utf8")).toContain("block: 壊れた値");
    // 完了に停止が残っている（直接編集）
    const { task: d } = await createTask(ctx, rid, { title: "完了", status: "done" });
    const f2 = join(ctx.ws.dataDir, "requests", rid, "tasks", `${d.id}.md`);
    writeFileSync(f2, readFileSync(f2, "utf8").replace(/^rev:/m, "block:\n  reason: 残った\n  since: 2026-01-01T00:00:00.000Z\nrev:"));
    await ctx.ws.reloadAll();
    const dd = ctx.ws.tasksOf(rid).require(d.id);
    expect(blockWarnings(dd)).toHaveLength(1);
    await updateTask(ctx, rid, d.id, { outputs: ["x"] });
    const fixed = await updateTask(ctx, rid, d.id, { blockOp: { op: "clear", resolution: "直した" } });
    expect(fixed.task.block).toBeUndefined();
  });

  it("一覧の絞り込みはほかの条件と AND。進捗は自分と配下の停止を数え、完了率・合計は変えない（見送りの子も配下に数える）", async () => {
    const { ctx, rid, tid } = await setup();
    await updateTask(ctx, rid, tid, { blockOp: { op: "set", reason: "r" } });
    await newTask(ctx, rid, { title: "作業中で止まっていない", status: "doing" });
    const child = await newRequest(ctx, { title: "子", parent: rid });
    const grand = await newRequest(ctx, { title: "孫", parent: child.id });
    const rej = await newRequest(ctx, { title: "見送りの子", parent: rid, status: "rejected" });
    for (const r of [child, grand, rej]) {
      const { task } = await createTask(ctx, r.id, { title: "x" });
      await updateTask(ctx, r.id, task.id, { status: "doing", blockOp: { op: "set", reason: "子で止まった" } });
    }
    expect(listTasks(ctx, { request: rid, blocked: true }).map((t) => t.id)).toEqual([tid]);
    expect(listTasks(ctx, { blocked: true, status: ["doing"] })).toHaveLength(4);
    expect(listTasks(ctx, { blocked: true, q: "存在しない語" })).toHaveLength(0);
    const ps = progress(ctx);
    const p = ps.find((x) => x.request.id === rid)!;
    expect(p).toMatchObject({ blocked: 1, total: 2, done: 0, counts: { doing: 2 } });
    expect(p.subtree).toMatchObject({ blocked: 4, total: 5 });
    expect(ps.find((x) => x.request.id === child.id)!.subtree.blocked).toBe(2);
    expect(p.tasks.find((t) => t.id === tid)!.block).toMatchObject({ reason: "r" });
    // 全体の合計は自分の値を足す（二重に数えない）
    expect(ps.reduce((n, x) => n + x.blocked, 0)).toBe(4);
  });
});

describe("CLI と API", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  const p3 = (dataDir: string, args: string[], input?: string) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "ai:test" };
    const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, input });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("CLI: block / unblock / ls --blocked / show（通常・brief・JSON）と終了コード。API でも同じ値・履歴・エラー", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const req = ["--req", rid];
    expect(p3(dataDir, ["block", tid, ...req, "--reason", "-", "--decision", "どちらの案にするか"], "1行目\n2行目\n").code).toBe(0);
    expect(p3(dataDir, ["block", tid, ...req, "--reason", "-", "--decision", "-"], "x").code).toBe(1);
    expect(p3(dataDir, ["block", tid, ...req]).code).toBe(1);
    expect(p3(dataDir, ["move", tid, "done", ...req, "--record", "r"]).err).toContain("止まっています");
    expect(p3(dataDir, ["move", tid, "done", ...req, "--record", "r"]).code).toBe(1);
    const ls = p3(dataDir, ["ls", ...req, "--blocked"]);
    expect(ls.out).toContain("⏸停止");
    expect(p3(dataDir, ["ls", ...req, "--blocked", "--archived"]).code).toBe(1);
    const show = JSON.parse(p3(dataDir, ["show", tid, ...req, "--json"]).out) as { item: { block: { reason: string }; blockHistory: unknown[] } };
    expect(show.item.block.reason).toBe("1行目\n2行目");
    expect(show.item.blockHistory).toHaveLength(1);
    const brief = JSON.parse(p3(dataDir, ["show", tid, ...req, "--brief", "--json"]).out) as { item: Record<string, unknown> };
    expect(brief.item.block).toBeTruthy();
    expect(brief.item.blockHistory).toBeUndefined();
    expect(p3(dataDir, ["show", tid, ...req]).out).toContain("決めてほしいこと:");
    expect(p3(dataDir, ["progress"]).out).toContain("⏸停止 1");
    expect(p3(dataDir, ["unblock", tid, ...req, "--resolution", "案 A にする"]).code).toBe(0);
    expect(p3(dataDir, ["unblock", tid, ...req, "--resolution", "x", "--json"]).out).toContain('"changed": false');

    // API で同じことをする
    const app = apiRoutes(ctx);
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const { task: t2 } = await createTask(ctx, rid, { title: "API" });
    const path = `/requests/${rid}/tasks/${t2.id}`;
    expect((await send("PATCH", path, { blockOp: { op: "set", reason: "r" } })).body).toMatchObject({ code: "block_not_doing" });
    await send("PATCH", path, { status: "doing" });
    expect((await send("PATCH", path, { blockOp: { op: "set", reason: "1行目\n2行目", decision: "どちらの案にするか" } })).status).toBe(200);
    expect((await send("PATCH", path, { status: "done" })).body).toMatchObject({ code: "blocked" });
    expect((await send("PATCH", path, { blockOp: { op: "clear", resolution: " " } })).body).toMatchObject({ code: "block_invalid" });
    expect((await send("PATCH", path, { block: { reason: "直接", since: "x" }, blockHistory: [] })).status).toBe(200);
    const listed = await app.request(`/requests/${rid}/tasks?blocked=true&status=doing`);
    expect(((await listed.json()) as { id: string }[]).map((t) => t.id)).toEqual([t2.id]);
    await send("PATCH", path, { blockOp: { op: "clear", resolution: "案 A にする" } });
    await ctx.ws.reloadAll();
    const a = ctx.ws.tasksOf(rid).require(t2.id);
    const c = ctx.ws.tasksOf(rid).require(tid);
    const shape = (x: typeof a) => x.blockHistory?.map((h) => [h.action, h.after?.reason ?? h.before?.reason, h.after?.decision ?? h.before?.decision, h.resolution]);
    expect(shape(a)).toEqual(shape(c));
  });
});
