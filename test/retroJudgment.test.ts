import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { confirmRetrospectiveTarget, judgeRisk, retrospectiveView } from "../src/core/retrospective.ts";
import { createRequest, createTask, updateRequest, updateTask } from "../src/core/requestOps.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { git, makeProject, newRequest, tempDir } from "./helpers.ts";

/**
 * リスクの確認（shared/retrospective.ts の addJudgment・core/retrospective.ts の judgeRisk）: 三状態と件数、根拠の照合（タスクレビュー・
 * マイルストーンレビュー・手戻り・人の参照）と範囲外の拒否、判断に要るもの、訂正の履歴、対象の訂正・根拠の差し替えの後の読み方、
 * 同時保存、見送りの除外、振り返りが無くても完了できること、CLI・API を確かめる
 */

async function setup() {
  const p = await makeProject({ milestones: [{ id: "v1", title: "v1", goals: [{ id: "G1", text: "請求書を出せる" }] }] });
  writeFileSync(join(p.root, ".gitignore"), ".p3/\n");
  writeFileSync(join(p.root, "a.ts"), "a\n");
  git(p.root, "add", "-A");
  git(p.root, "commit", "-qm", "x");
  const sha = git(p.root, "rev-parse", "HEAD");
  const req = await newRequest(p.ctx, { title: "請求", status: "active", body: "- 案 A\n- 案 B", milestone: "v1" });
  const rid = req.id;
  const patchRun = async (run: string, fn: (j: Record<string, unknown>) => void) => {
    const file = join(p.ctx.ws.preflight.runDir(rid, run), "run.json");
    const j = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    fn(j);
    await writeFile(file, JSON.stringify(j, null, 2));
  };
  const preflight = async (risks: string[]) => {
    const { id } = await p.ctx.preflight.start(rid, { engine: "mock" });
    await p.ctx.preflight.wait(rid, id);
    await patchRun(id, (j) => ((j.assessment as { risks: string[] }).risks = risks));
    await p.ctx.preflight.materialize(rid, id);
    return id;
  };
  const run1 = await preflight(["性能が落ちる", "既存の CSV が壊れる", "性能が落ちる"]);
  await confirmRetrospectiveTarget(p.ctx, rid, { run: run1 }, { actor: "human:a" });
  // T001 を完了→済み→再開（手戻り R1）、T002 を完了してレビュー
  await updateTask(p.ctx, rid, "T001", { status: "done", outputs: [`https://example.com/commit/${sha}`] });
  await updateTask(p.ctx, rid, "T001", { checked: true });
  await updateTask(p.ctx, rid, "T001", { status: "doing" });
  await updateTask(p.ctx, rid, "T002", { status: "done", outputs: [`https://example.com/commit/${sha}`] });
  const tr = await p.ctx.taskReview.start(rid, "T002", "human:a", { engine: "mock" });
  await p.ctx.taskReview.wait(rid, "T002", tr.id);
  const mr = await p.ctx.milestoneReview.start("v1", "human:a", "mock");
  await p.ctx.milestoneReview.wait("v1", mr.id);
  return { ...p, rid, run1, preflight, tr: tr.id, mr: mr.id };
}

describe("三状態と根拠", () => {
  it("根拠を結び付けるだけでは未確認のまま。起きたには事実と根拠、起きなかったには範囲と根拠が要る。件数は今の対象だけ", async () => {
    const { ctx, rid, tr } = await setup();
    let v = await retrospectiveView(ctx, rid);
    expect(v.counts).toEqual({ occurred: 0, not_occurred: 0, unchecked: 3 });
    v = await judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "task_review", task: "T002", run: tr, section: "items", index: 0 }] }, { actor: "human:a" });
    expect(v.risks[0]).toMatchObject({ state: "unchecked", judgment: { id: "J1", evidence: [{ kind: "task_review", request: rid, task: "T002", excerpt: expect.stringContaining("A1: undetermined") }] } });
    await expect(judgeRisk(ctx, rid, { risk: 1, state: "occurred", evidence: [{ kind: "rework", task: "T001", history: "R1" }] })).rejects.toThrow(/事実/);
    await expect(judgeRisk(ctx, rid, { risk: 1, state: "occurred", facts: "CSV が読めなくなった", evidence: [] })).rejects.toThrow(/根拠/);
    await expect(judgeRisk(ctx, rid, { risk: 2, state: "not_occurred", evidence: [{ kind: "manual", reference: "負荷試験の結果" }] })).rejects.toThrow(/範囲/);
    v = await judgeRisk(ctx, rid, { risk: 1, state: "occurred", facts: "T001 の再開で CSV の読み込みを直した", evidence: [{ kind: "rework", task: "T001", history: "R1" }] }, { actor: "human:a" });
    v = await judgeRisk(ctx, rid, { risk: 2, state: "not_occurred", scope: "v1 の請求 1 万件での負荷試験（2026-11）", evidence: [{ kind: "manual", reference: "https://example.com/perf.md" }] }, { actor: "human:b" });
    expect(v.counts).toEqual({ occurred: 1, not_occurred: 1, unchecked: 1 });
    // 同文のリスク（1 番目と 3 番目）は位置で分ける
    expect(v.risks.map((r) => [r.text, r.state])).toEqual([["性能が落ちる", "unchecked"], ["既存の CSV が壊れる", "occurred"], ["性能が落ちる", "not_occurred"]]);
    expect(v.checks[v.risks[1].judgment!.id]).toEqual(["ok"]);
    expect(v.checks[v.risks[2].judgment!.id]).toEqual(["manual"]);
  });

  it("要望の外のタスクレビュー・直接の対象でないマイルストーンレビュー・無い所見と履歴は拒み、全体の所見は結び付く理由が要る", async () => {
    const { ctx, rid, tr, mr } = await setup();
    const other = await newRequest(ctx, { title: "別", status: "active" });
    await createTask(ctx, other.id, { title: "別の作業" });
    await expect(judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "task_review", task: "T009", run: tr, section: "items" }] })).rejects.toThrow(/この要望のタスクにありません/);
    await expect(judgeRisk(ctx, other.id, { risk: 0, state: "unchecked", evidence: [] })).rejects.toThrow(/確定していません/);
    await expect(judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "task_review", task: "T002", run: tr, section: "checks", index: 0 }] })).rejects.toThrow(/所見がありません/);
    await expect(judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "rework", task: "T001", history: "R9" }] })).rejects.toThrow(/R9 はありません/);
    await expect(judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "milestone_review", milestone: "v1", run: mr, section: "overall" }] })).rejects.toThrow(/結び付く理由/);
    const v = await judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: [{ kind: "milestone_review", milestone: "v1", run: mr, section: "units", index: 0, reason: "請求書の出力が性能の懸念の対象" }] });
    expect(v.risks[0].judgment?.evidence[0]).toMatchObject({ kind: "milestone_review", reason: "請求書の出力が性能の懸念の対象", excerpt: expect.stringContaining("G1: insufficient") });
    // 直接の対象でない要望（マイルストーンが違う）から同じ所見は結び付けられない
    const outside = await newRequest(ctx, { title: "外", status: "active", body: "- x\n- y" });
    const { id } = await ctx.preflight.start(outside.id, { engine: "mock" });
    await ctx.preflight.wait(outside.id, id);
    await ctx.preflight.materialize(outside.id, id);
    const file = join(ctx.ws.preflight.runDir(outside.id, id), "run.json");
    const j = JSON.parse(await readFile(file, "utf8")) as { assessment: { risks: string[] } };
    j.assessment.risks = ["r"];
    await writeFile(file, JSON.stringify(j));
    await confirmRetrospectiveTarget(ctx, outside.id, { run: id });
    await expect(judgeRisk(ctx, outside.id, { risk: 0, state: "unchecked", evidence: [{ kind: "milestone_review", milestone: "v1", run: mr, section: "units", reason: "r" }] })).rejects.toThrow(/直接の対象ではありません/);
  });
});

describe("訂正と読み方", () => {
  it("判断の変更・未確認へ戻すには理由が要り、以前の判断・申告者・日時・理由が残る", async () => {
    const { ctx, rid } = await setup();
    await judgeRisk(ctx, rid, { risk: 1, state: "occurred", facts: "f", evidence: [{ kind: "rework", task: "T001", history: "R1" }] }, { actor: "human:a" });
    await expect(judgeRisk(ctx, rid, { risk: 1, state: "unchecked", evidence: [] })).rejects.toThrow(/理由/);
    const v = await judgeRisk(ctx, rid, { risk: 1, state: "unchecked", reason: "R1 は別の原因だった", evidence: [] }, { actor: "human:b" });
    expect(v.risks[1].state).toBe("unchecked");
    expect(v.risks[1].history.map((j) => [j.state, j.by, j.reason])).toEqual([
      ["occurred", "human:a", undefined],
      ["unchecked", "human:b", "R1 は別の原因だった"],
    ]);
  });

  it("対象を訂正しても以前の判断と当時の抜粋は元の対象で読め、件数は新しい対象だけ。根拠の差し替え・欠けは照合で分かる", async () => {
    const { ctx, rid, tr, preflight } = await setup();
    await judgeRisk(ctx, rid, { risk: 0, state: "occurred", facts: "遅くなった", evidence: [{ kind: "task_review", task: "T002", run: tr, section: "overall" }] });
    // レビューの結果を差し替える
    const reviewFile = join(ctx.ws.taskReviews.runDir(`${rid}/T002`, tr), "review.json");
    const r = JSON.parse(await readFile(reviewFile, "utf8")) as { overall: string };
    r.overall = "差し替えた所見";
    await writeFile(reviewFile, JSON.stringify(r));
    let v = await retrospectiveView(ctx, rid);
    const j = v.judgments[0];
    expect(v.checks[j.id]).toEqual(["changed"]);
    expect(j.evidence[0]).toMatchObject({ excerpt: "（Mock）評価していません" });
    // 対象を訂正する（別の run）
    const run2 = await preflight(["新しいリスク"]);
    v = await confirmRetrospectiveTarget(ctx, rid, { run: run2, reason: "採用し直した" });
    expect(v.counts).toEqual({ occurred: 0, not_occurred: 0, unchecked: 1 });
    expect(v.judgments[0]).toMatchObject({ target: "V1", riskText: "性能が落ちる", state: "occurred" });
    // 子の要望に付け替えても、保存した参照先（要望 ID）で読む
    const parent = await createRequest(ctx, { title: "親" });
    await updateRequest(ctx, rid, { parent: parent.id });
    expect((await retrospectiveView(ctx, rid)).judgments[0].evidence[0]).toMatchObject({ request: rid, task: "T002" });
  });

  it("同時の保存は片方だけ通り、見送りの要望は候補にならず、振り返りが無くても完了・対応済にできる", async () => {
    const { ctx, rid } = await setup();
    const ev = [{ kind: "manual" as const, reference: "x" }];
    const res = await Promise.allSettled([
      judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: ev }, { expectedVersion: 1 }),
      judgeRisk(ctx, rid, { risk: 0, state: "unchecked", evidence: ev }, { expectedVersion: 1 }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const plain = await newRequest(ctx, { title: "振り返りなし", status: "active" });
    const { task } = await createTask(ctx, plain.id, { title: "作業" });
    await updateTask(ctx, plain.id, task.id, { status: "done" });
    expect((await updateRequest(ctx, plain.id, { status: "resolved" })).status).toBe("resolved");
    await updateRequest(ctx, plain.id, { status: "rejected" });
    expect((await retrospectiveView(ctx, plain.id)).none).toMatch(/見送り/);
  });
});

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI と API", () => {
  it("p3 retro judge と API で同じ原文・三状態の件数を読み、範囲外の根拠は拒む", async () => {
    const { ctx, rid, tr, dataDir } = await setup();
    const bad = p3(dataDir, ["retro", rid, "judge", "1", "--state", "unchecked", "--evidence", "rework:T009:R1"]);
    expect(bad.code).toBe(1);
    const ok = p3(dataDir, ["retro", rid, "judge", "2", "--state", "occurred", "--facts", "CSV が壊れた", "--evidence", "rework:T001:R1", "--evidence", `review:T002:${tr}:overall`, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(JSON.parse(ok.out).counts).toEqual({ occurred: 1, not_occurred: 0, unchecked: 2 });
    const shown = p3(dataDir, ["retro", rid]).out;
    expect(shown).toContain("起きた 1・起きなかった 0・未確認 2");
    expect(shown).toContain("2. [起きた] 既存の CSV が壊れる");
    expect(shown).toContain("当時の抜粋: R1  完了から戻した・済みが外れた");
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const v = (await (await send("GET", `/requests/${rid}/retrospective`)).json()) as { counts: object; risks: { text: string }[] };
    expect(v.counts).toEqual({ occurred: 1, not_occurred: 0, unchecked: 2 });
    expect(v.risks.map((r) => r.text)).toEqual(["性能が落ちる", "既存の CSV が壊れる", "性能が落ちる"]);
    expect((await send("POST", `/requests/${rid}/retrospective/judgments`, { risk: 0, state: "occurred", evidence: [] })).status).toBe(400);
    const r = await send("POST", `/requests/${rid}/retrospective/judgments`, { risk: 0, state: "not_occurred", scope: "負荷試験", evidence: [{ kind: "manual", reference: "perf" }], version: 2 });
    expect(r.status, await r.clone().text()).toBe(200);
  });
});
