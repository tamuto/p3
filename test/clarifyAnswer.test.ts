import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clarificationStates, makeAnswer, readClarifications, readRequirement, RequirementInputError, type Clarification } from "../packages/tasks/src/features/requirements/shared/clarify.ts";
import { parseAssessment } from "../packages/tasks/src/core/preflight/service.ts";
import { StaleInputError } from "../packages/tasks/src/core/preflight/input.ts";
import type { PreflightEngine, PreflightJob } from "../packages/tasks/src/core/preflight/engine.ts";
import { MockEngine } from "../packages/tasks/src/core/preflight/mockEngine.ts";
import { saveClarifyAnswer, updateRequest } from "../packages/tasks/src/core/requestOps.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * Preflight の確認事項への回答（shared/clarify.ts）: 回答・回答した人・日だけを持ち、状態は回答済み・未回答。旧データ（以前の版の
 * 要求の根拠・回答の出典と対応する記録）は読まずに残す、壊れた値、評価対象への固定と古い評価からの採用拒否、確認事項の取り込み、CLI・API
 */

const now = "2026-11-18T00:00:00.000Z";
const q: Clarification = { id: "Q1", target: "税の端数", ask: "経理担当", question: "切り捨てか", needed: "規程", impact: "式" };

describe("規則（shared）", () => {
  it("回答は空にできず、日は実在する YYYY-MM-DD。状態は回答済み・未回答の2つ", () => {
    const a = makeAnswer("PF-1", q, { answer: " 切り捨て ", by: "経理担当", on: "2026-11-01" }, { now, actor: "human:a" });
    expect(a).toEqual({ run: "PF-1", question: "Q1", copy: { question: "切り捨てか", ask: "経理担当", target: "税の端数" }, answer: "切り捨て", by: "経理担当", on: "2026-11-01", recordedAt: now, recordedBy: "human:a" });
    expect(() => makeAnswer("PF-1", q, { answer: " " }, { now })).toThrow(RequirementInputError);
    expect(() => makeAnswer("PF-1", q, { answer: "x", on: "2026-02-30" }, { now })).toThrow(/YYYY-MM-DD/);
    const q2 = { ...q, id: "Q2" };
    expect(clarificationStates("PF-1", [q, q2], [a]).map((s) => s.state)).toEqual(["answered", "unanswered"]);
    expect(clarificationStates("PF-2", [q], [a])[0].state).toBe("unanswered"); // 別の run の回答は当てない
  });

  it("旧データ（項目なし）は何も足さない。以前の版の回答の出典・根拠・対応する記録は読まず、壊れた回答は理由を残す。確認事項は壊れた項目を理由にする", () => {
    expect(readRequirement({ title: "x" })).toEqual({});
    const legacy = readRequirement({
      requirementSources: [{ id: "S1", source: "経理規程" }],
      clarifyAnswers: [{ run: "PF-1", question: "Q1", copy: { question: "切り捨てか" }, answer: "はい", source: "規程", basis: "例", links: [{ id: "S1", hash: "x" }], recordedAt: now }],
    });
    expect(legacy).toEqual({ clarifyAnswers: [{ run: "PF-1", question: "Q1", copy: { question: "切り捨てか", ask: "", target: "" }, answer: "はい", recordedAt: now }] });
    const broken = readRequirement({ clarifyAnswers: [{ run: "PF-1", question: "Q1" }, { run: "PF-1", question: "Q2", answer: "a", on: "2026-13-01" }] });
    expect(broken.requirementProblems).toEqual(["回答 1 件目（PF-1/Q1） の回答（answer）が空です", "回答 2 件目（PF-1/Q2） の日（on）が YYYY-MM-DD ではありません"]);
    const c = readClarifications([{ id: "Q1", target: "税の端数", ask: "", question: "切り捨てか", needed: "規程", impact: "計算式" }, { id: "Q2", question: "対象なし" }, "文"]);
    expect(c.clarifications).toEqual([{ id: "Q1", target: "税の端数", ask: "要望者に確認先を特定してもらう", question: "切り捨てか", needed: "規程", impact: "計算式" }]);
    expect(c.problems).toHaveLength(2);
    expect(readClarifications({}).problems).toEqual(["clarifications が並びになっていません"]);
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

describe("保存と旧データ", () => {
  it("以前の版の要求の根拠・回答の対応する記録は、関係のない更新でもファイルに残し、問題にしない", async () => {
    const { ctx, rid, dataDir } = await setup();
    const file = join(dataDir, "requests", rid, "request.md");
    const legacy = `requirementSources:\n  - id: S1\n    source: 経理規程\nrequirementSourceSeq: 1\nclarifyAnswers:\n  - run: PF-1\n    question: Q1\n    copy: { question: 切り捨てか, ask: 経理担当, target: 税 }\n    answer: はい\n    links: [{ id: S1, hash: x }]\n    recordedAt: ${now}\nrev:`;
    await writeFile(file, (await readFile(file, "utf8")).replace(/^rev:/m, legacy));
    await ctx.ws.requests.reload(rid);
    expect(ctx.ws.requests.require(rid).requirementProblems).toBeUndefined();
    await updateRequest(ctx, rid, { title: "題だけ" });
    const text = await readFile(file, "utf8");
    expect(text).toContain("source: 経理規程");
    expect(text).toContain("answer: はい");
    expect(ctx.ws.requests.require(rid).clarifyAnswers?.[0]).toMatchObject({ run: "PF-1", answer: "はい" });
  });
});

describe("評価対象への固定と採用", () => {
  it("回答すると要望に残り、古い評価からの採用は理由付きで断り何も変えない。再評価の資料に元の組で入る", async () => {
    const { ctx, rid, engine, preflight } = await setup();
    const plain = await preflight();
    expect(plain.input?.requirement).toBeUndefined();
    expect(plain.assessment?.verdict).toBe("clarify");
    const cq = plain.assessment!.clarifications![0];
    expect(cq).toMatchObject({ id: "Q1", ask: "要望者に確認先を特定してもらう" });
    const before = ctx.ws.tasksOf(rid).list().length;
    const ans = await saveClarifyAnswer(ctx, rid, plain.id, cq, { answer: "受け入れ条件は A と B", by: "業務の担当", on: "2026-11-10" }, { actor: "human:a" });
    expect(ans.answer).toMatchObject({ run: plain.id, question: "Q1", copy: { question: cq.question, ask: cq.ask }, by: "業務の担当", recordedBy: "human:a" });
    // 同じ値の再保存は rev を上げない
    const rev = ctx.ws.requests.require(rid).rev;
    await saveClarifyAnswer(ctx, rid, plain.id, cq, { answer: "受け入れ条件は A と B", by: "業務の担当", on: "2026-11-10" });
    expect(ctx.ws.requests.require(rid).rev).toBe(rev);
    // 過去の run は書き換えない。回答だけの変更でも古い評価からは採用しない
    expect((await ctx.preflight.get(rid, plain.id))!.assessment).toEqual(plain.assessment);
    const err = await ctx.preflight.materialize(rid, plain.id).catch((e) => e);
    expect(err).toBeInstanceOf(StaleInputError);
    expect(err.message).toContain("確認事項への回答");
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(before);
    // 再評価: 回答は元の組で資料に入る
    const next = await preflight();
    expect(engine.jobs.at(-1)!.clarifyAnswers?.[0]).toMatchObject({ run: plain.id, question: "Q1" });
    expect(next.input?.requirement?.answers.map((a) => a.question)).toEqual(["Q1"]);
    const md = readFileSync(join(ctx.ws.preflight.runDir(rid, next.id), "request.md"), "utf8");
    expect(md).toContain("## 確認事項への回答");
    expect(md).toContain(`${plain.id}/Q1 質問:`);
    expect((await ctx.preflight.inputMatch(rid, next, { fresh: true })).status).toBe("same");
    // Mock は回答を確認済みとして go にする
    expect(next.assessment?.verdict).toBe("go");
    expect((await ctx.preflight.materialize(rid, next.id)).tasks.length).toBeGreaterThan(0);
  });

  it("以前の run に固定した要求の根拠は比べない（回答が同じなら同じ）。壊れた固定入力は不明", async () => {
    const { ctx, rid, preflight } = await setup();
    const run = await preflight();
    const saved = (await ctx.preflight.get(rid, run.id))!;
    await ctx.ws.preflight.save({ ...saved, input: { ...saved.input!, requirement: { sources: [{ id: "S1", source: "経理規程" }], answers: [] } as never } });
    expect((await ctx.preflight.inputMatch(rid, (await ctx.preflight.get(rid, run.id))!, { fresh: true })).status).toBe("same");
    await ctx.ws.preflight.save({ ...saved, input: { ...saved.input!, requirement: { sources: "x" } as never } });
    expect((await ctx.preflight.inputMatch(rid, (await ctx.preflight.get(rid, run.id))!, { fresh: true })).status).toBe("unknown");
  });

  it("評価中に回答を変えると、その run からは採用しない", async () => {
    const { ctx, rid, engine, preflight } = await setup("- 一\n- 二");
    const first = await preflight();
    engine.hold();
    const { id } = await ctx.preflight.start(rid, { engine: "mock" });
    await saveClarifyAnswer(ctx, rid, first.id, first.assessment!.clarifications![0], { answer: "評価中に足した" });
    engine.release();
    const run = (await ctx.preflight.wait(rid, id))!;
    await expect(ctx.preflight.materialize(rid, run.id)).rejects.toMatchObject({ code: "stale_input", match: { changed: ["requirement"] } });
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
  it("p3 clarify・answer（通常と JSON・消す）と show。不正な入力は理由を返して書かない", async () => {
    const { dataDir, rid, preflight } = await setup();
    const run = await preflight();
    expect(JSON.parse(p3(dataDir, ["clarify", rid, "--json"]).out)).toMatchObject({ run: run.id, items: [{ clarification: { id: "Q1" }, state: "unanswered" }] });
    expect(p3(dataDir, ["clarify", rid]).out).toContain("確認先: 要望者に確認先を特定してもらう");
    const an = p3(dataDir, ["answer", rid, "Q1", "--body", "-", "--by", "業務の担当", "--on", "2026-11-10"], "条件は A\n");
    expect(an.code, an.err).toBe(0);
    expect(an.out).toContain("回答を要望に残しました");
    expect(JSON.parse(p3(dataDir, ["clarify", rid, "--json"]).out).items[0]).toMatchObject({ state: "answered", answer: { answer: "条件は A", by: "業務の担当", on: "2026-11-10", recordedBy: "ai:test" } });
    expect(p3(dataDir, ["show", rid]).out).toContain(`${run.id}/Q1  [回答済み]`);
    expect(p3(dataDir, ["answer", rid, "Q9", "--body", "x"]).err).toContain("Q9 はありません");
    expect(p3(dataDir, ["answer", rid, "Q1", "--body", "x", "--on", "2026-02-30"]).code).toBe(1);
    expect(p3(dataDir, ["answer", rid, "Q1", "--body", "x", "--grounds", "y"]).code).toBe(1); // 以前の版の根拠の指定は取らない
    expect(p3(dataDir, ["answer", rid, "Q1", "rm"]).code).toBe(0);
    expect(JSON.parse(p3(dataDir, ["clarify", rid, "--json"]).out).items[0].state).toBe("unanswered");
  });

  it("API: POST answers（消すのは answer: null）。規則に合わなければ 400 で書かず、古い評価からのタスク化は 409 stale_input", async () => {
    const { ctx, rid, preflight } = await setup();
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const run = await preflight();
    const a = await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q1", answer: "条件は A", by: "業務の担当" });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { requirement: { answers: { question: string; state: string }[] } }).requirement.answers).toMatchObject([{ question: "Q1", state: "answered" }]);
    expect((await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q9", answer: "x" })).status).toBe(400);
    expect((await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q1", answer: "x", on: "2026-02-30" })).status).toBe(400);
    const got = (await (await send("GET", `/requests/${rid}`)).json()) as { requirement: { answers: { answer: string }[] } };
    expect(got.requirement.answers.map((x) => x.answer)).toEqual(["条件は A"]);
    const stale = await send("POST", `/requests/${rid}/preflight/${run.id}/materialize`, {});
    expect([stale.status, ((await stale.json()) as { code: string }).code]).toEqual([409, "stale_input"]);
    expect((await send("POST", `/requests/${rid}/answers`, { run: run.id, question: "Q1", answer: null })).status).toBe(200);
    expect(ctx.ws.requests.require(rid).clarifyAnswers).toBeUndefined();
  });
});
