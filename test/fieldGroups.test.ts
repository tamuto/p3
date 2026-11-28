import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateRequest, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { ConflictError } from "../packages/tasks/src/core/store/collection.ts";
import { keepRawOf, managedKeysOf, problemKeysOf, REQUEST_FIELD_GROUPS, TASK_FIELD_GROUPS } from "../packages/tasks/src/core/store/fieldGroups.ts";
import { REQUEST_DERIVED, REQUEST_KEY_ORDER, TASK_DERIVED, TASK_KEY_ORDER } from "../packages/tasks/src/core/store/normalize.ts";
import { parseFrontmatter } from "../packages/tasks/src/core/store/frontmatter.ts";
import type { Task } from "../packages/tasks/src/shared/types.ts";
import { makeProject, newRequest, openTestProject } from "./helpers.ts";

/**
 * p3 が管理する frontmatter の項目のまとまり（core/store/fieldGroups.ts）: 読む・書き戻す・書かない・入力から外す を 1 つの定義から作ること。
 * 全部のまとまりが壊れていても、知らない項目と一緒に関係のない更新で元の値のまま残り、直した項目だけが書き戻しから外れること、
 * 項目の無い旧データとゼロの値、版の競合、以前の版の項目（完了の記録・済み・要求の根拠・前提）を読まずに残すことを確かめる
 * （まとまりごとの細かい規則は各機能のテスト）
 */

const BROKEN_TASK = [
  "acceptanceCriteria: 壊れた",
  "block:",
  "  reason: 1",
  "completionRecords:",
  "  - id: broken",
  "reworkHistory:",
  "  - id: X",
  "x-custom: そのまま",
].join("\n");

async function setup() {
  const p = await makeProject();
  const r = await newRequest(p.ctx, { title: "請求" });
  const { task } = await createTask(p.ctx, r.id, { title: "作業" });
  const file = join(p.dataDir, "requests", r.id, "tasks", `${task.id}.md`);
  return { ...p, rid: r.id, tid: task.id, file };
}
const front = async (file: string) => parseFrontmatter(await readFile(file, "utf8")).data;

describe("項目のまとまりの定義", () => {
  it("まとまりの項目はファイルの並びに入り、problems は書かない項目で、入力から外す項目は項目と problems", () => {
    for (const [groups, order, derived] of [
      [TASK_FIELD_GROUPS, TASK_KEY_ORDER, TASK_DERIVED],
      [REQUEST_FIELD_GROUPS, REQUEST_KEY_ORDER, REQUEST_DERIVED],
    ] as const) {
      for (const g of groups) {
        for (const k of g.keys) expect(order as readonly string[], `${g.name} の ${k}`).toContain(k);
        expect(derived as readonly string[]).toContain(g.problems);
      }
      expect(problemKeysOf(groups as never)).toEqual([...new Set(groups.map((g) => g.problems))]);
      expect(managedKeysOf(groups as never)).toEqual([...new Set(groups.flatMap((g) => [...g.keys, g.problems]))]);
    }
    // 問題のあるまとまりの項目だけを書き戻す
    const keep = keepRawOf(TASK_FIELD_GROUPS);
    expect(keep({ blockProblems: ["x"] } as unknown as Task)).toEqual(["block", "blockHistory"]);
    expect(keep({ blockProblems: [] } as unknown as Task)).toEqual([]);
  });
});

describe("壊れた値・知らない項目・旧データ", () => {
  it("全部のまとまりが壊れていても、関係のない更新で元の値と知らない項目を残し、problems は書かない。直した項目だけが書き戻しから外れる", async () => {
    const { ctx, rid, tid, file, dataDir } = await setup();
    await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", `status: todo\n${BROKEN_TASK}`));
    await ctx.ws.tasksOf(rid).reload(tid);
    const t = ctx.ws.tasksOf(rid).require(tid);
    for (const g of TASK_FIELD_GROUPS) expect(t[g.problems] as unknown[] | undefined, g.name).not.toHaveLength(0);
    expect(Object.keys(t)).not.toContain("completionProblems"); // 以前の版の完了の記録は読まない
    await updateTask(ctx, rid, tid, { title: "題だけ" });
    let d = await front(file);
    expect(d).toMatchObject({ title: "題だけ", acceptanceCriteria: "壊れた", block: { reason: 1 }, completionRecords: [{ id: "broken" }], reworkHistory: [{ id: "X" }], "x-custom": "そのまま" });
    for (const g of TASK_FIELD_GROUPS) expect(d[g.problems], g.name).toBeUndefined();
    // 基準を直す（明示した項目）: 書き戻しから外れ、ほかの壊れた項目と知らない項目は残る
    const fresh = await openTestProject(dataDir);
    await writeFile(file, (await readFile(file, "utf8")).replace("acceptanceCriteria: 壊れた\n", ""));
    await fresh.ws.tasksOf(rid).reload(tid);
    await updateTask(fresh, rid, tid, { acceptance: [{ op: "add", text: "CSV で書き出せる" }] });
    d = await front(file);
    expect(d.acceptanceCriteria).toEqual([{ id: "A1", text: "CSV で書き出せる" }]);
    expect(d).toMatchObject({ block: { reason: 1 }, completionRecords: [{ id: "broken" }], reworkHistory: [{ id: "X" }], "x-custom": "そのまま" });
  });

  it("要望でも、壊れた要求の根拠・完了の記録・前提を関係のない更新で残し、入力から渡した管理の項目は書かない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const file = join(dataDir, "requests", rid, "request.md");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^rev:/m, "requirementSources: 壊れた\ncompletionRecords: 壊れた\npremiseChanges: 壊れた\nx-custom: 残す\nrev:"));
    await ctx.ws.requests.reload(rid);
    await updateRequest(ctx, rid, { title: "題だけ" });
    const d = await front(file);
    expect(d).toMatchObject({ title: "題だけ", requirementSources: "壊れた", completionRecords: "壊れた", premiseChanges: "壊れた", "x-custom": "残す" });
    for (const g of REQUEST_FIELD_GROUPS) expect(d[g.problems], g.name).toBeUndefined();
  });

  it("項目の無い旧データは問題なしで項目も足さず、ゼロの値（採番 0）は値として読む", async () => {
    const { ctx, rid, tid, file } = await setup();
    const t = ctx.ws.tasksOf(rid).require(tid);
    for (const g of TASK_FIELD_GROUPS) {
      expect(t[g.problems], g.name).toBeUndefined();
      for (const k of g.keys) expect(t[k as keyof Task], k).toBeUndefined();
    }
    await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", "status: todo\nacceptanceSeq: 0"));
    await ctx.ws.tasksOf(rid).reload(tid);
    expect(ctx.ws.tasksOf(rid).require(tid)).toMatchObject({ acceptanceSeq: 0 });
    expect(ctx.ws.tasksOf(rid).require(tid).acceptanceProblems).toBeUndefined();
  });
});

describe("書き込み", () => {
  it("入力から渡した管理の項目・以前の版の項目は書かず、版の競合は何も書かない。以前の版の済み・完了の記録は完了から戻しても残す", async () => {
    const { ctx, rid, tid, file } = await setup();
    const before = await readFile(file, "utf8");
    await expect(updateTask(ctx, rid, tid, { title: "x" }, { expectedRev: 99 })).rejects.toThrow(ConflictError);
    expect(await readFile(file, "utf8")).toBe(before);
    const r = await updateTask(ctx, rid, tid, { status: "done", completionRecords: [{ id: "偽" }], checkedAt: "2026-01-01T00:00:00.000Z", reworkHistory: [{ id: "偽" }], block: { reason: "偽" }, acceptanceCriteria: [{ id: "A9", text: "偽" }] } as never);
    expect(r.task.rev).toBe(2);
    let d = await front(file);
    expect(d).toMatchObject({ status: "done", rev: 2 });
    expect([d.completionRecords, d.checkedAt, d.reworkHistory, d.block, d.acceptanceCriteria]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // 以前の版が書いた済み・完了の記録はファイルに残し、完了から戻しても消さない（読まない）
    await writeFile(file, (await readFile(file, "utf8")).replace("status: done", "status: done\ncheckedAt: 2026-10-01T00:00:00.000Z\ncompletionRecords:\n  - id: C1\n    trigger: task_done"));
    await ctx.ws.tasksOf(rid).reload(tid);
    await updateTask(ctx, rid, tid, { status: "doing" });
    d = await front(file);
    expect(d).toMatchObject({ status: "doing", completionRecords: [{ id: "C1", trigger: "task_done" }] });
    expect(d.checkedAt).toEqual(expect.anything());
  });
});
