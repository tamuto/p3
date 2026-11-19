import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCompletion, taskTriggers } from "../packages/tasks/src/shared/completionRecord.ts";
import { qualityVersion, readQuality } from "../packages/tasks/src/shared/quality.ts";
import { createTask, updateRequest, updateRequirement, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { completeMilestoneRequests, completionPlan } from "../packages/tasks/src/core/releaseNotes/completeRequests.ts";
import { ConflictError } from "../packages/tasks/src/core/store/collection.ts";
import { Workspace } from "../packages/tasks/src/core/store/workspace.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { git, makeProject, newRequest, openTestProject, tempDir, writeTestProject } from "./helpers.ts";

/**
 * 完了の記録（shared/completionRecord.ts）: 契機ごとの保存と読み直し、再完了・再確認と重複しないこと、同時に変えた基準・証拠、
 * 品質の状態、参照先の取得、旧データ・壊れた記録・競合、CLI・API・一括完了の経路を確かめる
 */

const QUALITY_RAW = { standards: [{ id: "Q1", text: "テストを通す", check: { kind: "machine", command: "pnpm test", success: "exit 0" } }, { id: "Q2", text: "別の参照先", repos: ["other"], check: { kind: "manual", reference: "目視" } }] };

function setQuality(ws: Workspace, raw: unknown) {
  const q = readQuality(raw, ws.project.repos.map((r) => r.name));
  ws.project.quality = q;
  ws.project.qualityVersion = qualityVersion(q, raw);
}

async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "v1" }] });
  git(p.root, "add", "-A");
  git(p.root, "commit", "-qm", "init");
  const r = await newRequest(p.ctx, { title: "請求", body: "月末締め", milestone: "v1" });
  /** ディスクから読み直したタスク */
  const fresh = async (tid: string) => {
    const ws = new Workspace(p.dataDir);
    await ws.load();
    return ws.tasksOf(r.id).require(tid);
  };
  return { ...p, rid: r.id, fresh };
}

describe("契機ごとの保存", () => {
  it("タスクの完了・人の済み・要望の対応済・完了済で日時・主体・rev・状態・条件の写しが残り、読み直しても一致する", async () => {
    const { ctx, rid, fresh, dataDir } = await setup();
    setQuality(ctx.ws, QUALITY_RAW);
    await updateRequirement(ctx, rid, [{ op: "add", target: "税は切り捨て", source: "経理規程", basis: "例" }], { actor: "human:a" });
    const { task } = await createTask(ctx, rid, { title: "実装", criteria: ["税を計算する"] }, "ai:x");
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "テスト通過", basis: { kind: "declaration" } }] }, { actor: "ai:x" });
    const done = (await updateTask(ctx, rid, task.id, { status: "done" }, { actor: "ai:x" })).task;
    const c1 = done.completionRecords?.[0];
    expect(c1).toMatchObject({ id: "C1", trigger: "task_done", by: "ai:x", rev: done.rev, status: "done", checked: false });
    expect(c1?.acceptance?.criteria?.map((c) => c.id)).toEqual(["A1", "A2"]);
    expect(c1?.acceptance?.criteria?.[1].quality).toMatchObject({ id: "Q1" });
    expect(c1?.acceptance?.evidence?.[0]).toMatchObject({ criterionId: "A1", result: "met", basis: { kind: "declaration" } });
    // 品質は作業先に当てはまる項目だけ（Q2 は別の参照先）
    expect(c1?.quality).toMatchObject({ state: "set", version: ctx.ws.project.qualityVersion, repo: "main" });
    expect(c1?.quality.standards?.map((s) => s.id)).toEqual(["Q1"]);
    expect(c1?.requirement?.sources?.[0]).toMatchObject({ id: "S1", source: "経理規程" });
    expect(await fresh(task.id)).toEqual(done);
    // 人の済み（AI の承認ではなく、保存した主体をそのまま残す）
    const checked = (await updateTask(ctx, rid, task.id, { checked: true }, { actor: "human:b" })).task;
    expect(checked.completionRecords?.map((c) => [c.id, c.trigger, c.by, c.checked])).toEqual([
      ["C1", "task_done", "ai:x", false],
      ["C2", "task_checked", "human:b", true],
    ]);
    expect(await fresh(task.id)).toEqual(checked);
    // 要望の対応済・完了済（判定に使ったタスクと、その時点の最新の記録 ID）
    const resolved = await updateRequest(ctx, rid, { status: "resolved" }, { actor: "ai:x" });
    expect(resolved.completionRecords?.[0]).toMatchObject({ id: "C1", trigger: "request_resolved", status: "resolved", rev: resolved.rev, title: "請求", tasks: [{ id: task.id, rev: checked.rev, status: "done", checked: true, record: "C2" }], children: [] });
    expect(resolved.completionRecords?.[0].requirement?.sources?.[0].id).toBe("S1");
    expect(resolved.completionRecords?.[0].quality.standards).toBeUndefined();
    const doneReq = await updateRequest(ctx, rid, { status: "done" }, { actor: "human:b" });
    expect(doneReq.completionRecords?.map((c) => c.trigger)).toEqual(["request_resolved", "request_done"]);
    const ws = new Workspace(dataDir);
    await ws.load();
    const { rev: _r, updatedAt: _u, ...a } = ws.requests.require(rid);
    const { rev: _r2, updatedAt: _u2, reopenedAncestors: _ra, warnings: _w, ...b } = doneReq;
    expect(a).toEqual({ ...b });
  });

  it("子だけの親の要望も、子の要望の ID・rev・記録から辿れる", async () => {
    const { ctx, rid } = await setup();
    const child = await newRequest(ctx, { title: "子", parent: rid });
    const { task } = await createTask(ctx, child.id, { title: "子の作業" });
    await updateTask(ctx, child.id, task.id, { status: "done" });
    const c = await updateRequest(ctx, child.id, { status: "resolved" });
    const parent = await updateRequest(ctx, rid, { status: "resolved" });
    expect(parent.completionRecords?.[0]).toMatchObject({ tasks: [], children: [{ id: child.id, rev: c.rev, status: "resolved", record: "C1" }] });
  });

  it("完了で作ったタスクにも最初の記録が残る", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "済んだ作業", status: "done" }, "ai:x");
    expect(task.completionRecords).toMatchObject([{ id: "C1", trigger: "task_done", rev: 1, status: "done" }]);
  });
});

describe("再完了・再確認と重複", () => {
  it("再開しても以前の記録は残り、再完了・再確認で足す。同じ状態の再保存・成果物の追記・済みの付け直しでは足さない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "実装", criteria: ["a"] });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateTask(ctx, rid, task.id, { checked: true });
    // 同じ状態の再保存・成果物の追記・済みの付け直し
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateTask(ctx, rid, task.id, { outputs: ["https://example.com/pr/1"] });
    let t = (await updateTask(ctx, rid, task.id, { checked: true })).task;
    expect(t.completionRecords?.map((c) => c.id)).toEqual(["C1", "C2"]);
    // 再開（doneAt・checkedAt は消えるが記録は残る）→ 再完了
    t = (await updateTask(ctx, rid, task.id, { status: "doing" })).task;
    expect(t.checkedAt).toBeUndefined();
    expect(t.completionRecords?.map((c) => c.id)).toEqual(["C1", "C2"]);
    t = (await updateTask(ctx, rid, task.id, { status: "done" })).task;
    t = (await updateTask(ctx, rid, task.id, { checked: false })).task;
    t = (await updateTask(ctx, rid, task.id, { checked: true })).task;
    expect(t.completionRecords?.map((c) => `${c.id}:${c.trigger}`)).toEqual(["C1:task_done", "C2:task_checked", "C3:task_done", "C4:task_checked"]);
    // 済みのまま基準を変えて済みを付け直したら、新しい人の済みの記録（変えた後の基準）
    t = (await updateTask(ctx, rid, task.id, { checked: true, acceptance: [{ op: "edit", id: "A1", text: "b" }] })).task;
    expect(t.completionRecords?.at(-1)).toMatchObject({ id: "C5", trigger: "task_checked" });
    expect(t.completionRecords?.at(-1)?.acceptance?.criteria?.[0].text).toBe("b");
  });

  it("契機の判定（shared）", () => {
    expect(taskTriggers({ status: "doing" }, { status: "done" }, false)).toEqual(["task_done"]);
    expect(taskTriggers({ status: "doing" }, { status: "done", checkedAt: "x" }, false)).toEqual(["task_done", "task_checked"]);
    expect(taskTriggers({ status: "done", checkedAt: "x" }, { status: "done", checkedAt: "y" }, false)).toEqual([]);
    expect(taskTriggers({ status: "done", checkedAt: "x" }, { status: "done", checkedAt: "y" }, true)).toEqual(["task_checked"]);
    expect(taskTriggers({ status: "done" }, { status: "doing" }, false)).toEqual([]);
  });
});

describe("同時の変更と品質の状態", () => {
  it("完了と同時に残した証拠は残した後の内容で写し、品質の未設定・設定済・読めないを区別する", async () => {
    const { ctx, rid } = await setup();
    const states: string[] = [];
    for (const raw of [undefined, QUALITY_RAW, { standards: "壊れた" }]) {
      setQuality(ctx.ws, raw);
      const { task } = await createTask(ctx, rid, { title: "作業", criteria: ["a"], quality: "none" });
      const t = (await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "完了と同時", basis: { kind: "declaration" } }] })).task;
      const rec = t.completionRecords![0];
      expect(rec.acceptance?.evidence?.[0].evidence).toBe("完了と同時");
      states.push(rec.quality.state);
      if (rec.quality.state === "invalid") expect(rec.quality.problems?.length).toBeGreaterThan(0);
      expect(rec.quality.version).toBe(ctx.ws.project.qualityVersion);
    }
    expect(states).toEqual(["unset", "set", "invalid"]);
  });

  it("読めない基準は problems として写し、完了は拒まない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace("rev: 1", "rev: 1\nacceptanceCriteria: 壊れた"));
    await ctx.ws.tasksOf(rid).reload(task.id);
    const t = (await updateTask(ctx, rid, task.id, { status: "done" })).task;
    expect(t.completionRecords?.[0].acceptance?.problems?.length).toBeGreaterThan(0);
  });
});

describe("参照先", () => {
  it("取得したコミットと未コミットの有無を残し、git でない・パスなし・パスが無いを理由つきで分ける。このマシンのパスは残さない", async () => {
    const { rid, root, dataDir } = await setup();
    const plain = tempDir("p3-plain-");
    await writeTestProject(dataDir, {
      milestones: [{ id: "v1", title: "v1" }],
      repos: [
        { name: "main", role: "本体", readFirst: true, writable: true, map: [] },
        { name: "plain", role: "資料", readFirst: false, writable: false, map: [] },
        { name: "gone", role: "x", readFirst: false, writable: false, map: [] },
        { name: "nopath", role: "x", readFirst: false, writable: false, map: [] },
      ],
    });
    const ctx2 = await openTestProject(dataDir, undefined, { repos: { main: root, plain, gone: join(plain, "nothing") } });
    const head = git(root, "rev-parse", "HEAD");
    const { task } = await createTask(ctx2, rid, { title: "作業" });
    const t = (await updateTask(ctx2, rid, task.id, { status: "done" })).task;
    const refs = Object.fromEntries((t.completionRecords?.[0].refs ?? []).map((r) => [r.name, r]));
    // .p3 のタスクを書いたので未コミットの変更がある
    expect(refs.main).toMatchObject({ state: "ok", commit: head, dirty: true });
    expect(refs.plain).toMatchObject({ state: "not_git" });
    expect(refs.gone).toMatchObject({ state: "missing" });
    expect(refs.nopath).toMatchObject({ state: "unregistered" });
    for (const r of Object.values(refs)) expect(r.at).toBeTruthy();
    const text = await readFile(join(dataDir, "requests", rid, "tasks", `${task.id}.md`), "utf8");
    expect(text).not.toContain(plain);
    expect(text).not.toContain(root);
  });
});

describe("旧データ・壊れた記録・競合", () => {
  it("記録の無い古いデータは補わず記録なし。壊れた記録は関係のない保存で消えず、完了は拒まずに足せなかったと知らせる", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "古い作業" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    // 直接編集で完了にした古いデータ
    await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", "status: done"));
    await ctx.ws.tasksOf(rid).reload(task.id);
    let t = (await updateTask(ctx, rid, task.id, { labels: ["x"] })).task;
    expect(t.status).toBe("done");
    expect(t.completionRecords).toBeUndefined();
    // 壊れた記録
    await writeFile(file, (await readFile(file, "utf8")).replace("status: done", "status: doing\ncompletionRecords:\n  - id: broken\n    trigger: what"));
    await ctx.ws.tasksOf(rid).reload(task.id);
    expect(ctx.ws.tasksOf(rid).require(task.id).completionProblems?.length).toBeGreaterThan(0);
    await updateTask(ctx, rid, task.id, { labels: ["y"] });
    expect(await readFile(file, "utf8")).toContain("id: broken");
    const r = await updateTask(ctx, rid, task.id, { status: "done" });
    expect(r.task.status).toBe("done");
    expect(r.completionSkipped).toMatch(/完了の記録が読めない/);
    expect(await readFile(file, "utf8")).toContain("trigger: what");
    expect(readCompletion({ completionRecords: "x" }).completionProblems).toEqual(["completionRecords が並びになっていません"]);
  });

  it("競合した更新は記録も状態も変えない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    const before = await readFile(file, "utf8");
    await expect(updateTask(ctx, rid, task.id, { status: "done" }, { expectedRev: 99 })).rejects.toThrow(ConflictError);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "ai:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI・API・一括完了", () => {
  it("CLI の move done・check と show で記録が残り読める", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    const moved = p3(dataDir, ["move", `${rid}/${task.id}`, "done", "--record", "変更の記録", "--json"]);
    expect(moved.code, moved.err).toBe(0);
    expect(JSON.parse(moved.out).completionRecords).toMatchObject([{ id: "C1", trigger: "task_done", by: "ai:test" }]);
    expect(p3(dataDir, ["check", `${rid}/${task.id}`, "--json"]).code).toBe(0);
    const shown = p3(dataDir, ["show", `${rid}/${task.id}`]);
    expect(shown.out).toContain("完了の記録");
    expect(shown.out).toContain("人の済み");
  });

  it("大きな --json の出力（64KB を超える）もパイプで途中で切れずに渡る", async () => {
    const { ctx, rid, dataDir } = await setup();
    await updateRequest(ctx, rid, { body: "長い本文。".repeat(20000) });
    const r = p3(dataDir, ["show", rid, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.length).toBeGreaterThan(70000);
    expect(JSON.parse(r.out).item.id).toBe(rid);
  });

  it("API の PATCH で完了すると記録が残り、記録の値をそのまま渡しても受け付けない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const forged = await send("PATCH", `/requests/${rid}/tasks/${task.id}`, { completionRecords: [{ id: "C9" }], labels: ["x"] });
    expect(((await forged.json()) as { completionRecords?: unknown }).completionRecords).toBeUndefined();
    const r = await send("PATCH", `/requests/${rid}/tasks/${task.id}`, { status: "done" });
    expect(((await r.json()) as { completionRecords: unknown[] }).completionRecords).toMatchObject([{ id: "C1", trigger: "task_done" }]);
    const req = await send("PATCH", `/requests/${rid}`, { status: "resolved", completionRecords: [] });
    expect(((await req.json()) as { completionRecords: unknown[] }).completionRecords).toMatchObject([{ id: "C1", trigger: "request_resolved" }]);
  });

  it("マイルストーンの一括完了でも要望の完了済の記録が残る", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "作業" });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateRequest(ctx, rid, { status: "resolved" });
    const plan = await completionPlan(ctx, "v1");
    const res = await completeMilestoneRequests(ctx, "v1", plan.basedOn, "human:a");
    expect(res.completed.map((x) => x.id)).toEqual([rid]);
    await ctx.ws.requests.reload(rid);
    expect(ctx.ws.requests.require(rid).completionRecords?.map((c) => [c.trigger, c.by])).toEqual([
      ["request_resolved", undefined],
      ["request_done", "human:a"],
    ]);
  });
});
