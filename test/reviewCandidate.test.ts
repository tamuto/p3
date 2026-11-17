import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qualityVersion, readQuality } from "../src/shared/quality.ts";
import { PremiseInputError } from "../src/shared/reviewCandidate.ts";
import { createTask, recordPremise, updateRequest, updateRequirement, updateTask } from "../src/core/requestOps.ts";
import { listTasks, progress } from "../src/core/ops.ts";
import { requestReview, reviewCandidates, taskReview } from "../src/core/reviewCandidates.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import type { Workspace } from "../src/core/store/workspace.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, MAIN_REF, newRequest, tempDir } from "./helpers.ts";

/**
 * 見直しが必要（候補）の診断と前提の変更（shared/reviewCandidate.ts・core/reviewCandidates.ts）: 理由と当時・今の値、関係のない変更では
 * 候補にしない、前提の変更の明示、状態を変えない、記録なし・比較不能・差分なし、CLI・API を確かめる
 */

const OTHER = { name: "other", role: "別", readFirst: false, writable: true, map: [] };
const std = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, check: { kind: "machine", command: "pnpm test", success: "exit 0" }, ...extra });

function setQuality(ws: Workspace, raw: unknown) {
  const q = readQuality(raw, ws.project.repos.map((r) => r.name));
  ws.project.quality = q;
  ws.project.qualityVersion = qualityVersion(q, raw);
}

async function setup() {
  const p = await makeProject({ repos: [MAIN_REF, OTHER] });
  // CLI も同じ品質基準を読むよう project.yaml に書く
  const q = readQuality({ standards: [std("Q1", "テストを通す"), std("Q2", "lint を通す"), std("Q3", "別の参照先", { repos: ["other"] })] }, ["main", "other"]);
  if (q.state !== "set") throw new Error("品質基準が読めません");
  await p.ctx.ws.writeQuality(() => q.config);
  const r = await newRequest(p.ctx, { title: "請求", body: "月末締め" });
  await updateRequirement(p.ctx, r.id, [{ op: "add", target: "税は切り捨て", source: "経理規程 3.2", basis: "例" }]);
  const { task } = await createTask(p.ctx, r.id, { title: "実装", criteria: ["税を計算する"], repo: "main" });
  await updateTask(p.ctx, r.id, task.id, { acceptance: [{ op: "source", id: "A1", source: { op: "add", from: "S1" } }] });
  await updateTask(p.ctx, r.id, task.id, { status: "done" });
  await updateTask(p.ctx, r.id, task.id, { checked: true });
  await updateRequest(p.ctx, r.id, { status: "resolved" });
  return { ...p, rid: r.id, tid: task.id, ref: `${r.id}/${task.id}` };
}

describe("理由と当時・今の値", () => {
  it("当てはまる品質基準の追加・変更・削除・除外と、基準の文・写した元の根拠の変更を理由にする", async () => {
    const { ctx, rid, tid, ref } = await setup();
    const t = () => ctx.ws.tasksOf(rid).require(tid);
    expect(taskReview(ctx, t())).toMatchObject({ target: ref, state: "none", record: "C2", reasons: [] });
    // Q1 を変え、Q2 を除外、Q4 を足し、Q3 を main にも当てる
    setQuality(ctx.ws, { standards: [std("Q1", "テストを全部通す"), std("Q2", "lint を通す", { exempt: { reason: "移行中" } }), std("Q3", "別の参照先", { repos: ["other", "main"] }), std("Q4", "型検査")] });
    const d = taskReview(ctx, t())!;
    expect(d.state).toBe("candidate");
    expect(d.qualityVersion).toBe(ctx.ws.project.qualityVersion);
    const by = Object.fromEntries(d.reasons.map((r) => [`${r.code}:${r.target}`, r]));
    expect(by["quality_changed:Q1"]).toMatchObject({ was: "テストを通す（検査: pnpm test（成功: exit 0））", now: "テストを全部通す（検査: pnpm test（成功: exit 0））" });
    expect(by["quality_exempted:Q2"]?.now).toContain("移行中");
    expect(by["quality_added:Q3"]).toBeTruthy();
    expect(by["quality_added:Q4"]?.now).toMatch(/^型検査/);
    // 品質を戻すと候補は消える（現在差分方式）
    setQuality(ctx.ws, { standards: [std("Q1", "テストを通す"), std("Q2", "lint を通す"), std("Q3", "別の参照先", { repos: ["other"] })] });
    expect(taskReview(ctx, t())!.state).toBe("none");
    // 写した元の要望の根拠を変える
    await updateRequirement(ctx, rid, [{ op: "edit", id: "S1", basis: "新しい例" }]);
    const s = taskReview(ctx, t())!;
    expect(s.reasons).toEqual([expect.objectContaining({ code: "source_changed", target: "S1", related: ["A1/S1"], was: expect.stringContaining("例"), now: expect.stringContaining("新しい例") })]);
    // 要望自身も根拠の変更で候補
    expect(requestReview(ctx, rid).self).toMatchObject({ state: "candidate", reasons: [expect.objectContaining({ code: "source_changed", target: "S1" })] });
  });

  it("品質の設定が未設定・読めないになったら状態の変化（読めないは比べられない部分も）を返す", async () => {
    const { ctx, rid, tid } = await setup();
    setQuality(ctx.ws, undefined);
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!.reasons).toEqual([expect.objectContaining({ code: "quality_state", was: "設定済", now: "未設定" })]);
    setQuality(ctx.ws, { standards: "壊れた" });
    const d = taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!;
    expect(d.reasons[0]).toMatchObject({ code: "quality_state", now: "読めない" });
    expect(d.unreadable?.[0]).toMatch(/今の品質基準が読めない/);
  });
});

describe("関係のない変更では候補にしない", () => {
  it("別の作業先だけの品質の変更・品質の版だけの違い・参照先の HEAD の更新では候補にならない", async () => {
    const { ctx, rid, tid, root } = await setup();
    // Q3（other だけ）を変える・Q5（other だけ）を足す → 設定全体の版は変わる
    const before = ctx.ws.project.qualityVersion;
    setQuality(ctx.ws, { standards: [std("Q1", "テストを通す"), std("Q2", "lint を通す"), std("Q3", "別の参照先を直す", { repos: ["other"] }), std("Q5", "other の検査", { repos: ["other"] })] });
    expect(ctx.ws.project.qualityVersion).not.toBe(before);
    // 参照先の HEAD を進める
    spawnSync("git", ["-C", root, "commit", "-q", "--allow-empty", "-m", "next"], { encoding: "utf8" });
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!.state).toBe("none");
    expect(reviewCandidates(ctx)).toEqual([]);
  });
});

describe("前提の変更", () => {
  it("対象と理由を明示すると、指定した完了済みとその要望の概要に候補が出る。確認の記録か、もう一度済みにすると外れる", async () => {
    const { ctx, rid, tid, ref } = await setup();
    const { change } = await recordPremise(ctx, rid, { op: "add", targets: [tid], reason: "セキュリティ基準 2026 の改版", condition: "基準 v2" }, { actor: "human:a" });
    expect(change).toMatchObject({ id: "P1", targets: [tid], by: "human:a" });
    const d = taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!;
    expect(d.reasons).toEqual([expect.objectContaining({ code: "premise_changed", target: "P1", related: [tid], now: expect.stringContaining("基準 v2") })]);
    const review = requestReview(ctx, rid);
    expect(review.self?.state).toBe("none");
    expect(review.counts).toMatchObject({ tasks: 1, below: 0 });
    expect(review.tasks[tid]).toMatchObject({ state: "candidate", codes: ["premise_changed"] });
    expect(progress(ctx).find((p) => p.request.id === rid)?.review).toMatchObject({ tasks: 1, below: 0 });
    expect(listTasks(ctx, { review: true }).map((t) => t.ref)).toEqual([ref]);
    // 確認を記録すると外れる
    await recordPremise(ctx, rid, { op: "ack", id: "P1", target: tid, condition: "基準 v2 を確かめた" });
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!.state).toBe("none");
    // 要望の根拠を対象にした変更 → 写したタスクと要望自身
    await recordPremise(ctx, rid, { op: "add", targets: ["S1"], reason: "経理規程の改定", condition: "第4版" });
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!.reasons.map((r) => r.target)).toEqual(["P2"]);
    expect(requestReview(ctx, rid).self?.reasons.map((r) => r.target)).toEqual(["P2"]);
    // もう一度済みにすると新しい記録が基点になり、その前の変更は外れる
    await updateTask(ctx, rid, tid, { checked: false });
    await updateTask(ctx, rid, tid, { checked: true });
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))).toMatchObject({ state: "none", record: "C3" });
  });

  it("子の要望の候補は親の配下に数え、完了していない親自身は候補にしない", async () => {
    const { ctx, rid } = await setup();
    await updateRequest(ctx, rid, { status: "active" });
    const child = await newRequest(ctx, { title: "子", parent: rid });
    const { task } = await createTask(ctx, child.id, { title: "子の作業", repo: "main" });
    await updateTask(ctx, child.id, task.id, { status: "done" });
    await recordPremise(ctx, child.id, { op: "add", targets: [task.id], reason: "外部 API の仕様変更", condition: "v3" });
    const parent = requestReview(ctx, rid);
    expect(parent.self).toBeUndefined();
    expect(parent.counts).toMatchObject({ tasks: 0, below: 1 });
  });

  it("対象が無い・規則に合わない・rev の競合では何も書かない。診断と記録で状態・済み・基準・証拠・過去の記録は変わらない", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const reqFile = join(dataDir, "requests", rid, "request.md");
    const taskFile = join(dataDir, "requests", rid, "tasks", `${tid}.md`);
    const req0 = await readFile(reqFile, "utf8");
    const task0 = await readFile(taskFile, "utf8");
    await expect(recordPremise(ctx, rid, { op: "add", targets: ["T009"], reason: "r", condition: "c" })).rejects.toThrow(PremiseInputError);
    await expect(recordPremise(ctx, rid, { op: "add", targets: [tid], reason: " ", condition: "c" })).rejects.toThrow(/理由/);
    await expect(recordPremise(ctx, rid, { op: "ack", id: "P9", target: tid, condition: "c" })).rejects.toThrow(/P9 はありません/);
    await expect(recordPremise(ctx, rid, { op: "add", targets: [tid], reason: "r", condition: "c" }, { expectedRev: 1 })).rejects.toThrow(ConflictError);
    expect(await readFile(reqFile, "utf8")).toBe(req0);
    // 診断を何度しても同じで、ファイルは書かない
    const a = JSON.stringify([reviewCandidates(ctx), requestReview(ctx, rid), progress(ctx)]);
    const b = JSON.stringify([reviewCandidates(ctx), requestReview(ctx, rid), progress(ctx)]);
    expect(a).toBe(b);
    await recordPremise(ctx, rid, { op: "add", targets: [tid, rid], reason: "r", condition: "c" });
    expect(await readFile(taskFile, "utf8")).toBe(task0);
    const r = ctx.ws.requests.require(rid);
    expect(r.status).toBe("resolved");
    expect(r.completionRecords?.length).toBe(1);
    expect(requestReview(ctx, rid).self?.state).toBe("candidate");
  });
});

describe("記録なし・比較不能・差分なし", () => {
  it("記録の無い完了・読めない記録・差分なしを候補ありと分け、完了した要望・済みのタスクも一覧の絞り込みで見つかる", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "古い作業" });
    const file = join(dataDir, "requests", rid, "tasks", `${task.id}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", "status: done"));
    await ctx.ws.tasksOf(rid).reload(task.id);
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(task.id))).toMatchObject({ state: "no_record", reasons: [] });
    await writeFile(file, (await readFile(file, "utf8")).replace("status: done", "status: done\ncompletionRecords: 壊れた"));
    await ctx.ws.tasksOf(rid).reload(task.id);
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(task.id))).toMatchObject({ state: "unreadable" });
    expect(taskReview(ctx, ctx.ws.tasksOf(rid).require(tid))!.state).toBe("none");
    // 完了済みの要望・済みのタスクの候補
    await updateRequest(ctx, rid, { status: "done" });
    await recordPremise(ctx, rid, { op: "add", targets: [tid, rid], reason: "r", condition: "c" });
    expect(reviewCandidates(ctx).map((d) => d.target).sort()).toEqual([`${rid}/${tid}`, rid].sort());
    expect(listTasks(ctx, { review: true }).map((t) => t.id)).toEqual([tid]);
  });
});

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI と API", () => {
  it("p3 premise add・ack と revisit・ls --review・show・progress --all。不正な対象は理由を返して書かない", async () => {
    const { rid, tid, dataDir } = await setup();
    const bad = p3(dataDir, ["premise", rid, "add", "--target", "T009", "--reason", "r", "--condition", "c"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/対象がありません: T009/);
    const add = p3(dataDir, ["premise", rid, "add", "--target", tid, "--reason", "基準の改版", "--condition", "v2", "--json"]);
    expect(add.code, add.err).toBe(0);
    expect(JSON.parse(add.out).change).toMatchObject({ id: "P1", targets: [tid], by: "human:test" });
    const revisit = p3(dataDir, ["revisit", "--all", "--json"]);
    expect(JSON.parse(revisit.out)).toEqual([expect.objectContaining({ target: `${rid}/${tid}`, state: "candidate" })]);
    expect(p3(dataDir, ["revisit", "--all"]).out).toContain("前提の変更が記録された");
    expect(p3(dataDir, ["ls", "--all", "--review"]).out).toContain(tid);
    const shown = p3(dataDir, ["show", `${rid}/${tid}`]);
    expect(shown.out).toContain("見直し: 見直しが必要（候補）");
    expect(shown.out).toContain("今:   基準の改版（新しい条件: v2）");
    expect(p3(dataDir, ["show", rid]).out).toContain("見直しが必要（候補）: タスク 1 件");
    expect(p3(dataDir, ["progress", "--all"]).out).toContain("※見直し候補（タスク 1）");
    const ack = p3(dataDir, ["premise", rid, "ack", "P1", "--target", tid, "--condition", "v2 を確かめた"]);
    expect(ack.code, ack.err).toBe(0);
    expect(p3(dataDir, ["revisit", "--all"]).out).toContain("見直しが必要（候補）はありません");
    expect(p3(dataDir, ["premise", rid]).out).toContain("確認: T001");
  });

  it("API の premises・revisit・詳細の review・タスクの ?review=true。不正・競合は何も書かない", async () => {
    const { ctx, rid, tid } = await setup();
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const bad = await send("POST", `/requests/${rid}/premises`, { op: "add", targets: ["S9"], reason: "r", condition: "c" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("premise_invalid");
    const conflict = await send("POST", `/requests/${rid}/premises`, { op: "add", targets: [tid], reason: "r", condition: "c", rev: 1 });
    expect(conflict.status).toBe(409);
    expect(ctx.ws.requests.require(rid).premiseChanges).toBeUndefined();
    const ok = await send("POST", `/requests/${rid}/premises`, { op: "add", targets: [tid], reason: "r", condition: "c" });
    expect(ok.status).toBe(200);
    expect(((await (await send("GET", `/revisit`)).json()) as { target: string }[]).map((d) => d.target)).toEqual([`${rid}/${tid}`]);
    const detail = (await (await send("GET", `/requests/${rid}/tasks/${tid}`)).json()) as { review: { state: string; reasons: { code: string }[] } };
    expect(detail.review).toMatchObject({ state: "candidate", reasons: [{ code: "premise_changed" }] });
    const req = (await (await send("GET", `/requests/${rid}`)).json()) as { review: { counts: { tasks: number } } };
    expect(req.review.counts.tasks).toBe(1);
    expect(((await (await send("GET", `/requests/${rid}/tasks?review=true`)).json()) as { id: string }[]).map((t) => t.id)).toEqual([tid]);
    expect(((await (await send("GET", `/requests/${rid}/premises`)).json()) as unknown[]).length).toBe(1);
  });
});
