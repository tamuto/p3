import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { METRIC_DEFINITIONS, type MetricsInput } from "../packages/tasks/src/features/metrics/core/definitions.ts";
import { metricScopeOf, metricsReport } from "../packages/tasks/src/features/metrics/core/index.ts";
import { createTask, updateRequest, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import type { CompletionRecord } from "../packages/tasks/src/features/records/shared/completionRecord.ts";
import type { MetricResult } from "../packages/tasks/src/features/metrics/shared/metrics.ts";
import type { Request, Task } from "../packages/tasks/src/shared/types.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, tempDir } from "./helpers.ts";

/**
 * 開発の指標（core/metrics）: 到達時間の中央値と未到達・欠損の区別、受け入れ基準の件数と分母、範囲（所属・親子・見送り）、
 * 無対象と欠損の区別、CLI と API が同じ値を返すことを確かめる
 */

const H = 3_600_000;
const base = Date.parse("2026-11-01T00:00:00.000Z");
const at = (h: number) => new Date(base + h * H).toISOString();
const rec = (id: string, trigger: CompletionRecord["trigger"], h: number): CompletionRecord => ({ id, trigger, at: at(h), rev: 1, status: "x", quality: { state: "unset", version: "v" } });
const req = (id: string, status: Request["status"], records?: CompletionRecord[], extra: Partial<Request> = {}): Request =>
  ({ id, title: id, status, areas: [], tags: [], body: "", rev: 1, createdAt: at(0), updatedAt: at(500), ...(records ? { completionRecords: records } : {}), ...extra });
const task = (rid: string, id: string, status: Task["status"], extra: Partial<Task> = {}): Task =>
  ({ id, request: rid, ref: `${rid}/${id}`, title: id, status, labels: [], areas: [], outputs: [], repo: null, body: "", rev: 1, createdAt: at(0), updatedAt: at(0), ...extra }) as Task;
const input = (requests: Request[], tasks: Record<string, Task[]> = {}, broken: Record<string, string[]> = {}): MetricsInput => ({
  requests: requests.map((request) => ({ request, tasks: tasks[request.id] ?? [], brokenTasks: broken[request.id] ?? [], reviews: {} })),
  manual: { records: [] },
});
const metric = (id: string, i: MetricsInput) => {
  const d = METRIC_DEFINITIONS.find((x) => x.id === id)!;
  return d.compute(i);
};
const count = (m: Pick<MetricResult, "breakdown">, key: string) => m.breakdown.find((b) => b.key === key)?.count;

describe("要望の到達時間", () => {
  it("対応済・完了済は作成から最初の記録までの中央値を別々に出し、再度の対応済は数えない", () => {
    const i = input([
      req("a", "done", [rec("C1", "request_resolved", 10), rec("C2", "request_done", 30)]),
      req("b", "resolved", [rec("C1", "request_resolved", 20), rec("C2", "request_resolved", 99)]),
      req("c", "done", [rec("C1", "request_resolved", 40), rec("C2", "request_done", 50)]),
    ]);
    const r = metric("request_to_resolved", i);
    expect(r).toMatchObject({ state: "ok", value: 20, targets: 3, observed: 3, missing: 0 });
    const d = metric("request_to_done", i);
    expect(d).toMatchObject({ state: "ok", value: 40, targets: 3, observed: 2, missing: 0 });
    expect(count(d, "not_reached")).toBe(1);
  });

  it("完了済への直接遷移は未到達、日時の欠損・破損・逆転・記録の無い到達は欠損にし、0 時間として数えない", () => {
    const i = input([
      req("direct", "done", [rec("C1", "request_done", 5)]),
      req("old", "done"),
      req("noRec", "resolved"),
      req("badAt", "resolved", [{ ...rec("C1", "request_resolved", 1), at: "not-a-date" }]),
      req("reverse", "resolved", [rec("C1", "request_resolved", -3)]),
      req("noCreated", "resolved", [rec("C1", "request_resolved", 3)], { createdAt: new Date(0).toISOString() }),
      req("broken", "resolved", undefined, { completionProblems: ["completionRecords が並びになっていません"] }),
      req("active", "active"),
    ]);
    const r = metric("request_to_resolved", i);
    expect(r).toMatchObject({ state: "no_data", value: null, targets: 8, observed: 0, missing: 6 });
    expect(count(r, "not_reached")).toBe(2);
    expect(count(r, "unknown")).toBe(1);
    expect(r.missingItems.map((m) => m.target)).toEqual(["old", "noRec", "badAt", "reverse", "noCreated", "broken"]);
    expect(r.missingItems.find((m) => m.target === "reverse")?.reason).toMatch(/逆転/);
    // 完了済の記録だけある direct は完了済には到達している
    const d = metric("request_to_done", i);
    expect(d).toMatchObject({ state: "ok", value: 5, observed: 1 });
    expect(d.missingItems.map((m) => m.target)).toEqual(["old", "broken"]);
  });

  it("対象なし・まだ到達していないは値 null で、0 と区別する", () => {
    expect(metric("request_to_resolved", input([]))).toMatchObject({ state: "no_targets", value: null, targets: 0 });
    expect(metric("request_to_done", input([req("a", "active")]))).toMatchObject({ state: "not_reached", value: null, targets: 1, missing: 0 });
  });
});

describe("受け入れ基準", () => {
  const crit = [
    { id: "A1", text: "一" },
    { id: "A2", text: "二" },
    { id: "A3", text: "三" },
    { id: "A4", text: "四" },
    { id: "A5", text: "五" },
  ];
  const ev = (criterionId: string, result: "met" | "unmet" | "unverified", criterionText: string, basis?: { kind: "declaration" } | { kind: "read"; reference: string }) => ({
    criterionId,
    criterionText,
    result,
    evidence: "e",
    recordedAt: at(1),
    ...(basis ? { basis } : {}),
  });

  it("今完了しているタスクの基準を、未達・未検証・証拠なし・再確認と申告のみの内訳で分母つきに数える", () => {
    const t1 = task("r", "T001", "done", {
      acceptanceCriteria: crit,
      acceptanceEvidence: [ev("A1", "met", "一"), ev("A2", "met", "二", { kind: "read", reference: "x" }), ev("A3", "unmet", "三"), ev("A4", "unverified", "四 旧"), ev("A9", "met", "消した")],
    });
    const t2 = task("r", "T002", "done", { acceptanceCriteria: [{ id: "A1", text: "x" }], acceptanceEvidence: [ev("A1", "unverified", "x")] });
    const open = task("r", "T003", "doing", { acceptanceCriteria: [{ id: "A1", text: "y" }] });
    const none = task("r", "T004", "done");
    const bad = task("r", "T005", "done", { acceptanceProblems: ["acceptanceCriteria が並びになっていません"] });
    const i = input([req("r", "active")], { r: [t1, t2, open, none, bad] }, { r: ["T006"] });
    const get = (id: string) => metric(id, i);
    expect(get("acceptance_unmet")).toMatchObject({ state: "ok", value: 1, denominator: 6, targets: 4, observed: 2, missing: 2 });
    expect(get("acceptance_unverified")).toMatchObject({ value: 1 });
    expect(get("acceptance_no_evidence")).toMatchObject({ value: 1 });
    expect(get("acceptance_stale")).toMatchObject({ value: 1 });
    const met = get("acceptance_met");
    expect(met).toMatchObject({ value: 2, denominator: 6 });
    expect(count(met, "basis_declaration")).toBe(1);
    expect(count(met, "basis_read")).toBe(1);
    expect(count(met, "tasks_no_criteria")).toBe(1);
    expect(get("acceptance_unmet").missingItems.map((m) => m.target)).toEqual(["r/T006", "r/T005"]);
  });

  it("基準なしだけなら対象なし、読めないだけなら欠損で、どちらも 0 件と言わない", () => {
    expect(metric("acceptance_unmet", input([req("r", "active")], { r: [task("r", "T001", "done")] }))).toMatchObject({ state: "no_targets", value: null, denominator: 0, targets: 1 });
    expect(metric("acceptance_unmet", input([req("r", "active")], {}, { r: ["T001"] }))).toMatchObject({ state: "no_data", value: null, missing: 1 });
  });
});

describe("範囲と CLI・API", () => {
  async function setup() {
    const p = await makeProject({ milestones: [{ id: "m1", title: "一" }, { id: "m2", title: "二" }] });
    const { ctx } = p;
    const parent = await newRequest(ctx, { title: "親", milestone: "m1" });
    const child = await newRequest(ctx, { title: "子", milestone: "m2", parent: parent.id });
    const loose = await newRequest(ctx, { title: "所属なし" });
    const rejected = await newRequest(ctx, { title: "見送り", milestone: "m1", status: "rejected" });
    const archived = await newRequest(ctx, { title: "アーカイブ", milestone: "m1" });
    const done = async (rid: string, text: string, result: "met" | "unmet") => {
      const t = await createTask(ctx, rid, { title: text, criteria: [text] }, "human:t");
      await updateTask(ctx, rid, t.task.id, { status: "done", record: "r", acceptance: [{ op: "record", id: "A1", result, evidence: "e" }] }, { actor: "human:t" });
    };
    await done(parent.id, "親の基準", "met");
    await done(child.id, "子の基準", "unmet");
    await done(loose.id, "所属なしの基準", "met");
    await done(rejected.id, "見送りの基準", "unmet");
    await updateRequest(ctx, loose.id, { status: "resolved" });
    await ctx.ws.requests.archive(archived.id);
    return { ...p, parent, child, loose };
  }

  it("マイルストーンは今の直接の所属で、親子のタスクは一度ずつ。プロジェクト全体は所属なしを含み、見送り・アーカイブは除く", async () => {
    const { ctx } = await setup();
    const pick = async (scope: Parameters<typeof metricsReport>[1], id: string) => (await metricsReport(ctx, scope)).metrics.find((m) => m.id === id)!;
    expect(await pick({ kind: "milestone", id: "m1" }, "acceptance_unmet")).toMatchObject({ value: 0, denominator: 1, targets: 1 });
    expect(await pick({ kind: "milestone", id: "m2" }, "acceptance_unmet")).toMatchObject({ value: 1, denominator: 1, targets: 1 });
    expect(await pick({ kind: "project" }, "acceptance_unmet")).toMatchObject({ value: 1, denominator: 3, targets: 3 });
    expect(await pick({ kind: "project" }, "request_to_resolved")).toMatchObject({ state: "ok", targets: 3, observed: 1 });
    expect(() => metricScopeOf(ctx, "nope")).toThrow(/登録されていません/);
    expect((await metricsReport(ctx)).scopes.map((s) => s.label)).toEqual(["プロジェクト全体", "m1 一", "m2 二"]);
  });

  it("読めない要望は所属が分からないので知らせ、数えない", async () => {
    const { ctx, dataDir } = await setup();
    const bad = await newRequest(ctx, { title: "壊す", milestone: "m1" });
    const file = join(dataDir, "requests", bad.id, "request.md");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^---\n/, "---\n: [broken\n"));
    await ctx.ws.load();
    const r = await metricsReport(ctx, { kind: "milestone", id: "m1" });
    expect(r.notices).toEqual([expect.objectContaining({ code: "broken_request", target: `requests/${bad.id}/request.md` })]);
  });

  it("CLI と API は同じ範囲から同じ指標 ID・値・単位・対象数・欠損数を返し、知らない範囲は使い方の誤り・400", async () => {
    const { ctx, dataDir } = await setup();
    const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const cli = (args: string[]) => spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
    const app = apiRoutes(ctx);
    const shape = (r: { metrics: MetricResult[] }) => r.metrics.map((m) => [m.id, m.value, m.unit, m.targets, m.missing, m.denominator]);
    for (const [args, q] of [
      [[], ""],
      [["--milestone", "m2"], "?milestone=m2"],
    ] as const) {
      const c = cli(["metrics", ...args, "--json"]);
      expect(c.status, c.stderr).toBe(0);
      const api = (await (await app.request(`/metrics${q}`)).json()) as { metrics: MetricResult[] };
      expect(shape(JSON.parse(c.stdout))).toEqual(shape(api));
      // 指標の ID と並びは固定（両方の入口で同時に並びが変わる回帰も見つける）
      expect(api.metrics.map((m) => m.id)).toEqual([
        "request_to_resolved",
        "request_to_done",
        "acceptance_unmet",
        "acceptance_unverified",
        "acceptance_no_evidence",
        "acceptance_stale",
        "acceptance_met",
        "rework",
        "review_missing",
        "review_unplanned",
        "cost",
        "post_release_defects",
      ]);
    }
    expect(cli(["metrics"]).stdout).toContain("未達の受け入れ基準  [acceptance_unmet]  1 件 / 基準 3 件");
    expect(cli(["metrics", "--milestone", "nope"]).status).toBe(1);
    expect((await app.request("/metrics?milestone=nope")).status).toBe(400);
  });
});
