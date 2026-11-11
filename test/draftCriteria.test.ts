import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcceptanceInputError, readDraftCriteria, tidyDraftCriteria } from "../src/shared/acceptance.ts";
import { DRAFT_SPEC } from "../src/core/preflight/engine.ts";
import { DraftConflictError } from "../src/core/preflight/service.ts";
import { renderCarryover, selectCarryover } from "../src/core/preflight/carryover.ts";
import { stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * Preflight のタスク案の受け入れ基準: 出力の読み取り（文の並び・旧い案・不正な案）→ 人の編集（基準だけの競合）→ タスク化で ID ごと写す
 * （採用した案だけ・やり直しで重ねない・作ったタスクを上書きしない）
 */

async function mockRun() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "書き出し", status: "draft", body: "- CSV を書き出す\n- 画面にボタンを置く" });
  const { id } = await p.ctx.preflight.start(req.id, { engine: "mock" });
  await p.ctx.preflight.wait(req.id, id);
  const draftFile = (key: string) => join(p.dataDir, "requests", req.id, "preflight", id, "drafts", `${key}.md`);
  return { ...p, rid: req.id, run: id, draftFile };
}

describe("案の基準の読み取り（shared）", () => {
  it("文の並びに A1.. を振り、{id, text} はそのまま。読めない項目は除いて理由を返す。無いのは基準なし", () => {
    expect(readDraftCriteria(undefined)).toEqual({});
    expect(readDraftCriteria(["保存できる", " 再読み込みで残る "])).toEqual({ criteria: [{ id: "A1", text: "保存できる" }, { id: "A2", text: "再読み込みで残る" }] });
    expect(readDraftCriteria([{ id: "A3", text: "三" }, "四"]).criteria).toEqual([{ id: "A3", text: "三" }, { id: "A4", text: "四" }]);
    const bad = readDraftCriteria(["", { text: 1 }, { id: "A1", text: "x" }, { id: "A1", text: "y" }, 5 as never, null]);
    expect(bad.criteria).toEqual([{ id: "A2", text: "1" }, { id: "A1", text: "x" }]);
    expect(bad.problems).toEqual(["受け入れ基準 1 件目 が空です", "受け入れ基準の id が重複しています: A1", "受け入れ基準 5 件目 が文になっていません", "受け入れ基準 6 件目 が文になっていません"]);
    expect(readDraftCriteria("文").problems).toHaveLength(1);
    expect(tidyDraftCriteria([{ id: "A2", text: "二" }, { text: " 新 " }])).toEqual([{ id: "A2", text: "二" }, { id: "A3", text: "新" }]);
    expect(() => tidyDraftCriteria([{ text: " " }])).toThrow(AcceptanceInputError);
    expect(() => tidyDraftCriteria([{ id: "A1", text: "a" }, { id: "A1", text: "b" }])).toThrow(AcceptanceInputError);
  });

  it("出力の仕様は観測できる基準を頼む", () => {
    expect(DRAFT_SPEC).toContain("acceptanceCriteria:");
    expect(DRAFT_SPEC).toContain("観測できる");
  });
});

describe("案の基準の編集とタスク化（core・API）", () => {
  it("生成した案の基準を直してタスク化すると、採用した案の基準だけが ID ごとタスクに写り、読み直しても同じ", async () => {
    const { ctx, rid, run } = await mockRun();
    const drafts = (await ctx.preflight.get(rid, run))!.drafts;
    expect(drafts[0].acceptanceCriteria?.map((c) => c.id)).toEqual(["A1", "A2"]);
    const d1 = drafts[0];
    await ctx.preflight.updateDraft(rid, run, "D1", { acceptanceCriteria: [{ id: "A2", text: d1.acceptanceCriteria![1].text }, { text: "CSV の列の順が仕様どおり" }] }, { expectedCriteria: d1.acceptanceCriteria });
    await ctx.preflight.updateDraft(rid, run, "D2", { include: false });
    const r = await ctx.preflight.materialize(rid, run, "human:a");
    expect(r.tasks).toHaveLength(1);
    await ctx.ws.reloadAll();
    const t = ctx.ws.tasksOf(rid).require(r.tasks[0].id);
    expect(t.acceptanceCriteria).toEqual([{ id: "A2", text: d1.acceptanceCriteria![1].text }, { id: "A3", text: "CSV の列の順が仕様どおり" }]);
    expect(t.acceptanceSeq).toBe(3);
    expect(t.acceptanceEvidence).toBeUndefined();
  });

  it("同じ題のまま他で基準が変わっていたら、基準の保存は 409 で上書きしない。expectedCriteria の無い基準の保存は 400", async () => {
    const { ctx, rid, run, dataDir, draftFile } = await mockRun();
    const before = (await ctx.preflight.get(rid, run))!.drafts[0];
    const cli = await openTestProject(dataDir);
    await cli.preflight.updateDraft(rid, run, "D1", { acceptanceCriteria: [{ text: "外で直した基準" }] }, { expectedCriteria: before.acceptanceCriteria });
    await expect(ctx.preflight.updateDraft(rid, run, "D1", { acceptanceCriteria: [{ text: "画面の入力" }] }, { expectedCriteria: before.acceptanceCriteria })).rejects.toBeInstanceOf(DraftConflictError);
    const api = apiRoutes(ctx);
    const patch = (body: object) => api.request(`/requests/${rid}/preflight/${run}/drafts/D1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await patch({ title: before.title, expectedTitle: before.title, acceptanceCriteria: [{ text: "画面の入力" }], expectedCriteria: before.acceptanceCriteria });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { current: { acceptanceCriteria: unknown } }).current.acceptanceCriteria).toEqual([{ id: "A1", text: "外で直した基準" }]);
    expect(await readFile(draftFile("D1"), "utf8")).toContain("外で直した基準");
    expect((await patch({ acceptanceCriteria: [{ text: "x" }] })).status).toBe(400);
    const ok = await patch({ acceptanceCriteria: [{ text: "今の基準から直す" }], expectedCriteria: [{ id: "A1", text: "外で直した基準" }] });
    expect(ok.status).toBe(200);
    expect(await readFile(draftFile("D1"), "utf8")).not.toContain("expectedCriteria");
  });

  it("基準の無い旧い案はそのままタスク化でき、基準なしのタスクになる", async () => {
    const { ctx, rid, run, draftFile } = await mockRun();
    for (const k of ["D1", "D2"]) {
      const text = await readFile(draftFile(k), "utf8");
      await writeFile(draftFile(k), text.replace(/acceptanceCriteria:\n(?:  .*\n)+/, ""));
    }
    const drafts = (await ctx.preflight.get(rid, run))!.drafts;
    expect(drafts.every((d) => d.acceptanceCriteria === undefined && d.acceptanceProblems === undefined)).toBe(true);
    const r = await ctx.preflight.materialize(rid, run);
    expect(r.tasks.every((t) => t.acceptanceCriteria === undefined)).toBe(true);
  });

  it("読めない基準の案は知らせてタスク化を断り（何も作らない）、直せばタスク化できる", async () => {
    const { ctx, rid, run, draftFile } = await mockRun();
    const text = await readFile(draftFile("D2"), "utf8");
    await writeFile(draftFile("D2"), text.replace(/acceptanceCriteria:\n(?:  .*\n)+/, "acceptanceCriteria: 文ではない\n"));
    const d2 = (await ctx.preflight.get(rid, run))!.drafts[1];
    expect(d2.acceptanceProblems).toHaveLength(1);
    await expect(ctx.preflight.materialize(rid, run)).rejects.toThrow(/D2: acceptanceCriteria が並びになっていません/);
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(0);
    await ctx.preflight.updateDraft(rid, run, "D2", { acceptanceCriteria: [{ text: "直した基準" }] }, { expectedCriteria: d2.acceptanceCriteria });
    expect(await readFile(draftFile("D2"), "utf8")).not.toContain("acceptanceProblems");
    const r = await ctx.preflight.materialize(rid, run);
    expect(r.tasks[1].acceptanceCriteria).toEqual([{ id: "A1", text: "直した基準" }]);
  });

  it("採用のやり直しでは作ったタスクを作り直さず、上書きもしない", async () => {
    const { ctx, rid, run, dataDir } = await mockRun();
    const first = await ctx.preflight.materialize(rid, run);
    // 途中で止まった扱いにする（作ったタスクは残っている）
    const runFile = join(dataDir, "requests", rid, "preflight", run, "run.json");
    const meta = JSON.parse(await readFile(runFile, "utf8"));
    meta.materialization.done = false;
    await writeFile(runFile, JSON.stringify(meta));
    // 人がタスクの基準を変えた後に、案の基準も変わった
    await ctx.ws.tasksOf(rid).update(first.tasks[0].id, { acceptanceCriteria: [{ id: "A1", text: "タスクで直した" }] });
    await ctx.preflight.updateDraft(rid, run, "D1", { acceptanceCriteria: [{ text: "案で直した" }] }, { expectedCriteria: first.tasks[0].acceptanceCriteria });
    const again = await ctx.preflight.materialize(rid, run);
    expect(again.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(first.tasks.length);
    expect(ctx.ws.tasksOf(rid).require(first.tasks[0].id).acceptanceCriteria).toEqual([{ id: "A1", text: "タスクで直した" }]);
  });
});

describe("手元のエージェントの取り込み・引き継ぎ・CLI", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  const p3 = (dataDir: string, args: string[]) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("手元の結果の読めない基準は直せる問題として断る。直せば取り込む", async () => {
    const { ctx } = await makeProject();
    const req = await newRequest(ctx, { title: "通知", status: "draft", body: "通知" });
    const p = await ctx.preflight.prepare(req.id);
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(p.runDir, "assessment.json"), JSON.stringify({ summary: "s", verdict: "go", validity: { score: 80, reasons: ["r"] }, feasibility: { score: 70, reasons: ["f"] }, risks: [], questions: [], areas: [] }));
    await mkdir(join(p.runDir, "drafts"), { recursive: true });
    await mkdir(join(p.runDir, "ui"), { recursive: true });
    await writeFile(join(p.runDir, "ui", "index.json"), JSON.stringify({ needed: false, reason: "CLI だけ" }));
    const draft = (criteria: unknown) => writeFile(join(p.runDir, "drafts", "D1.md"), stringifyFrontmatter({ key: "D1", title: "送る", repo: "main", include: true, acceptanceCriteria: criteria }, "作業"));
    await draft(["送れる", ""]);
    await expect(ctx.preflight.complete(req.id, p.run.id)).rejects.toThrow("D1: 受け入れ基準 2 件目 が空です");
    await draft(["送れる", "失敗を記録する"]);
    const r = await ctx.preflight.complete(req.id, p.run.id);
    expect(r.run.drafts[0].acceptanceCriteria).toEqual([{ id: "A1", text: "送れる" }, { id: "A2", text: "失敗を記録する" }]);
  });

  it("再評価の引き継ぎに前回の基準（人の編集を含む）を書く。CLI の criteria <D> で読み・直せ、drafts に出る", async () => {
    const { ctx, rid, run, dataDir } = await mockRun();
    const d1 = (await ctx.preflight.get(rid, run))!.drafts[0];
    await ctx.preflight.updateDraft(rid, run, "D1", { acceptanceCriteria: [...d1.acceptanceCriteria!, { text: "人が足した基準" }] }, { expectedCriteria: d1.acceptanceCriteria });
    expect(renderCarryover(await selectCarryover(ctx.ws, rid))).toContain("人が足した基準");

    const req = ["--req", rid, "--run", run];
    const shown = JSON.parse(p3(dataDir, ["criteria", "D1", ...req, "--json"]).out) as { criteria: { id: string }[] };
    expect(shown.criteria.map((c) => c.id)).toEqual(["A1", "A2", "A3"]);
    expect(p3(dataDir, ["criteria", "D1", "rm", "A1", ...req]).code).toBe(0);
    expect(p3(dataDir, ["criteria", "D1", "add", "CLI で足した", ...req]).code).toBe(0);
    expect(p3(dataDir, ["criteria", "D1", "edit", "A9", "x", ...req]).code).toBe(1);
    const after = JSON.parse(p3(dataDir, ["criteria", `${rid}/D1`, "--run", run, "--json"]).out) as { criteria: { id: string; text: string }[] };
    expect(after.criteria.map((c) => c.id)).toEqual(["A2", "A3", "A4"]);
    expect(p3(dataDir, ["drafts", rid, "--run", run]).out).toContain("CLI で足した");
    // タスク化の後は直せない
    expect(p3(dataDir, ["accept", rid, "--run", run]).code).toBe(0);
    expect(p3(dataDir, ["criteria", "D1", "add", "後から", ...req]).code).toBe(1);
  });
});
