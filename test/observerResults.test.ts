import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionStore, PreparationStore } from "../packages/observer/src/core/definitionStore.ts";
import { ResultStore } from "../packages/observer/src/core/resultStore.ts";
import { judge, prerequisiteState } from "../packages/observer/src/shared/result.ts";
import { observerRoutes } from "../packages/observer/src/server/api/routes.ts";
import { tempDir } from "./helpers.ts";
import { initialized, p3 } from "./cliHelpers.ts";

/**
 * 観測の実行と結果（docs/architecture.md「p3-observer」の観測の実行と結果）: 開始で定義の版と中身・使う準備を写す・段の記録の検証・
 * 前提の観測と準備の失敗は未確認・後処理の失敗は判定を変えない・期待が未記入は未確認・完了と中断の後は変えない・定義は変わらない・
 * CLI（run・record・finish・interrupt・results）と API の往復
 */
const AI = { kind: "ai-instruction", target: "一覧", steps: ["開く"], judge: "1秒以内", record: "ms に書く" };
const machine = { kind: "machine", command: "node measure.mjs", result: "終了コード 0" };

async function setup() {
  const dataDir = tempDir("p3-res-");
  const defs = new DefinitionStore(dataDir);
  const preps = new PreparationStore(dataDir);
  const prep = await preps.create({ name: "データ", check: { run: AI }, setup: { run: AI }, teardown: { run: AI }, exclusive: [] }, "human:t");
  const pre = await defs.create({ title: "サインイン", description: "x", expected: "入れる", procedures: [{ title: "入る", measures: [], run: AI }] }, "human:t");
  const d = await defs.create(
    { title: "一覧の速さ", description: "x", expected: "1秒以内", prerequisites: [pre.id], preparations: [prep.id], measures: [{ name: "ms", type: "number", unit: "ms" }], procedures: [{ title: "開く", measures: ["ms"], run: AI }] },
    "human:t",
  );
  return { dataDir, defs, prep, pre, d, results: new ResultStore(dataDir, defs, preps) };
}

describe("結果の記録と判定", () => {
  it("開始で版と中身を写し、段の記録を確かめ、前提と準備がそろって手順が期待どおりなら期待どおり。定義は変わらない", async () => {
    const { dataDir, defs, prep, pre, d, results } = await setup();
    const before = readFileSync(join(dataDir, "observer/definitions", `${d.id}.json`), "utf8");
    // 前提の観測を先に今の版で期待どおりにする
    const p = await results.start(pre.id, "human:t", { repos: [] });
    await results.record(pre.id, p.id, { phase: "procedure", ref: "P1", result: "met", basis: { kind: "declaration" } }, "human:t");
    expect((await results.finish(pre.id, p.id, "human:t")).verdict).toBe("met");

    const r = await results.start(d.id, "ai:t", { repos: [{ name: "app", commit: "abc" }], note: "手元" });
    expect(r).toMatchObject({ status: "running", rev: 1, snapshot: { expected: "1秒以内", prerequisites: [pre.id], preparations: [{ id: prep.id, name: "データ" }] }, environment: { repos: [{ name: "app", commit: "abc" }], note: "手元" } });
    const bad = results.record(d.id, r.id, { phase: "procedure", ref: "P9", result: "ok", measures: { x: 1 }, basis: { kind: "machine" } }, "ai:t");
    await expect(bad).rejects.toMatchObject({ code: "invalid", problems: expect.arrayContaining([expect.objectContaining({ path: "ref" }), expect.objectContaining({ path: "result" }), expect.objectContaining({ path: "basis.command" })]) });
    await expect(results.record(d.id, r.id, { phase: "procedure", ref: "P1", result: "met", measures: { ms: "速い" }, basis: machine }, "ai:t")).rejects.toMatchObject({ problems: [expect.objectContaining({ path: "measures.ms" })] });
    await expect(results.record(d.id, r.id, { phase: "teardown", ref: "無い準備", result: "met", basis: machine }, "ai:t")).rejects.toMatchObject({ code: "invalid" });
    for (const phase of ["check", "setup"]) await results.record(d.id, r.id, { phase, ref: "データ", result: "met", basis: machine }, "ai:t");
    await results.record(d.id, r.id, { phase: "procedure", ref: "P1", result: "unmet", measures: { ms: 1800 }, basis: machine }, "ai:t");
    // 記録し直すと後のものを使う（前のものも残る）
    await results.record(d.id, r.id, { phase: "procedure", ref: "P1", result: "met", measures: { ms: 700 }, basis: machine, evidence: "shot.png" }, "ai:t");
    await results.record(d.id, r.id, { phase: "teardown", ref: prep.id, result: "failed", basis: { kind: "read", reference: "画面に残った" } }, "ai:t");
    const done = await results.finish(d.id, r.id, "ai:t");
    expect(done).toMatchObject({ status: "completed", verdict: "met", prerequisites: [{ id: pre.id, state: "met", result: p.id }], teardownProblems: ["準備「データ」の後処理が実行できなかった"] });
    expect(done.steps).toHaveLength(5);
    await expect(results.record(d.id, r.id, { phase: "procedure", ref: "P1", result: "met", basis: machine }, "ai:t")).rejects.toMatchObject({ code: "conflict" });
    await expect(results.finish(d.id, r.id, "ai:t")).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(join(dataDir, "observer/definitions", `${d.id}.json`), "utf8")).toBe(before);
    expect((await defs.get(d.id)).rev).toBe(1);
    expect((await results.list(d.id)).results.map((x) => x.id)).toEqual([r.id]);
  });

  it("前提の観測が今の版で期待どおりでない・準備の失敗・期待の未記入は未確認、手順の未達は期待どおりでない", async () => {
    const { defs, d, pre, prep, results } = await setup();
    const steps = (res: "met" | "unmet" | "failed", setupRes: "met" | "unmet" = "met") => [
      { phase: "check" as const, ref: prep.id, result: "met" as const, basis: { kind: "declaration" as const }, at: "", by: "" },
      { phase: "setup" as const, ref: prep.id, result: setupRes, basis: { kind: "declaration" as const }, at: "", by: "" },
      { phase: "procedure" as const, ref: "P1", result: res, basis: { kind: "declaration" as const }, at: "", by: "" },
    ];
    const snapshot = (await results.start(d.id, "x", { repos: [] })).snapshot;
    const ok = [{ id: pre.id, state: "met" as const }];
    expect(judge({ snapshot, steps: steps("unmet") }, ok)).toMatchObject({ verdict: "unmet", reason: expect.stringContaining("P1 開く") });
    expect(judge({ snapshot, steps: steps("failed") }, ok)).toMatchObject({ verdict: "unconfirmed", reason: expect.stringContaining("実行できなかった") });
    expect(judge({ snapshot, steps: steps("met", "unmet") }, ok)).toMatchObject({ verdict: "unconfirmed", reason: "準備「データ」の前処理が期待どおりでない" });
    expect(judge({ snapshot, steps: steps("met").slice(1) }, ok)).toMatchObject({ verdict: "unconfirmed", reason: "準備「データ」の確かめが記録されていない" });
    expect(judge({ snapshot, steps: steps("met") }, [{ id: pre.id, state: "none" }])).toMatchObject({ verdict: "unconfirmed", reason: expect.stringContaining("まだ実行していない") });
    expect(judge({ snapshot: { ...snapshot, expected: undefined }, steps: steps("met") }, ok)).toMatchObject({ verdict: "unconfirmed", reason: expect.stringContaining("期待が未記入") });
    // 前提の観測の状態: 今の版の結果が無ければ古い（stale）
    const p = await results.start(pre.id, "x", { repos: [] });
    await results.record(pre.id, p.id, { phase: "procedure", ref: "P1", result: "met", basis: { kind: "declaration" } }, "x");
    await results.finish(pre.id, p.id, "x");
    await defs.update(pre.id, 1, { title: "サインイン", description: "x", expected: "すぐ入れる", procedures: [{ id: "P1", title: "入る", measures: [], run: AI }] }, "x", { reason: "速さ" });
    expect(prerequisiteState(pre.id, await defs.get(pre.id), (await results.list(pre.id)).results)).toMatchObject({ state: "stale", rev: 1 });
    const r = await results.start(d.id, "x", { repos: [] });
    for (const st of steps("met")) await results.record(d.id, r.id, { phase: st.phase, ref: st.ref, result: st.result, basis: st.basis }, "x");
    expect(await results.finish(d.id, r.id, "x")).toMatchObject({ verdict: "unconfirmed", reason: expect.stringContaining("今の版で実行していない") });
  });

  it("中断は理由が要り、その後は変えない。終了した観測は始めない。壊れた結果は一覧に理由を出す", async () => {
    const { dataDir, defs, d, results } = await setup();
    const r = await results.start(d.id, "x", { repos: [] });
    await expect(results.interrupt(d.id, r.id, "x", " ")).rejects.toMatchObject({ code: "invalid" });
    expect(await results.interrupt(d.id, r.id, "x", "前処理の途中で止めた")).toMatchObject({ status: "interrupted", interruptedReason: "前処理の途中で止めた" });
    await expect(results.record(d.id, r.id, { phase: "procedure", ref: "P1", result: "met", basis: { kind: "declaration" } }, "x")).rejects.toMatchObject({ code: "conflict" });
    writeFileSync(join(dataDir, "observer/results", d.id, "res-261121-zzzzz.json"), "{");
    expect((await results.list(d.id)).unreadable).toEqual([{ file: "res-261121-zzzzz.json", reason: expect.any(String) }]);
    const e = await defs.create({ title: "終える", description: "x" }, "x");
    await defs.end(e.id, 1, { reason: "不要" }, "x");
    await expect(results.start(e.id, "x", { repos: [] })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("CLI と API", () => {
  it("run・record・finish・results と、API の開始・記録・完了", async () => {
    const { root } = await initialized();
    const j = (args: string[], input?: unknown) => {
      const r = p3(root, [...args, "--json"], {}, undefined, input === undefined ? undefined : JSON.stringify(input));
      expect(r.code, r.err).toBe(0);
      return r.json();
    };
    const d = j(["observer", "add", "--input", "-"], { title: "速さ", description: "x", expected: "速い", procedures: [{ title: "開く", measures: [], run: AI }] });
    const r = j(["observer", "run", d.id, "--body", "手元"]);
    expect(r.environment.repos[0]).toMatchObject({ name: expect.any(String) });
    expect(r.environment.note).toBe("手元");
    j(["observer", "record", d.id, r.id, "--input", "-"], { phase: "procedure", ref: "P1", result: "met", basis: machine });
    expect(j(["observer", "finish", d.id, r.id])).toMatchObject({ status: "completed", verdict: "met" });
    expect(j(["observer", "results", d.id]).results.map((x: { id: string }) => x.id)).toEqual([r.id]);
    expect(p3(root, ["observer", "results", d.id, r.id]).out).toContain("期待どおり");
    expect(p3(root, ["observer", "finish", d.id, r.id]).code).toBe(3);
    expect(p3(root, ["observer", "record", d.id]).code).toBe(1);

    const dataDir = j(["whoami"]).dataDir as string;
    const app = observerRoutes({ target: { dataDir } });
    const call = async (path: string, body?: unknown) => {
      const res = await app.request(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const started = await call(`/definitions/${d.id}/results`, { note: "画面" });
    expect(started.status).toBe(201);
    const rid = started.json.id as string;
    expect((await call(`/definitions/${d.id}/results/${rid}/steps`, { phase: "procedure", ref: "P1", result: "unmet", basis: machine })).status).toBe(200);
    expect((await call(`/definitions/${d.id}/results/${rid}/steps`, { phase: "procedure", ref: "P2" })).status).toBe(400);
    expect((await call(`/definitions/${d.id}/results/${rid}/finish`, {})).json).toMatchObject({ verdict: "unmet" });
    expect(((await call(`/definitions/${d.id}/results`)).json.results as unknown[]).length).toBe(2);
    expect((await call(`/definitions/${d.id}/results/res-261121-aaaaa`)).status).toBe(404);
  });
});
