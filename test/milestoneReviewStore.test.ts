// マイルストーンレビューの比較材料と履歴: 全状態の要望・未完了・見送り・材料なし・読込の欠落、親子/別所属/アーカイブの範囲、
// 目標と本文の変更の検出、日時だけでは hash が変わらないこと、履歴の破損と不存在の区別、パスの検証、上書きの拒否、状態遷移と排他、
// 削除の保護、抽出と保存が要望・ノート・リリース済みを変えないことを確かめる（エンジンは使わない）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractReviewInput, reviewUnits } from "../src/core/milestoneReview/material.ts";
import { MilestoneReviewStore, ReviewStoreError, newReviewRunId } from "../src/core/milestoneReview/store.ts";
import { archiveRequest, checkMilestoneRemoval } from "../src/core/requestOps.ts";
import type { ReviewRun } from "../src/shared/milestoneReview.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

const MS = [{ id: "v1", title: "最初", purpose: "在庫の確認を速くする", goals: [{ id: "G1", text: "在庫の一覧" }, { id: "G2", text: "通知" }] }, { id: "v2", title: "次" }];

async function setup() {
  const p = await makeProject({ milestones: MS });
  const { ctx } = p;
  const done = await newRequest(ctx, { title: "一覧", body: "在庫を一覧で見たい", milestone: "v1", status: "resolved" });
  await newTask(ctx, done.id, { title: "一覧画面", body: "表を作る", status: "done", record: "在庫の一覧を表示できるようにした", outputs: ["https://example.com/pull/1"] });
  const open = await newRequest(ctx, { title: "通知", body: "在庫切れを知らせる", milestone: "v1", status: "active" });
  await newTask(ctx, open.id, { title: "通知の送信", status: "doing" });
  await newTask(ctx, open.id, { title: "記録なしで完了", status: "done" });
  const rejected = await newRequest(ctx, { title: "CSV", body: "CSV で出す", milestone: "v1", status: "rejected" });
  const draft = await newRequest(ctx, { title: "下書き", milestone: "v1", status: "draft" });
  return { ...p, done, open, rejected, draft };
}

const runOf = (mid: string, inputHash: string, patch: Partial<ReviewRun> = {}): ReviewRun => ({
  id: newReviewRunId(),
  milestone: mid,
  status: "running",
  engine: "mock",
  startedAt: new Date().toISOString(),
  inputHash,
  log: [],
  ...patch,
});

describe("比較材料", () => {
  it("直接属する全状態の要望・タスクの本文・状態・記録・成果物を持ち、未完了・見送り・記録なしも省かない", async () => {
    const { dataDir, done, open, rejected, draft } = await setup();
    const i = await extractReviewInput(dataDir, "v1");
    expect(i.milestone).toMatchObject({ id: "v1", known: true, purpose: "在庫の確認を速くする" });
    expect(i.units.map((u) => u.id)).toEqual(["G1", "G2"]);
    expect(i.requests.map((r) => [r.id, r.status])).toEqual([
      [done.id, "resolved"],
      [open.id, "active"],
      [rejected.id, "rejected"],
      [draft.id, "draft"],
    ]);
    expect(i.requests[0].body).toBe("在庫を一覧で見たい");
    expect(i.requests[0].tasks[0]).toMatchObject({ status: "done", body: "表を作る", record: "在庫の一覧を表示できるようにした", outputs: ["https://example.com/pull/1"] });
    expect(i.requests[1].tasks.map((t) => t.status)).toEqual(["doing", "done"]);
    expect(i.warnings.map((w) => w.code)).toEqual(["missing_record"]);
    expect(i.scope).toContain("ソースコードの妥当性");
  });

  it("目的だけなら目的が比較単位。目的も予定機能も無い・要望 0 件・知らないマイルストーンは警告にする", async () => {
    expect(reviewUnits({ purpose: "目的" })).toEqual([{ id: "purpose", text: "目的" }]);
    expect(reviewUnits({})).toEqual([]);
    const { dataDir } = await setup();
    const v2 = await extractReviewInput(dataDir, "v2");
    expect(v2.units).toEqual([]);
    expect(v2.warnings.map((w) => w.code)).toEqual(["no_goals", "no_requests"]);
    expect((await extractReviewInput(dataDir, "nope")).warnings[0].code).toBe("unknown_milestone");
  });

  it("別のマイルストーンの親・子は文脈で、直接の材料に数えない。アーカイブは含めない。読めない要望・タスクは警告", async () => {
    const { ctx, dataDir, done } = await setup();
    const child = await newRequest(ctx, { title: "子", milestone: "v2", parent: done.id });
    const same = await newRequest(ctx, { title: "同じ所属の子", milestone: "v1", parent: done.id });
    const gone = await newRequest(ctx, { title: "消した", milestone: "v1" });
    await archiveRequest(ctx, gone.id);
    mkdirSync(join(dataDir, "requests", "261101-zzzzz"), { recursive: true });
    writeFileSync(join(dataDir, "requests", "261101-zzzzz", "request.md"), "---\nid: [\n---\n");
    mkdirSync(join(dataDir, "requests", done.id, "tasks"), { recursive: true });
    writeFileSync(join(dataDir, "requests", done.id, "tasks", "T009.md"), "---\nid: [\n---\n");
    const i = await extractReviewInput(dataDir, "v1");
    const ids = i.requests.map((r) => r.id);
    expect(ids).toContain(same.id);
    expect(ids).not.toContain(child.id);
    expect(ids).not.toContain(gone.id);
    expect(i.requests.find((r) => r.id === done.id)?.children?.map((c) => c.id).sort()).toEqual([child.id, same.id].sort());
    expect(i.context).toEqual([{ id: child.id, title: "子", status: "active", milestone: "v2", relation: "child", of: done.id }]);
    expect(i.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["broken_request", "broken_task"]));
  });

  it("hash は目的・予定機能・本文・状態・記録の変更で変わり、抽出の日時だけでは変わらない。抽出は何も変えない", async () => {
    const { ctx, dataDir, done } = await setup();
    const yaml = readFileSync(join(dataDir, "project.yaml"), "utf8");
    const a = await extractReviewInput(dataDir, "v1");
    await new Promise((r) => setTimeout(r, 5));
    const b = await extractReviewInput(dataDir, "v1");
    expect(b.extractedAt).not.toBe(a.extractedAt);
    expect(b.hash).toBe(a.hash);
    expect(readFileSync(join(dataDir, "project.yaml"), "utf8")).toBe(yaml);
    await ctx.ws.updateMilestones((ms) => ms.map((m) => (m.id === "v1" ? { ...m, goals: [...(m.goals ?? []), { id: "G3", text: "CSV" }] } : m)));
    const c = await extractReviewInput(dataDir, "v1");
    expect(c.hash).not.toBe(a.hash);
    await ctx.ws.requests.update(done.id, { body: "本文を直した" }, { actor: "test" });
    expect((await extractReviewInput(dataDir, "v1")).hash).not.toBe(c.hash);
  });
});

describe("履歴", () => {
  it("作る・読む・一覧。終わったら変えない。completed は結果を書いてから。同じ run は上書きしない", async () => {
    const { dataDir } = await setup();
    const store = new MilestoneReviewStore(dataDir);
    const input = await extractReviewInput(dataDir, "v1");
    const run = runOf("v1", input.hash);
    await store.create(input, run);
    await expect(store.create(input, run)).rejects.toMatchObject({ code: "exists" });
    expect(await store.hasHistory("v1")).toBe(true);
    expect(await store.milestones()).toEqual(["v1"]);
    const result = { overall: "おおむね", units: [{ unit: "G1", verdict: "achieved" as const, reason: "記録がある", evidence: ["x"], gaps: [] }], scope: input.scope };
    await expect(store.finish("v1", run.id, { status: "completed" })).rejects.toThrow("結果");
    const fin = await store.finish("v1", run.id, { status: "completed" }, result);
    expect(fin.status).toBe("completed");
    await expect(store.finish("v1", run.id, { status: "failed", error: "遅い" })).rejects.toMatchObject({ code: "finished" });
    await expect(store.updateRunning("v1", run.id, (r) => r)).rejects.toMatchObject({ code: "finished" });
    const rec = await store.get("v1", run.id);
    expect(rec.result?.overall).toBe("おおむね");
    expect(rec.input?.hash).toBe(input.hash);
    const list = await store.list("v1");
    expect(list[0]).toMatchObject({ state: "ok", verdicts: { achieved: 1 }, purpose: "在庫の確認を速くする" });
  });

  it("壊れた記録は broken、無い記録は not_found。パスの ID は確かめる", async () => {
    const { dataDir } = await setup();
    const store = new MilestoneReviewStore(dataDir);
    const input = await extractReviewInput(dataDir, "v1");
    const run = runOf("v1", input.hash);
    await store.create(input, run);
    writeFileSync(join(store.runDir("v1", run.id), "run.json"), "{ 壊れ");
    await expect(store.get("v1", run.id)).rejects.toMatchObject({ code: "broken" });
    expect((await store.list("v1"))[0]).toMatchObject({ state: "broken", id: run.id });
    await expect(store.get("v1", "MR-20260101-000000-abcd")).rejects.toMatchObject({ code: "not_found" });
    for (const bad of ["..", ".", "a/b", ""]) expect(() => store.milestoneDir(bad)).toThrow(ReviewStoreError);
    for (const bad of ["..", "MR-1", "../MR-20260101-000000-abcd"]) expect(() => store.runDir("v1", bad)).toThrow(ReviewStoreError);
  });

  it("状態を変えるロックは1つずつ", async () => {
    const { dataDir } = await setup();
    const store = new MilestoneReviewStore(dataDir);
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        store.withLock("v1", async () => {
          order.push(`in${n}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`out${n}`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(order[i].replace("in", "out"));
  });

  it("履歴のあるマイルストーンは消せず ID も変えられない。project.yaml から消えた履歴も孤立として一覧できる", async () => {
    const { ctx, dataDir } = await setup();
    const store = new MilestoneReviewStore(dataDir);
    const input = await extractReviewInput(dataDir, "v2");
    await store.create(input, runOf("v2", input.hash));
    await expect(checkMilestoneRemoval(ctx, ["v1"])).rejects.toThrow("レビューの履歴");
    writeFileSync(join(dataDir, "project.yaml"), readFileSync(join(dataDir, "project.yaml"), "utf8").replace(/ {2}- id: v2\n(?: {4}.*\n)*/, ""));
    await ctx.ws.reloadAll();
    expect(ctx.ws.project.milestones.map((m) => m.id)).toEqual(["v1"]);
    expect(await store.milestones()).toEqual(["v2"]);
    expect((await store.list("v2"))[0].state).toBe("ok");
  });
});
