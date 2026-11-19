import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reworkOf } from "../packages/tasks/src/features/records/shared/reworkHistory.ts";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { ConflictError, NotFoundError } from "../packages/tasks/src/core/store/collection.ts";
import { withFileLock } from "../packages/kit/src/fsutil.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * 手戻りの履歴（shared/reworkHistory.ts）: 明示の済みの解除・基準の変更による解除・完了からの再開の見分け、1操作で両方なら1件、
 * 同じ値の再保存で増えないこと、競合・別のプロセスのアーカイブとの重なり、旧データ・壊れた値、CLI・API を確かめる
 */

async function setup() {
  const p = await makeProject();
  const r = await newRequest(p.ctx, { title: "請求" });
  const { task } = await createTask(p.ctx, r.id, { title: "実装", criteria: ["a"] });
  const done = async () => {
    await updateTask(p.ctx, r.id, task.id, { status: "done" });
    return (await updateTask(p.ctx, r.id, task.id, { checked: true })).task;
  };
  return { ...p, rid: r.id, tid: task.id, done, file: join(p.dataDir, "requests", r.id, "tasks", `${task.id}.md`) };
}

describe("見分け", () => {
  it("明示の済みの解除・基準の変更による解除・完了からの再開を契機で分け、済みの完了から戻す1操作は両方を示す1件", async () => {
    const { ctx, rid, tid, done } = await setup();
    await done();
    let t = (await updateTask(ctx, rid, tid, { checked: false }, { actor: "human:a" })).task;
    expect(t.reworkHistory).toEqual([expect.objectContaining({ id: "R1", cause: "explicit", unchecked: true, reopened: false, by: "human:a", rev: t.rev, from: { status: "done", checked: true }, to: { status: "done", checked: false } })]);
    await updateTask(ctx, rid, tid, { checked: true });
    t = (await updateTask(ctx, rid, tid, { acceptance: [{ op: "edit", id: "A1", text: "b" }] }, { actor: "ai:x" })).task;
    expect(t.reworkHistory?.at(-1)).toMatchObject({ id: "R2", cause: "acceptance", unchecked: true, reopened: false, by: "ai:x" });
    await updateTask(ctx, rid, tid, { checked: true });
    t = (await updateTask(ctx, rid, tid, { status: "doing" })).task;
    expect(t.reworkHistory?.at(-1)).toMatchObject({ id: "R3", cause: "reopen", unchecked: true, reopened: true, from: { status: "done", checked: true }, to: { status: "doing", checked: false } });
    expect(t.reworkHistory).toHaveLength(3);
    // 済みの無い完了から戻す
    await updateTask(ctx, rid, tid, { status: "done" });
    t = (await updateTask(ctx, rid, tid, { status: "todo" })).task;
    expect(t.reworkHistory?.at(-1)).toMatchObject({ id: "R4", cause: "reopen", unchecked: false, reopened: true });
  });

  it("同じ値の再保存・済みを保ったままの変更・成果物の追記では増えず、再完了・再確認の後も以前の履歴を読める", async () => {
    const { ctx, rid, tid, done } = await setup();
    await done();
    await updateTask(ctx, rid, tid, { status: "done" });
    await updateTask(ctx, rid, tid, { outputs: ["https://example.com/pr/1"] });
    await updateTask(ctx, rid, tid, { checked: true });
    await updateTask(ctx, rid, tid, { checked: true, acceptance: [{ op: "edit", id: "A1", text: "b" }] });
    await updateTask(ctx, rid, tid, { labels: ["x"] });
    expect(ctx.ws.tasksOf(rid).require(tid).reworkHistory).toBeUndefined();
    // 済みの無いタスクで済みを外しても増えない
    await updateTask(ctx, rid, tid, { checked: false });
    await updateTask(ctx, rid, tid, { checked: false });
    expect(ctx.ws.tasksOf(rid).require(tid).reworkHistory).toHaveLength(1);
    await done();
    const t = (await updateTask(ctx, rid, tid, { status: "done" })).task;
    expect(t.reworkHistory?.map((e) => e.id)).toEqual(["R1"]);
  });

  it("規則（shared）", () => {
    expect(reworkOf({ status: "done" }, { status: "done" }, { explicitUncheck: true, acceptanceChanged: false })).toBeUndefined();
    expect(reworkOf({ status: "doing" }, { status: "todo" }, { explicitUncheck: false, acceptanceChanged: false })).toBeUndefined();
    expect(reworkOf({ status: "done", checkedAt: "x" }, { status: "done" }, { explicitUncheck: false, acceptanceChanged: true })?.cause).toBe("acceptance");
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
  it("CLI の check --off・move と show、API の PATCH と詳細で履歴を読める", async () => {
    const { ctx, rid, tid, done, dataDir } = await setup();
    await done();
    expect(p3(dataDir, ["check", `${rid}/${tid}`, "--off"]).code).toBe(0);
    expect(p3(dataDir, ["check", `${rid}/${tid}`]).code).toBe(0);
    expect(p3(dataDir, ["move", `${rid}/${tid}`, "doing"]).code).toBe(0);
    const shown = p3(dataDir, ["show", `${rid}/${tid}`]);
    expect(shown.out).toContain("手戻りの履歴");
    expect(shown.out).toContain("R1  済みが外れた（done・済み → done）  済みを外した");
    expect(shown.out).toContain("R2  完了から戻した・済みが外れた（done・済み → doing）  完了から戻した");
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    await ctx.ws.tasksOf(rid).reload(tid);
    const forged = await send("PATCH", `/requests/${rid}/tasks/${tid}`, { reworkHistory: [], status: "done" });
    expect(((await forged.json()) as { reworkHistory: unknown[] }).reworkHistory).toHaveLength(2);
    const r = await send("PATCH", `/requests/${rid}/tasks/${tid}`, { status: "todo" });
    expect(((await r.json()) as { reworkHistory: { cause: string }[] }).reworkHistory.at(-1)).toMatchObject({ id: "R3", cause: "reopen" });
    const detail = (await (await send("GET", `/requests/${rid}/tasks/${tid}`)).json()) as { task: { reworkHistory: unknown[] } };
    expect(detail.task.reworkHistory).toHaveLength(3);
  });
});
