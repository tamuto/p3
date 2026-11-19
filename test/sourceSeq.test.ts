import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { taskReview } from "../packages/tasks/src/features/records/core/reviewCandidates.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../packages/kit/src/frontmatter.ts";
import type { SourceOp } from "../packages/tasks/src/features/requirements/shared/requirementSource.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";

/**
 * タスク・タスク案の基準ごとの要求の根拠の ID（S1, S2…）: 振った最後の番号（acceptanceSourceSeq）を保存し、消した ID を使い直さないこと。
 * 採番だけの更新で済み・完了の記録・手戻りが変わらないこと、案からタスクへの引き継ぎ、旧データ（採番の無いタスク・案、ID を使い直した記録）、
 * 不正な操作・競合・壊れた値で片方だけ書かないことを確かめる
 */

async function setup(body = "- 一\n- 二") {
  const repo = await makeRepo();
  const ctx = await openTestProject(repo.dataDir);
  const req = await newRequest(ctx, { title: "請求", status: "draft", body });
  return { ...repo, ctx, rid: req.id };
}
const add = (source: string): SourceOp => ({ op: "add", source });
const src = (id: string, source: SourceOp) => ({ op: "source" as const, id, source });
const taskFile = (dataDir: string, rid: string, tid: string) => join(dataDir, "requests", rid, "tasks", `${tid}.md`);
async function editFrontmatter(file: string, fn: (d: Record<string, unknown>) => void) {
  const { data, body } = parseFrontmatter(await readFile(file, "utf8"));
  fn(data);
  await writeFile(file, stringifyFrontmatter(data, body));
}

describe("タスクの根拠の採番", () => {
  it("完了後に末尾の根拠を消して読み直してから足すと次の番号になり、見直し候補は消した記録を示す", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["CSV で書き出せる"] });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("経理規程")), src("A1", add("税務の手引き"))] });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", { op: "remove", id: "S2" })] });
    const fresh = await openTestProject(dataDir);
    const r = await updateTask(fresh, rid, task.id, { acceptance: [src("A1", add("社内の決まり"))] });
    expect(r.task.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S3"]);
    expect(r.task.acceptanceSourceSeq).toBe(3);
    const review = taskReview(fresh, fresh.ws.requireTask(`${rid}/${task.id}`))!;
    expect(review.reasons).toContainEqual(expect.objectContaining({ code: "source_removed", target: "A1/S2" }));
    expect(review.reasons.some((x) => x.code === "source_changed")).toBe(false);
  });

  it("全件を消しても、同じ操作の中で足して消しても、次は保存した番号の続き。採番だけの更新では済み・完了の記録・手戻りを変えない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("a")), src("A1", add("b"))] });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", { op: "remove", id: "S1" }), src("A1", { op: "remove", id: "S2" })] });
    let t = ctx.ws.requireTask(`${rid}/${task.id}`);
    expect(t.acceptanceSources).toBeUndefined();
    expect(t.acceptanceSourceSeq).toBe(2);
    // 完了して済みにしてから、同じ操作の中で足して消す（中身は同じ・採番だけ進む）
    await updateTask(ctx, rid, task.id, { status: "done", checked: true });
    t = ctx.ws.requireTask(`${rid}/${task.id}`);
    const before = { checkedAt: t.checkedAt, records: t.completionRecords, rework: t.reworkHistory, doneAt: t.doneAt };
    const r = await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("一時")), src("A1", { op: "remove", id: "S3" })] });
    expect(r.checkCleared).toBeUndefined();
    expect(r.task.acceptanceSourceSeq).toBe(3);
    expect({ checkedAt: r.task.checkedAt, records: r.task.completionRecords, rework: r.task.reworkHistory, doneAt: r.task.doneAt }).toEqual(before);
    const next = await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("次"))] });
    expect(next.task.acceptanceSources!.map((s) => s.id)).toEqual(["S4"]);
  });

  it("不正な操作は根拠も採番も書かない。採番は入力から上書きできない。壊れた採番は理由を示し、関係のない更新で元の値のまま残す", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("a"))] });
    const file = taskFile(dataDir, rid, task.id);
    const saved = await readFile(file, "utf8");
    await expect(updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("b")), src("A1", { op: "remove", id: "S9" })] })).rejects.toThrow(/S9/);
    expect(await readFile(file, "utf8")).toBe(saved);
    await updateTask(ctx, rid, task.id, { title: "題だけ", acceptanceSourceSeq: 0 });
    expect(ctx.ws.requireTask(`${rid}/${task.id}`).acceptanceSourceSeq).toBe(1);

    await editFrontmatter(file, (d) => (d.acceptanceSourceSeq = "壊れた"));
    const broken = await openTestProject(dataDir);
    const t = broken.ws.requireTask(`${rid}/${task.id}`);
    expect(t.acceptanceProblems).toContain("acceptanceSourceSeq が読めません");
    await expect(updateTask(broken, rid, task.id, { acceptance: [src("A1", add("c"))] })).rejects.toThrow(/acceptanceSourceSeq が読めません/);
    await updateTask(broken, rid, task.id, { title: "関係のない更新" });
    expect(parseFrontmatter(await readFile(file, "utf8")).data.acceptanceSourceSeq).toBe("壊れた");
  });

  it("採番の無い旧タスク: 今ある記録と完了の記録の写しに残る番号の続きを振る。ID を使い直した過去の記録も読める", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", add("a")), src("A1", add("b")), src("A1", add("c"))] });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await updateTask(ctx, rid, task.id, { acceptance: [src("A1", { op: "remove", id: "S3" }), src("A1", { op: "remove", id: "S2" })] });
    // 採番の項目が無い旧データにする（写しには S1〜S3 が残る）
    const file = taskFile(dataDir, rid, task.id);
    await editFrontmatter(file, (d) => delete d.acceptanceSourceSeq);
    const old = await openTestProject(dataDir);
    expect(old.ws.requireTask(`${rid}/${task.id}`).acceptanceSourceSeq).toBeUndefined();
    const r = await updateTask(old, rid, task.id, { acceptance: [src("A1", add("d"))] });
    expect(r.task.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S4"]);

    // 以前の版で ID を使い直した記録（写しの S2 と今の S2 が別の内容）も読め、比べられる（同一性は推定しない）
    const { task: t2 } = await createTask(old, rid, { title: "t2", criteria: ["一"] });
    await updateTask(old, rid, t2.id, { acceptance: [src("A1", add("前の S2 の前")), src("A1", add("前の S2"))] });
    await updateTask(old, rid, t2.id, { status: "done" });
    const f2 = taskFile(dataDir, rid, t2.id);
    await editFrontmatter(f2, (d) => {
      delete d.acceptanceSourceSeq;
      (d.acceptanceSources as { id: string; source: string }[])[1].source = "使い直した S2";
    });
    const reread = await openTestProject(dataDir);
    const t = reread.ws.requireTask(`${rid}/${t2.id}`);
    expect(t.acceptanceProblems).toBeUndefined();
    expect(taskReview(reread, t)!.reasons).toContainEqual(expect.objectContaining({ code: "source_changed", target: "A1/S2" }));
    const next = await updateTask(reread, rid, t2.id, { acceptance: [src("A1", add("次"))] });
    expect(next.task.acceptanceSources!.at(-1)!.id).toBe("S3");
  });
});

describe("タスク案の根拠の採番", () => {
  it("案で消した ID を保存・読み直しの後も使い直さず、タスク化の後にタスクへ足す根拠は案で振った最後の番号を超える", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { id } = await ctx.preflight.start(rid, { engine: "mock", actor: "human:a" });
    const run = (await ctx.preflight.wait(rid, id))!;
    const key = run.drafts[0].key;
    await ctx.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("a") }, { id: "A1", source: add("b") }] });
    await ctx.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: { op: "remove", id: "S2" } }] });
    const fresh = await openTestProject(dataDir);
    const saved = await fresh.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("c") }], acceptanceSourceSeq: 0 });
    expect(saved.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S3"]);
    expect(saved.acceptanceSourceSeq).toBe(3);
    // 案の最後を消してからタスク化しても、タスクで振る番号は案の続き
    await fresh.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: { op: "remove", id: "S3" } }] });
    const tasks = await fresh.preflight.materialize(rid, run.id);
    const task = tasks.tasks.find((t) => t.title === run.drafts[0].title)!;
    expect(task.acceptanceSourceSeq).toBe(3);
    const r = await updateTask(fresh, rid, task.id, { acceptance: [src("A1", add("d"))] });
    expect(r.task.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S4"]);
  });

  it("採番の無い旧案は今ある記録の続き。壊れた採番は理由を示して操作を断り、関係のない更新で元の値のまま残す。同時の操作は同じ番号を振らない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const { id } = await ctx.preflight.start(rid, { engine: "mock", actor: "human:a" });
    const run = (await ctx.preflight.wait(rid, id))!;
    const key = run.drafts[0].key;
    await ctx.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("a") }, { id: "A1", source: add("b") }] });
    const file = join(dataDir, "requests", rid, "preflight", run.id, "drafts", `${key}.md`);
    await editFrontmatter(file, (d) => delete d.acceptanceSourceSeq);
    const old = await openTestProject(dataDir);
    const r = await old.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("c") }] });
    expect(r.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S2", "S3"]);

    // 同時の操作（同じ案に別々に足す）は、どちらも別の番号になり、どちらの記録も残る
    await Promise.all([
      old.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("同時1") }] }),
      (await openTestProject(dataDir)).preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("同時2") }] }),
    ]);
    const after = (await (await openTestProject(dataDir)).preflight.get(rid, run.id))!.drafts.find((d) => d.key === key)!;
    expect(after.acceptanceSources!.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    expect(after.acceptanceSources!.map((s) => s.source).slice(3).sort((a, b) => a!.localeCompare(b!))).toEqual(["同時1", "同時2"]);

    await editFrontmatter(file, (d) => (d.acceptanceSourceSeq = -1));
    const broken = await openTestProject(dataDir);
    expect((await broken.preflight.get(rid, run.id))!.drafts.find((d) => d.key === key)!.acceptanceProblems).toContain("acceptanceSourceSeq が読めません");
    await expect(broken.preflight.updateDraft(rid, run.id, key, { sourceOps: [{ id: "A1", source: add("d") }] })).rejects.toThrow(/acceptanceSourceSeq が読めません/);
    await broken.preflight.updateDraft(rid, run.id, key, { title: "題だけ直す" });
    expect(parseFrontmatter(await readFile(file, "utf8")).data.acceptanceSourceSeq).toBe(-1);
  });
});
