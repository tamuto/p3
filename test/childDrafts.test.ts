import { describe, expect, it } from "vitest";
import { adoptBlocker, adoptionSummary, editConflict, editDirty, editOf } from "../src/web/lib/childDrafts.ts";
import { preflightSteps } from "../src/web/lib/preflightSteps.ts";
import type { ProposedChild } from "../src/shared/types.ts";

/** 子の要望の案の画面の規則（ChildDrafts.tsx） */
const child = (key: string, include = true): ProposedChild => ({ key, title: `${key} の題`, description: "## 目的\nx\n## 完了条件\ny", requires: [], overlaps: [], include });
const base = { edits: {}, busy: false, blocked: null };

describe("採用を止める理由", () => {
  it("選んだ案があり、未保存・競合・古さ・問題・実行中が無いときだけ採用できる", () => {
    const run = { children: [child("C1"), child("C2", false)], inputMatch: { status: "same" as const } };
    expect(adoptBlocker(run, base)).toBeNull();
    expect(adoptBlocker({ ...run, children: [child("C1", false)] }, base)).toContain("選んでください");
    expect(adoptBlocker(run, { ...base, busy: true })).toBe("処理中です");
    expect(adoptBlocker(run, { ...base, blocked: "保存していない本文があります" })).toBe("保存していない本文があります");
    expect(adoptBlocker({ ...run, inputMatch: { status: "changed", changed: ["children"] } }, base)).toContain("もう一度 Preflight");
    expect(adoptBlocker(run, { ...base, problems: ["C1: 題がありません"] })).toContain("問題");
    const e = { ...editOf(run.children[0]), title: "直した" };
    expect(adoptBlocker(run, { ...base, edits: { C1: e } })).toContain("保存していない子の案");
    expect(adoptBlocker({ ...run, adoption: { reserved: {}, created: [], keys: ["C1"], done: true } }, base)).toContain("作成済み");
    // 採用を始めた run は選んだ案のまま続ける（今の採否が0件でも続きを作れる）
    expect(adoptBlocker({ children: [child("C1", false)], adoption: { reserved: { C1: "x" }, created: [], keys: ["C1"], done: false } }, base)).toBeNull();
  });

  it("編集の未保存と、編集中に題が他で変わったことを見分ける", () => {
    const c = child("C1");
    const e = editOf(c);
    expect(editDirty(e, c)).toBe(false);
    expect(editDirty({ ...e, description: "変えた" }, c)).toBe(true);
    expect(editConflict(e, { ...c, title: "外で変えた" })).toBe(true);
  });

  it("結果: 全部作れた・途中で止まった（作った子は残し、続きを作れる）", () => {
    expect(adoptionSummary({ created: [{ key: "C1", id: "a" }], failed: [], pending: [] })).toContain("1 件作成しました");
    expect(adoptionSummary({ created: [{ key: "C1", id: "a" }], failed: [{ key: "C2", error: "x", code: "conflict" }], pending: ["C3"] })).toMatch(/C2 で止まりました（未実行: C3）.*続きを作る/);
  });

  it("子を作り終えた分割の run は、工程をタスク化まで済みにする", () => {
    const steps = preflightSteps({ status: "completed", log: [], adoption: { reserved: {}, created: [], keys: [], done: true } });
    expect(steps.at(-1)).toMatchObject({ state: "done", current: true });
  });
});
