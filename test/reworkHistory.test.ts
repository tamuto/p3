import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reworkOf } from "../packages/tasks/src/features/records/shared/reworkHistory.ts";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { ConflictError, NotFoundError } from "../packages/tasks/src/core/store/collection.ts";
import { withFileLock } from "../packages/shared/src/node/fsutil.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * 手戻りの履歴（shared/reworkHistory.ts）: 完了からの再開だけを足すこと、以前の版の済みの解除の契機が混ざった履歴を読めること、
 * 同じ値の再保存で増えないこと、競合・別のプロセスのアーカイブとの重なり、旧データ・壊れた値、CLI・API を確かめる
 */

async function setup() {
  const p = await makeProject();
  const r = await newRequest(p.ctx, { title: "請求" });
  const { task } = await createTask(p.ctx, r.id, { title: "実装", criteria: ["a"] });
  const done = async () => (await updateTask(p.ctx, r.id, task.id, { status: "done" })).task;
  return { ...p, rid: r.id, tid: task.id, done, file: join(p.dataDir, "requests", r.id, "tasks", `${task.id}.md`) };
}

describe("見分け", () => {
  it("完了から戻すたびに1件（cause: reopen）。以前の版の済みの解除の契機が混ざった履歴の続きにも足す", async () => {
    const { ctx, rid, tid, done, file } = await setup();
    await done();
    // 以前の版の履歴（済みの解除 explicit と checked）を読み、続きの番号で足す
    const legacy = "status: done\nreworkHistory:\n  - id: R1\n    at: 2026-11-01T00:00:00.000Z\n    rev: 3\n    cause: explicit\n    unchecked: true\n    reopened: false\n    from: { status: done, checked: true }\n    to: { status: done, checked: false }";
    await writeFile(file, (await readFile(file, "utf8")).replace("status: done", legacy));
    await ctx.ws.tasksOf(rid).reload(tid);
    expect(ctx.ws.tasksOf(rid).require(tid).reworkHistory?.[0]).toMatchObject({ cause: "explicit", unchecked: true, from: { status: "done", checked: true } });
    const t = (await updateTask(ctx, rid, tid, { status: "doing" }, { actor: "human:a" })).task;
    expect(t.reworkHistory?.map((e) => [e.id, e.cause])).toEqual([["R1", "explicit"], ["R2", "reopen"]]);
    expect(t.reworkHistory?.[1]).toMatchObject({ reopened: true, by: "human:a", rev: t.rev, from: { status: "done" }, to: { status: "doing" } });
  });

  it("同じ値の再保存・成果物の追記・基準の変更では増えず、再完了の後も以前の履歴を読める", async () => {
    const { ctx, rid, tid, done } = await setup();
    await done();
    await updateTask(ctx, rid, tid, { status: "done" });
    await updateTask(ctx, rid, tid, { outputs: ["https://example.com/pr/1"] });
    await updateTask(ctx, rid, tid, { acceptance: [{ op: "edit", id: "A1", text: "b" }] });
    await updateTask(ctx, rid, tid, { labels: ["x"] });
    expect(ctx.ws.tasksOf(rid).require(tid).reworkHistory).toBeUndefined();
    await updateTask(ctx, rid, tid, { status: "doing" });
    const t = await done();
    expect(t.reworkHistory?.map((e) => e.id)).toEqual(["R1"]);
  });

  it("規則（shared）", () => {
    expect(reworkOf({ status: "done" }, { status: "done" })).toBeUndefined();
    expect(reworkOf({ status: "doing" }, { status: "todo" })).toBeUndefined();
    expect(reworkOf({ status: "done" }, { status: "todo" })).toMatchObject({ cause: "reopen", reopened: true });
  });
});

describe("競合とアーカイブ", () => {
  it("古い rev では状態も履歴も変わらない", async () => {
    const { ctx, rid, tid, done, file } = await setup();
    await done();
    const before = await readFile(file, "utf8");
    await expect(updateTask(ctx, rid, tid, { status: "doing" }, { expectedRev: 1 })).rejects.toThrow(ConflictError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("別のプロセスの更新とアーカイブが重なっても、成功した履歴は保存先（アーカイブ）に残り、移した後のファイルを書き戻さない", async () => {
    const { rid, tid, done, file, dataDir } = await setup();
    await done();
    const a = await openTestProject(dataDir);
    const b = await openTestProject(dataDir);
    const archived = join(dataDir, "requests", rid, "tasks", ".archive", `${tid}.md`);
    const [u, ar] = await Promise.allSettled([updateTask(a, rid, tid, { status: "doing" }), b.ws.tasksOf(rid).archive(tid)]);
    expect(ar.status).toBe("fulfilled");
    expect(existsSync(file)).toBe(false);
    if (u.status === "fulfilled") expect(await readFile(archived, "utf8")).toContain("reworkHistory:");
    else expect(u.reason).toBeInstanceOf(NotFoundError);
  });

  it("アーカイブした後に、古い読み込みのままのプロセスが更新しても作り直さない。ロックを持っている間は待つ", async () => {
    const { rid, tid, done, file, dataDir, ctx } = await setup();
    await done();
    const stale = await openTestProject(dataDir);
    // ロックを持っている間は、アーカイブは待つ
    let archivedEarly = false;
    await withFileLock(ctx.ws.requestLock(rid), async () => {
      const p = ctx.ws.tasksOf(rid).archive(tid).then(() => (archivedEarly = true));
      await new Promise((r) => setTimeout(r, 150));
      expect(archivedEarly).toBe(false);
      void p;
    });
    await expect.poll(() => archivedEarly).toBe(true);
    await expect(updateTask(stale, rid, tid, { status: "doing" })).rejects.toThrow(NotFoundError);
    expect(existsSync(file)).toBe(false);
  });
});

describe("旧データと壊れた値", () => {
  it("履歴の無い古いタスクはそのまま読め、壊れた履歴は元の値と問題が残り、足せなかったと知らせる", async () => {
    const { ctx, rid, tid, done, file } = await setup();
    await done();
    expect(ctx.ws.tasksOf(rid).require(tid).reworkHistory).toBeUndefined();
    await writeFile(file, (await readFile(file, "utf8")).replace("status: done", "status: done\nreworkHistory:\n  - id: X\n    cause: what"));
    await ctx.ws.tasksOf(rid).reload(tid);
    expect(ctx.ws.tasksOf(rid).require(tid).reworkProblems?.[0]).toMatch(/id が読めません/);
    await updateTask(ctx, rid, tid, { labels: ["y"] });
    expect(await readFile(file, "utf8")).toContain("cause: what");
    const r = await updateTask(ctx, rid, tid, { status: "doing" });
    expect(r.task.status).toBe("doing");
    expect(r.reworkSkipped).toMatch(/手戻りの履歴が読めない/);
    expect(await readFile(file, "utf8")).toContain("id: X");
  });
});

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI と API", () => {
  it("CLI の move と show、API の PATCH と詳細で履歴を読める", async () => {
    const { ctx, rid, tid, done, dataDir } = await setup();
    await done();
    expect(p3(dataDir, ["move", `${rid}/${tid}`, "doing"]).code).toBe(0);
    const shown = p3(dataDir, ["show", `${rid}/${tid}`]);
    expect(shown.out).toContain("手戻りの履歴");
    expect(shown.out).toContain("R1  完了から戻した（done → doing）  完了から戻した");
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await ctx.ws.tasksOf(rid).reload(tid);
    const forged = await send("PATCH", `/requests/${rid}/tasks/${tid}`, { reworkHistory: [], status: "done" });
    expect(((await forged.json()) as { reworkHistory: unknown[] }).reworkHistory).toHaveLength(1);
    const r = await send("PATCH", `/requests/${rid}/tasks/${tid}`, { status: "todo" });
    expect(((await r.json()) as { reworkHistory: { cause: string }[] }).reworkHistory.at(-1)).toMatchObject({ id: "R2", cause: "reopen" });
    const detail = (await (await send("GET", `/requests/${rid}/tasks/${tid}`)).json()) as { task: { reworkHistory: unknown[] } };
    expect(detail.task.reworkHistory).toHaveLength(2);
  });
});
