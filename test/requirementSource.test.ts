import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptanceChanged, applyAcceptanceOps, criteriaEditOps, criteriaForTask } from "../packages/tasks/src/features/requirements/shared/acceptance.ts";
import {
  answerState,
  applySourceOps,
  criteriaSourceView,
  readClarifications,
  readRequirement,
  requestRequirementView,
  requestSubject,
  RequirementInputError,
  sourceState,
  type Clarification,
  type RequirementSource,
} from "../packages/tasks/src/features/requirements/shared/requirementSource.ts";
import { parseAssessment } from "../packages/tasks/src/core/preflight/service.ts";
import { StaleInputError } from "../packages/tasks/src/core/preflight/input.ts";
import type { PreflightEngine, PreflightJob } from "../packages/tasks/src/core/preflight/engine.ts";
import { MockEngine } from "../packages/tasks/src/core/preflight/mockEngine.ts";
import { createTask, saveClarifyAnswer, updateRequest, updateRequirement, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { taskReviewMaterial } from "../packages/tasks/src/core/taskReview/review.ts";
import { ConflictError } from "../packages/tasks/src/core/store/collection.ts";
import { extractTaskReview } from "../packages/tasks/src/core/taskReview/material.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { git, makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * 要求そのものの根拠（出典・確かめた人・日・根拠）と、Preflight の確認事項への回答（shared/requirementSource.ts）:
 * 規則（確認の要件・状態・変更で効かなくなる・戻しても戻らない）、旧データ・壊れた値、要望・タスク・案の保存往復と競合、
 * 評価対象への固定と古い評価からの採用拒否、確認事項の取り込み（Mock・手元）、CLI・API を確かめる
 */

const now = "2026-11-18T00:00:00.000Z";
const reqSubject = requestSubject({ title: "請求", body: "月末締め" });
const ctxFor = (subject = reqSubject) => ({ now, actor: "human:a", subjectOf: () => subject });

describe("規則（shared）", () => {
  it("出典だけの記録は未確認。確認には出典・根拠・確かめた人・実在する日が要る（下書きは保存できる）", () => {
    const { list } = applySourceOps<RequirementSource>([], [{ op: "add", target: "税は切り捨て", source: "経理規程 3.2" }], ctxFor());
    expect(list[0]).toMatchObject({ id: "S1", target: "税は切り捨て", source: "経理規程 3.2", recordedBy: "human:a" });
    expect(sourceState(list[0], reqSubject)).toBe("unconfirmed");
    // 根拠が無いと確認できない
    expect(() => applySourceOps(list, [{ op: "confirm", id: "S1", by: "経理担当", on: "2026-11-01" }], ctxFor())).toThrow(/根拠が要ります/);
    // 確かめた人・日
    const withBasis = applySourceOps(list, [{ op: "edit", id: "S1", basis: "1,234 円 × 10% = 123 円" }], ctxFor()).list;
    for (const bad of [{ by: "", on: "2026-11-01" }, { by: "経理担当", on: "2026-02-30" }, { by: "経理担当", on: "11/01" }, { by: "x".repeat(101), on: "2026-11-01" }]) {
      expect(() => applySourceOps(withBasis, [{ op: "confirm", id: "S1", ...bad }], ctxFor())).toThrow(RequirementInputError);
    }
    const ok = applySourceOps(withBasis, [{ op: "confirm", id: "S1", by: "経理担当", on: "2026-11-01" }], ctxFor()).list;
    expect(ok[0].confirmed).toMatchObject({ by: "経理担当", on: "2026-11-01", recordedBy: "human:a", source: "経理規程 3.2" });
    expect(sourceState(ok[0], reqSubject)).toBe("confirmed");
    // 空・長すぎる・知らない操作・無い ID は何も当てない
    expect(() => applySourceOps(ok, [{ op: "add" }], ctxFor())).toThrow(RequirementInputError);
    expect(() => applySourceOps(ok, [{ op: "edit", id: "S1", basis: "x".repeat(20001) }], ctxFor())).toThrow(/20000 文字/);
    expect(() => applySourceOps(ok, [{ op: "remove", id: "S9" }], ctxFor())).toThrow(/S9 はありません/);
    expect(() => applySourceOps(ok, [{ op: "nope" } as never], ctxFor())).toThrow(/知らない操作/);
    // 不正な操作列は一部だけ当てない
    expect(() => applySourceOps(ok, [{ op: "add", source: "a" }, { op: "remove", id: "S9" }], ctxFor())).toThrow(/S9 はありません/);
    expect(ok).toHaveLength(1);
  });

  it("対象（要望の題・本文）か出典・根拠が変わると再確認が必要。元に戻しても確認記録ありに戻らない", () => {
    const base = applySourceOps<RequirementSource>([], [{ op: "add", target: "t", source: "s", basis: "b", confirm: { by: "経理担当", on: "2026-11-01" } }], ctxFor()).list;
    expect(sourceState(base[0], reqSubject)).toBe("confirmed");
    // 要望の本文が変わった（保存しないうちは状態だけ再確認）
    const other = requestSubject({ title: "請求", body: "月末締め（改）" });
    expect(sourceState(base[0], other)).toBe("reconfirm");
    // 根拠を変えて保存すると、確認は履歴へ移る
    const edited = applySourceOps(base, [{ op: "edit", id: "S1", basis: "b2" }], ctxFor()).list;
    expect(edited[0].confirmed).toBeUndefined();
    expect(edited[0].history).toHaveLength(1);
    expect(sourceState(edited[0], reqSubject)).toBe("reconfirm");
    // 元に戻しても戻らない
    const back = applySourceOps(edited, [{ op: "edit", id: "S1", basis: "b" }], ctxFor()).list;
    expect(sourceState(back[0], reqSubject)).toBe("reconfirm");
    // 明示して確認し直すと確認記録あり（前の確認は履歴に残る）
    const again = applySourceOps(back, [{ op: "confirm", id: "S1", by: "経理担当", on: "2026-11-02" }], ctxFor()).list;
    expect(sourceState(again[0], reqSubject)).toBe("confirmed");
    expect(again[0].history).toHaveLength(1);
    // 同じ人・日の付け直しは何も変えない
    expect(applySourceOps(again, [{ op: "confirm", id: "S1", by: "経理担当", on: "2026-11-02" }], ctxFor()).list).toEqual(again);
    // 消した ID は使い直さない（seq）
    const removed = applySourceOps(again, [{ op: "remove", id: "S1" }], ctxFor());
    expect(applySourceOps(removed.list, [{ op: "add", source: "x" }], { ...ctxFor(), seq: removed.seq }).list[0].id).toBe("S2");
  });

  it("旧データ（項目なし）は何も足さず、壊れた値は理由を残す。確認事項は壊れた項目を捨てずに理由にする", () => {
    expect(readRequirement({ title: "x" })).toEqual({});
    const broken = readRequirement({
      requirementSources: [{ id: "S1", source: "ok" }, { id: "S1", source: "dup" }, { source: "no id" }, { id: "S2", confirmed: { by: "a", on: "2026-13-01", subject: "x" } }],
      clarifyAnswers: [{ run: "PF-1", question: "Q1" }],
    });
    expect(broken.requirementSources).toEqual([{ id: "S1", source: "ok" }]);
    expect(broken.requirementProblems).toEqual([
      "根拠の記録の id が重複しています: S1",
      "根拠の記録 3 件目 の id が読めません",
      "根拠の記録 4 件目（S2） の確認の日（on）が YYYY-MM-DD ではありません",
      "回答 1 件目（PF-1/Q1） の回答（answer）が空です",
    ]);
    // YAML の日付（Date）も読む
    expect(readRequirement({ requirementSources: [{ id: "S1", source: "s", basis: "b", confirmed: { by: "a", on: new Date("2026-11-01"), subject: "x" } }] }).requirementSources![0].confirmed!.on).toBe("2026-11-01");
    const c = readClarifications([
      { id: "Q1", target: "税の端数", ask: "", question: "切り捨てか", needed: "規程", impact: "計算式" },
      { id: "Q2", question: "対象なし" },
      "文",
    ]);
    expect(c.clarifications).toEqual([{ id: "Q1", target: "税の端数", ask: "要望者に確認先を特定してもらう", question: "切り捨てか", needed: "規程", impact: "計算式" }]);
    expect(c.problems).toHaveLength(2);
    expect(readClarifications({}).problems).toEqual(["clarifications が並びになっていません"]);
  });

  it("基準の記録: 基準の文の変更で再確認、基準を消すと対応先不明、要望の記録の写しは確認を引き継がない。text だけの編集は記録を消さない", () => {
    const at = { now, actor: "human:a", requestSources: [{ id: "S1", target: "要望の前提", source: "規程", basis: "例", confirmed: undefined }] as RequirementSource[] };
    let s = applyAcceptanceOps({}, [{ op: "add", text: "税を切り捨てる" }, { op: "add", text: "二" }], at);
    s = applyAcceptanceOps(s, [{ op: "source", id: "A1", source: { op: "add", source: "経理規程 3.2", basis: "123 円", confirm: { by: "経理担当", on: "2026-11-01" } } }, { op: "source", id: "A2", source: { op: "add", from: "S1" } }], at);
    expect(s.acceptanceSources).toMatchObject([
      { id: "S1", criterionId: "A1", confirmed: { by: "経理担当" } },
      { id: "S2", criterionId: "A2", from: "S1", target: "要望の前提", source: "規程", basis: "例" },
    ]);
    expect(s.acceptanceSources![1].confirmed).toBeUndefined();
    const view = criteriaSourceView(s.acceptanceCriteria, s.acceptanceSources, ["S1"]);
    expect(view.items.map((i) => i.state)).toEqual(["confirmed", "unconfirmed"]);
    // 参照元の要望の記録が無くなると対応先不明
    expect(criteriaSourceView(s.acceptanceCriteria, s.acceptanceSources, []).items[1].state).toBe("unlinked");
    // 画面・旧 CLI の text だけの編集（criteriaEditOps）で記録を消さない。文を変えた基準は再確認が必要
    const edited = applyAcceptanceOps(s, criteriaEditOps(s, [{ id: "A1", text: "税を四捨五入する" }, { id: "A2", text: "二" }]), at);
    expect(edited.acceptanceSources).toHaveLength(2);
    expect(criteriaSourceView(edited.acceptanceCriteria, edited.acceptanceSources, ["S1"]).items[0].state).toBe("reconfirm");
    // 基準を消すと対応先不明として残る
    const removed = applyAcceptanceOps(s, [{ op: "remove", id: "A2" }], at);
    expect(criteriaSourceView(removed.acceptanceCriteria, removed.acceptanceSources).orphans.map((x) => x.id)).toEqual(["S2"]);
    // 実装後の met を記録しても要求の確認は変わらない
    const met = applyAcceptanceOps(s, [{ op: "record", id: "A2", result: "met", evidence: "通した", basis: { kind: "machine", command: "c", result: "0", target: "t" } }], at);
    expect(criteriaSourceView(met.acceptanceCriteria, met.acceptanceSources, ["S1"]).items[1].state).toBe("unconfirmed");
    // 中身の変化として数える（済みを外す）。同じ値の再保存は変化にしない
    expect(acceptanceChanged(s, applyAcceptanceOps(s, [{ op: "source", id: "A2", source: { op: "edit", id: "S2", basis: "例2" } }], at))).toBe(true);
    expect(acceptanceChanged(s, applyAcceptanceOps(s, [{ op: "source", id: "A2", source: { op: "edit", id: "S2", basis: "例" } }], at))).toBe(false);
    // 別の基準の記録は操作できない
    expect(() => applyAcceptanceOps(s, [{ op: "source", id: "A1", source: { op: "remove", id: "S2" } }], at)).toThrow(/A1 に根拠の記録 S2 はありません/);
    // 案からタスクへ: 要望の記録を写した記録は採用時の内容に写し直す
    const task = criteriaForTask(s.acceptanceCriteria, s.acceptanceSources, [{ id: "S1", target: "要望の前提", source: "規程 第2版", basis: "例" }], now);
    expect(task.acceptanceSources![1]).toMatchObject({ from: "S1", source: "規程 第2版" });
  });

  it("回答の状態: 対応する記録が変われば再確認、無くなれば参照元不明。回答しただけでは確認記録ありにしない", () => {
    const sources: RequirementSource[] = [{ id: "S1", source: "s", basis: "b" }];
    const q: Clarification = { id: "Q1", target: "t", ask: "経理担当", question: "切り捨てか", needed: "規程", impact: "式" };
    const a = { run: "PF-1", question: "Q1", copy: { question: q.question, ask: q.ask, target: q.target }, answer: "切り捨て", links: [{ id: "S1", hash: "x" }], recordedAt: now };
    expect(answerState(a, sources)).toBe("reconfirm");
    expect(answerState(a, [])).toBe("unlinked");
    expect(answerState({ ...a, links: undefined }, sources, new Map([["PF-1", [q]]]))).toBe("answered");
    expect(answerState({ ...a, links: undefined }, sources, new Map([["PF-1", []]]))).toBe("unlinked");
    expect(sourceState(sources[0], reqSubject)).toBe("unconfirmed");
  });
});

/** 始めたら release() まで待つ mock。渡された要望を残す */
class GatedEngine implements PreflightEngine {
  readonly name = "mock" as const;
  jobs: PreflightJob["request"][] = [];
  private inner = new MockEngine({ delay: 0 });
  private gate?: Promise<void>;
  release = () => {};
  hold() {
    this.gate = new Promise((r) => (this.release = r));
  }
  status = () => this.inner.status();
  async run(job: PreflightJob, log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal) {
    this.jobs.push(structuredClone(job.request));
    await this.gate;
    return this.inner.run(job, log, signal);
  }
}

async function setup(body = "短い") {
  const repo = await makeRepo();
  const engine = new GatedEngine();
  const ctx = await openTestProject(repo.dataDir, { mock: engine });
  const req = await newRequest(ctx, { title: "請求", status: "draft", body });
  const preflight = async () => {
    const { id } = await ctx.preflight.start(req.id, { engine: "mock", actor: "human:a" });
    return (await ctx.preflight.wait(req.id, id))!;
  };
  return { ...repo, ctx, engine, req, rid: req.id, preflight };
}

describe("要望の記録の保存（core）", () => {
  it("記録の追加・確認・同じ値の再保存（rev を上げない）・本文の変更で再確認・古い rev は競合で元の値を残す", async () => {
    const { ctx, rid } = await setup();
    const r1 = await updateRequirement(ctx, rid, [{ op: "add", target: "税は切り捨て", source: "経理規程 3.2", basis: "123 円", confirm: { by: "経理担当", on: "2026-11-01" } }], { actor: "human:a" });
    expect(r1.requirementSources![0]).toMatchObject({ id: "S1", recordedBy: "human:a", confirmed: { by: "経理担当" } });
    expect(r1.updatedBy).toBe("human:a");
    expect(requestRequirementView(r1).state).toBe("confirmed");
    const same = await updateRequirement(ctx, rid, [{ op: "edit", id: "S1", basis: "123 円" }], { actor: "human:b" });
    expect(same.rev).toBe(r1.rev);
    // 再読み込みしても同じ
    await ctx.ws.reloadAll();
    expect(ctx.ws.requests.require(rid).requirementSources).toEqual(r1.requirementSources);
    // 題・本文を変えると確認は履歴へ（戻しても戻らない）
    await updateRequest(ctx, rid, { body: "月末締め" });
    expect(requestRequirementView(ctx.ws.requests.require(rid)).state).toBe("reconfirm");
    await updateRequest(ctx, rid, { body: "短い" });
    expect(requestRequirementView(ctx.ws.requests.require(rid)).state).toBe("reconfirm");
    // タグだけの変更では変えない（記録はそのまま）
    const before = ctx.ws.requests.require(rid).requirementSources;
    await updateRequest(ctx, rid, { tags: ["x"] });
    expect(ctx.ws.requests.require(rid).requirementSources).toEqual(before);
    // 古い rev
    const rev = ctx.ws.requests.require(rid).rev;
    await expect(updateRequirement(ctx, rid, [{ op: "add", source: "x" }], { expectedRev: rev - 1 })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.requests.require(rid).requirementSources).toEqual(before);
    // PATCH の値の直接の書き込みは無視する（操作でだけ変える）
    await updateRequest(ctx, rid, { requirementSources: [], title: "請求2" });
    expect(ctx.ws.requests.require(rid).requirementSources).toHaveLength(1);
  });

  it("直接編集で壊れた記録は、関係のない更新でもファイルの元の値のまま残し、操作は断る", async () => {
    const { ctx, rid } = await setup();
    const file = ctx.ws.requests.path(rid);
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace(/^---\n/, "---\nrequirementSources:\n  - id: S1\n    confirmed: 壊れた\nclarifyAnswers: 文\n"));
    await ctx.ws.reloadAll();
    expect(ctx.ws.requests.require(rid).requirementProblems?.length).toBe(2);
    await updateRequest(ctx, rid, { title: "請求（改）", tags: ["a"] });
    const after = await readFile(file, "utf8");
    expect(after).toContain("confirmed: 壊れた");
    expect(after).toContain("clarifyAnswers: 文");
    expect(after).not.toContain("requirementProblems");
    await expect(updateRequirement(ctx, rid, [{ op: "add", source: "x" }])).rejects.toThrow(/読めないため変えられません/);
    // Preflight も始めない（評価の資料が決まらない）
    await expect(ctx.preflight.start(rid, { engine: "mock" })).rejects.toThrow(/Preflight を始められません/);
  });
});

describe("評価対象への固定と採用", () => {
  it("根拠・回答を run に固定してエンジンに渡し、request.md と同じ内容にする。旧 run は新項目なしで比べる", async () => {
    const { ctx, rid, engine, preflight } = await setup();
    // 根拠・回答が無い要望は以前と同じ（requirement を固定しない）
    const plain = await preflight();
    expect(plain.input?.requirement).toBeUndefined();
    expect((await ctx.preflight.inputMatch(rid, plain, { fresh: true })).status).toBe("same");
    // 旧 run（input.requirement なし）と、根拠を足した今の要望は同じとみなさない
    await updateRequirement(ctx, rid, [{ op: "add", target: "税は切り捨て", source: "経理規程 3.2" }]);
    expect(await ctx.preflight.inputMatch(rid, plain, { fresh: true })).toEqual({ status: "changed", changed: ["requirement"] });
    const run = await preflight();
    expect(run.input?.requirement?.sources.map((s) => s.id)).toEqual(["S1"]);
    expect(engine.jobs.at(-1)!.requirementSources?.[0].source).toBe("経理規程 3.2");
    const md = readFileSync(join(ctx.ws.preflight.runDir(rid, run.id), "request.md"), "utf8");
    expect(md).toContain("## 要求の出典と確認");
    expect(md).toContain("出典: 経理規程 3.2");
    expect((await ctx.preflight.inputMatch(rid, run, { fresh: true })).status).toBe("same");
    // 壊れた固定入力は不明（旧 run を書き直さない）
    const saved = (await ctx.preflight.get(rid, run.id))!;
    await ctx.ws.preflight.save({ ...saved, input: { ...saved.input!, requirement: { sources: "x" } as never } });
    expect((await ctx.preflight.inputMatch(rid, (await ctx.preflight.get(rid, run.id))!, { fresh: true })).status).toBe("unknown");
  });

  it("clarify の確認事項に回答すると要望に残り、古い評価からの採用は理由付きで断り何も変えない。再評価の資料に元の組で入る", async () => {
    const { ctx, rid, engine, preflight } = await setup();
    const run = await preflight();
    expect(run.assessment?.verdict).toBe("clarify");
    const q = run.assessment!.clarifications![0];
    expect(q).toMatchObject({ id: "Q1", ask: "要望者に確認先を特定してもらう" });
    const before = { rev: ctx.ws.requests.require(rid).rev, tasks: ctx.ws.tasksOf(rid).list().length };
    await updateRequirement(ctx, rid, [{ op: "add", source: "業務の担当" }]);
    const ans = await saveClarifyAnswer(ctx, rid, run.id, q, { answer: "受け入れ条件は A と B", by: "業務の担当", on: "2026-11-10", links: ["S1"] }, { actor: "human:a" });
    expect(ans.answer).toMatchObject({ run: run.id, question: "Q1", copy: { question: q.question, ask: q.ask }, by: "業務の担当", recordedBy: "human:a", links: [{ id: "S1" }] });
    // 回答しただけでは確認記録ありにしない
    expect(requestRequirementView(ctx.ws.requests.require(rid)).state).toBe("unconfirmed");
    // 過去の run は書き換えない
    expect((await ctx.preflight.get(rid, run.id))!.assessment).toEqual(run.assessment);
    // 回答だけの変更でも古い評価からは採用しない（何も変えない）
    const err = await ctx.preflight.materialize(rid, run.id).catch((e) => e);
    expect(err).toBeInstanceOf(StaleInputError);
    expect(err.message).toContain("要求の根拠・確認事項への回答");
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(before.tasks);
    expect(ctx.ws.requests.require(rid).workstreams).toBeUndefined();
    expect((await ctx.preflight.get(rid, run.id))!.materialization).toBeUndefined();
    // 再評価: 回答は元の組で資料に入る（同じ質問へ文字の一致で移さない）
    const next = await preflight();
    expect(engine.jobs.at(-1)!.clarifyAnswers?.[0]).toMatchObject({ run: run.id, question: "Q1" });
    const md = readFileSync(join(ctx.ws.preflight.runDir(rid, next.id), "request.md"), "utf8");
    expect(md).toContain(`${run.id}/Q1［回答済み］`);
    const carry = readFileSync(join(ctx.ws.preflight.runDir(rid, next.id), "carryover.md"), "utf8");
    expect(carry).toContain(`${run.id}/Q1`);
    // Mock は回答を確認済みとして go にする
    expect(next.assessment?.verdict).toBe("go");
    expect((await ctx.preflight.materialize(rid, next.id)).tasks.length).toBeGreaterThan(0);
  });

  it("評価中に回答・根拠を変えると、その run からは採用しない", async () => {
    const { ctx, rid, engine } = await setup("- 一\n- 二");
    engine.hold();
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    await updateRequirement(ctx, rid, [{ op: "add", source: "評価中に足した" }]);
    engine.release();
    const run = (await ctx.preflight.wait(rid, id))!;
    expect(engine.jobs[0].requirementSources).toBeUndefined();
    await expect(ctx.preflight.materialize(rid, run.id)).rejects.toMatchObject({ code: "stale_input", match: { changed: ["requirement"] } });
  });

  it("子の要望の根拠・回答の変化も、親の分割の採用の比較に入る", async () => {
    const { ctx, rid } = await setup("- a\n- b\n- c\n- d\n- e\n- f\n- g");
    const child = await newRequest(ctx, { title: "子", parent: rid, status: "draft" });
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    const run = (await ctx.preflight.wait(rid, id))!;
    expect(run.children?.length).toBeGreaterThan(0);
    await updateRequirement(ctx, child.id, [{ op: "add", source: "子の出典" }]);
    await expect(ctx.preflight.adopt(rid, run.id)).rejects.toMatchObject({ code: "stale_input", match: { changed: ["children"] } });
    expect(ctx.ws.requests.list().filter((r) => r.parent === rid)).toHaveLength(1);
  });
});

describe("タスク案とタスクの基準の記録", () => {
  it("案の根拠だけの編集の競合、基準の文の編集で残る記録、壊れた記録は関係のない更新で残す。タスク化で写し、保存往復で残る", async () => {
    const { ctx, rid, preflight } = await setup("- 一\n- 二");
    await updateRequirement(ctx, rid, [{ op: "add", target: "前提", source: "規程", basis: "例" }]);
    const run = await preflight();
    const d = run.drafts[0];
    const saved = await ctx.preflight.updateDraft(rid, run.id, d.key, { sourceOps: [{ id: "A1", source: { op: "add", source: "経理規程", basis: "123", confirm: { by: "経理担当", on: "2026-11-01" } } }, { id: "A2", source: { op: "add", from: "S1" } }] }, { expectedSources: [] });
    expect(saved.acceptanceSources).toHaveLength(2);
    // 根拠だけの編集も、始めたときの根拠と違えば競合（書かない）
    await expect(ctx.preflight.updateDraft(rid, run.id, d.key, { sourceOps: [{ id: "A1", source: { op: "remove", id: "S1" } }] }, { expectedSources: [] })).rejects.toThrow(/出典と確認が他で変わりました/);
    expect((await ctx.preflight.get(rid, run.id))!.drafts[0].acceptanceSources).toHaveLength(2);
    // 基準の文だけの編集（旧画面）で記録を消さない。文を変えた基準の確認は効かなくなる
    const crit = await ctx.preflight.updateDraft(rid, run.id, d.key, { acceptanceCriteria: [{ id: "A1", text: "文を変えた" }, { id: "A2", text: d.acceptanceCriteria![1].text }] }, { expectedCriteria: d.acceptanceCriteria });
    expect(crit.acceptanceSources).toHaveLength(2);
    expect(criteriaSourceView(crit.acceptanceCriteria, crit.acceptanceSources, ["S1"]).items[0].state).toBe("reconfirm");
    // 壊れた記録（直接編集）は題の変更でも残し、根拠の操作は断る
    const file = join(ctx.ws.preflight.runDir(rid, run.id), "drafts", "D2.md");
    const raw = readFileSync(file, "utf8").replace(/^---\n/, "---\nacceptanceSources: 壊れた\n");
    writeFileSync(file, raw);
    const titled = await ctx.preflight.updateDraft(rid, run.id, "D2", { title: "題を変えた" });
    expect(titled.acceptanceProblems).toContain("acceptanceSources が並びになっていません");
    expect(readFileSync(file, "utf8")).toContain("acceptanceSources: 壊れた");
    await expect(ctx.preflight.updateDraft(rid, run.id, "D2", { sourceOps: [{ id: "A1", source: { op: "add", source: "x" } }] }, {})).rejects.toThrow(/読めないため変えられません/);
    writeFileSync(file, raw.replace("acceptanceSources: 壊れた\n", ""));
    // タスク化（要望の記録を写した記録は採用時の内容）
    await updateRequirement(ctx, rid, [{ op: "edit", id: "S1", source: "規程 第2版" }]);
    const next = await preflight();
    const d2 = next.drafts[0];
    await ctx.preflight.updateDraft(rid, next.id, d2.key, { sourceOps: [{ id: "A1", source: { op: "add", from: "S1" } }] }, { expectedSources: [] });
    await updateRequirement(ctx, rid, [{ op: "edit", id: "S1", basis: "例（採用直前）" }]).catch(() => undefined);
    const fresh = await preflight();
    await ctx.preflight.updateDraft(rid, fresh.id, fresh.drafts[0].key, { sourceOps: [{ id: "A1", source: { op: "add", from: "S1" } }] }, { expectedSources: [] });
    const m = await ctx.preflight.materialize(rid, fresh.id);
    const t = m.tasks[0];
    expect(t.acceptanceSources![0]).toMatchObject({ criterionId: "A1", from: "S1", source: "規程 第2版", basis: "例（採用直前）" });
    await ctx.ws.reloadAll();
    expect(ctx.ws.tasksOf(rid).require(t.id).acceptanceSources).toEqual(t.acceptanceSources);
    // レビューの材料のスナップショットにも残る（基準と一緒に）
    expect(JSON.stringify(ctx.ws.tasksOf(rid).require(t.id))).toContain("規程 第2版");
  });

  it("タスクの根拠を実質変えると済みを外し、同じ値の再保存では外さない。完了・済みは根拠の不足で拒まない", async () => {
    const { ctx, rid } = await setup();
    const t = (await ctx.ws.tasksOf(rid).create({ title: "t", status: "done", ...applyAcceptanceOps({}, [{ op: "add", text: "一" }], { now }) }, "test"));
    await updateTask(ctx, rid, t.id, { checked: true });
    const add = await updateTask(ctx, rid, t.id, { acceptance: [{ op: "source", id: "A1", source: { op: "add", source: "規程" } }] });
    expect(add.checkCleared).toBeDefined();
    await updateTask(ctx, rid, t.id, { checked: true });
    const same = await updateTask(ctx, rid, t.id, { acceptance: [{ op: "source", id: "A1", source: { op: "edit", id: "S1", source: "規程" } }] });
    expect(same.checkCleared).toBeUndefined();
    expect(same.task.checkedAt).toBeDefined();
  });
});

describe("タスクレビューの材料", () => {
  it("基準ごとの要求の根拠を材料のスナップショットに残し、根拠の変更で hash が変わる", async () => {
    const { ctx, rid, dataDir, root } = await setup();
    const put = (path: string, c: string) => (mkdirSync(join(root, path, ".."), { recursive: true }), writeFileSync(join(root, path), c), git(root, "add", path));
    put(".gitignore", ".p3/\n");
    put("src/a.ts", "a1\n");
    git(root, "commit", "-q", "-m", "最初");
    put("src/a.ts", "a2\n");
    git(root, "commit", "-q", "-m", "変更");
    const sha = git(root, "rev-parse", "HEAD");
    const { task } = await createTask(ctx, rid, { title: "t", repo: "main", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { status: "done", outputs: [sha], acceptance: [{ op: "source", id: "A1", source: { op: "add", source: "経理規程", basis: "例", confirm: { by: "経理担当", on: "2026-11-01" } } }] });
    const first = (await extractTaskReview(dataDir, rid, task.id, ctx.ws.refs())).input;
    expect(first.task.sources).toMatchObject([{ id: "S1", criterionId: "A1", state: "confirmed", source: "経理規程" }]);
    expect(taskReviewMaterial(first).task.requirementSources).toEqual([{ criterion: "A1", id: "S1", state: "confirmed", target: null, source: "経理規程", basis: "例", confirmed: { by: "経理担当", on: "2026-11-01" } }]);
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "source", id: "A1", source: { op: "edit", id: "S1", basis: "例2" } }] });
    const second = (await extractTaskReview(dataDir, rid, task.id, ctx.ws.refs())).input;
    expect(second.task.sources![0].state).toBe("reconfirm");
    expect(second.hash).not.toBe(first.hash);
  });
});

describe("確認事項の取り込み（Codex・手元で同じ）", () => {
  it("壊れた確認事項は黙って捨てずに残し、手元のエージェントの取り込みでは直すまで確定しない", async () => {
    const a = parseAssessment(JSON.stringify({ summary: "s", verdict: "clarify", validity: {}, feasibility: {}, risks: [], questions: ["q"], areas: [], clarifications: [{ id: "Q1", question: "対象なし" }] }));
    expect(a.clarifications).toBeUndefined();
    expect(a.clarificationProblems).toHaveLength(1);
    const { ctx, rid } = await setup();
    const p = await ctx.preflight.prepare(rid);
    const text = readFileSync(p.instructions, "utf8");
    expect(text).toContain("clarifications");
    expect(text).toContain("要望者に確認先を特定してもらう");
    const assessment = { summary: "s", verdict: "clarify", validity: { score: 50, reasons: [] }, feasibility: { score: 50, reasons: [] }, risks: [], questions: ["q"], areas: [] };
    writeFileSync(join(p.runDir, "assessment.json"), JSON.stringify({ ...assessment, clarifications: [{ id: "Q1", question: "対象なし" }] }));
    mkdirSync(join(p.runDir, "ui"), { recursive: true });
    writeFileSync(join(p.runDir, "ui", "index.json"), JSON.stringify({ needed: false, reason: "なし" }));
    await expect(ctx.preflight.complete(rid, p.run.id)).rejects.toThrow(/clarifications/);
    writeFileSync(join(p.runDir, "assessment.json"), JSON.stringify({ ...assessment, clarifications: [{ id: "Q1", target: "前提", ask: "経理担当", question: "切り捨てか", needed: "規程", impact: "式" }] }));
    const r = await ctx.preflight.complete(rid, p.run.id);
    expect(r.run.assessment?.clarifications?.[0]).toMatchObject({ id: "Q1", ask: "経理担当" });
  });
});

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[], input?: string) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "ai:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, input, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI と API", () => {
  it("p3 source（要望・タスク・案）・clarify・answer の通常と JSON。不正な入力は理由を返して書かない", async () => {
    const { ctx, dataDir, rid, preflight } = await setup();
    const req = ["--req", rid];
    expect(p3(dataDir, ["source", rid]).out).toContain("記録なし");
    const add = p3(dataDir, ["source", rid, "add", "--target", "税は切り捨て", "--source", "経理規程 3.2", "--grounds", "-", "--json"], "1,234 円 × 10% = 123 円\n2 行目");
    expect(add.code, add.err).toBe(0);
    expect(JSON.parse(add.out)).toMatchObject({ state: "unconfirmed", sources: [{ id: "S1", basis: "1,234 円 × 10% = 123 円\n2 行目", recordedBy: "ai:test" }] });
    const bad = p3(dataDir, ["source", rid, "confirm", "S1", "--by", "経理担当", "--on", "2026-02-30"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("YYYY-MM-DD");
    const ok = p3(dataDir, ["source", rid, "confirm", "S1", "--by", "経理担当", "--on", "2026-11-01"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("確認記録あり: 経理担当・2026-11-01");
    // JSON ファイルで複数の操作（1つでも合わなければ何も書かない）
    const file = join(dataDir, "ops.json");
    writeFileSync(file, JSON.stringify([{ op: "add", source: "a" }, { op: "remove", id: "S9" }]));
    expect(p3(dataDir, ["source", rid, "--sources-json", file]).code).toBe(1);
    expect(ctx.ws.requests.list().length).toBeGreaterThan(0);
    await ctx.ws.reloadAll();
    expect(ctx.ws.requests.require(rid).requirementSources).toHaveLength(1);
    // 標準入力の取り合いは断る
    expect(p3(dataDir, ["source", rid, "--sources-json", "-", "add"]).code).toBe(1);

    // clarify と answer
    const run = await preflight();
    const cl = p3(dataDir, ["clarify", rid, "--json"]);
    expect(JSON.parse(cl.out)).toMatchObject({ run: run.id, items: [{ clarification: { id: "Q1" }, state: "unanswered" }], questions: [expect.any(String)] });
    expect(p3(dataDir, ["clarify", rid]).out).toContain("確認先: 要望者に確認先を特定してもらう");
    const an = p3(dataDir, ["answer", rid, "Q1", "--body", "-", "--by", "業務の担当", "--on", "2026-11-10", "--link", "S1"], "条件は A\n");
    expect(an.code, an.err).toBe(0);
    expect(an.out).toContain("確認記録あり」にしません");
    expect(JSON.parse(p3(dataDir, ["clarify", rid, "--json"]).out).items[0].state).toBe("answered");
    expect(p3(dataDir, ["answer", rid, "Q9", "--body", "x"]).err).toContain("Q9 はありません");
    expect(p3(dataDir, ["answer", rid, "Q1", "--body", "-", "--grounds", "-"], "x").err).toContain("標準入力");
    expect(p3(dataDir, ["source", rid]).out).toContain(`${run.id}/Q1  [回答済み]`);
    // 要望の詳細（show・brief）にも出る
    expect(p3(dataDir, ["show", rid]).out).toContain("要求の出典と確認: 確認記録あり");
    expect(p3(dataDir, ["show", rid, "--brief"]).out).toContain("S1  [確認記録あり: 経理担当・2026-11-01]");

    // タスクの基準
    const t = (JSON.parse(p3(dataDir, ["new", "t", ...req, "--criterion", "一", "--json"]).out) as { id: string }).id;
    const ts = p3(dataDir, ["source", t, "A1", "add", "--from", "S1", ...req, "--json"]);
    expect(ts.code, ts.err).toBe(0);
    expect(JSON.parse(ts.out)).toMatchObject({ items: [{ id: "A1", state: "unconfirmed", sources: [{ from: "S1", source: "経理規程 3.2" }] }] });
    expect(p3(dataDir, ["source", t, ...req]).out).toContain("（要望の S1 を写したもの）");
    expect(p3(dataDir, ["source", t, "A9", "add", "--source", "x", ...req]).err).toContain("A9 はありません");
    // 案の基準
    const run2 = await preflight();
    const key = run2.drafts[0].key;
    const ds = p3(dataDir, ["source", key, "A1", "add", "--source", "規程", "--grounds", "例", "--by", "経理担当", "--on", "2026-11-02", ...req, "--json"]);
    expect(ds.code, ds.err).toBe(0);
    expect(JSON.parse(ds.out)).toMatchObject({ run: run2.id, items: [{ id: "A1", state: "confirmed" }, { id: "A2", state: "unrecorded" }] });
  });

  it("API: POST sources / answers、案の sourceOps と expectedSources、タスクの source 操作。規則に合わなければ 400 で書かない", async () => {
    const { ctx, rid, preflight } = await setup();
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const r1 = await send("POST", `/requests/${rid}/sources`, { ops: [{ op: "add", source: "規程", basis: "例" }] });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { request: { rev: number }; requirement: { state: string } };
    expect(b1.requirement.state).toBe("unconfirmed");
    expect((await send("POST", `/requests/${rid}/sources`, { ops: [{ op: "confirm", id: "S1", by: "", on: "2026-11-01" }] })).status).toBe(400);
    expect((await send("POST", `/requests/${rid}/sources`, { ops: [{ op: "add", source: "x" }], rev: b1.request.rev - 1 })).status).toBe(409);
    const got = (await (await send("GET", `/requests/${rid}`)).json()) as { requirement: { sources: { id: string; state: string }[] } };
    expect(got.requirement.sources).toMatchObject([{ id: "S1", state: "unconfirmed" }]);
    const run = await preflight();
    const a = await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q1", answer: "条件は A", by: "業務の担当" });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { answer: { question: string } }).answer.question).toBe("Q1");
    expect((await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q9", answer: "x" })).status).toBe(400);
    expect((await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q1", answer: "x", on: "2026-02-30" })).status).toBe(400);
    // 古い評価からのタスク化は 409 stale_input
    const stale = await send("POST", `/requests/${rid}/preflight/${run.id}/materialize`, {});
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("stale_input");
    const run2 = await preflight();
    const key = run2.drafts[0].key;
    expect((await send("PATCH", `/requests/${rid}/preflight/${run2.id}/drafts/${key}`, { sourceOps: [{ id: "A1", source: { op: "add", source: "x" } }] })).status).toBe(400);
    const ok = await send("PATCH", `/requests/${rid}/preflight/${run2.id}/drafts/${key}`, { sourceOps: [{ id: "A1", source: { op: "add", source: "x" } }], expectedSources: [] });
    expect(ok.status).toBe(200);
    const conflict = await send("PATCH", `/requests/${rid}/preflight/${run2.id}/drafts/${key}`, { sourceOps: [{ id: "A1", source: { op: "add", source: "y" } }], expectedSources: [] });
    expect(conflict.status).toBe(409);
    const t = await ctx.ws.tasksOf(rid).create({ title: "t", status: "todo", ...applyAcceptanceOps({}, [{ op: "add", text: "一" }], { now }) }, "test");
    expect((await send("PATCH", `/requests/${rid}/tasks/${t.id}`, { acceptance: [{ op: "source", id: "A1", source: { op: "add", from: "S1" } }] })).status).toBe(200);
    expect((await send("PATCH", `/requests/${rid}/tasks/${t.id}`, { acceptance: [{ op: "source", id: "A1", source: { op: "add", from: "S9" } }] })).status).toBe(400);
  });
});
