import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../packages/tasks/src/core/store/frontmatter.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";

/**
 * Preflight の案を更新した直後の応答と、読み直した結果で、基準・根拠・採番と読めない理由（acceptanceProblems）が同じになること
 * （261120-0pys5）。壊れた値は関係のない更新でファイルの元の値のまま残し、根拠の操作とタスク化は断る
 */

async function setup() {
  const repo = await makeRepo();
  const ctx = await openTestProject(repo.dataDir);
  const req = await newRequest(ctx, { title: "請求", status: "draft", body: "- 一\n- 二" });
  const { id } = await ctx.preflight.start(req.id, { engine: "mock", actor: "human:a" });
  const run = (await ctx.preflight.wait(req.id, id))!;
  const key = run.drafts[0].key;
  // 正常な根拠を1件つけてから壊す（正常な項目と壊れた項目が混ざる形にする）
  await ctx.preflight.updateDraft(req.id, run.id, key, { sourceOps: [{ id: "A1", source: { op: "add", source: "経理規程" } }] });
  const file = join(repo.dataDir, "requests", req.id, "preflight", run.id, "drafts", `${key}.md`);
  return { ctx, dataDir: repo.dataDir, rid: req.id, runId: run.id, key, file };
}

async function editFrontmatter(file: string, fn: (d: Record<string, unknown>) => void) {
  const { data, body } = parseFrontmatter(await readFile(file, "utf8"));
  fn(data);
  await writeFile(file, stringifyFrontmatter(data, body));
}
const rawOf = async (file: string) => parseFrontmatter(await readFile(file, "utf8")).data;
const count = (list: readonly string[] | undefined, re: RegExp) => (list ?? []).filter((p) => re.test(p)).length;
/** 読み直した案（別に開き直したプロジェクトから） */
async function reload(dataDir: string, rid: string, runId: string, key: string) {
  const fresh = await openTestProject(dataDir);
  return (await fresh.preflight.get(rid, runId))!.drafts.find((d) => d.key === key)!;
}
const view = (d: { acceptanceCriteria?: unknown; acceptanceSources?: unknown; acceptanceSourceSeq?: unknown; acceptanceProblems?: unknown; title: string }) => ({
  title: d.title,
  acceptanceCriteria: d.acceptanceCriteria,
  acceptanceSources: d.acceptanceSources,
  acceptanceSourceSeq: d.acceptanceSourceSeq,
  acceptanceProblems: d.acceptanceProblems,
});

describe("案の更新の応答と読み直しの診断を揃える", () => {
  it("壊れた根拠（正常な項目と混在）の案の題を変えると、応答と読み直しが同じで、理由は1回だけ。読めた根拠も揃い、元の値は残る", async () => {
    const { ctx, dataDir, rid, runId, key, file } = await setup();
    await editFrontmatter(file, (d) => (d.acceptanceSources = [...(d.acceptanceSources as unknown[]), { id: "壊れた" }]));
    const brokenRaw = (await rawOf(file)).acceptanceSources;
    const r = await ctx.preflight.updateDraft(rid, runId, key, { title: "題を変えた" });
    const again = await reload(dataDir, rid, runId, key);
    expect(view(r)).toEqual(view(again));
    expect(r.title).toBe("題を変えた");
    expect(r.acceptanceProblems!.length).toBeGreaterThan(0);
    expect(new Set(r.acceptanceProblems).size).toBe(r.acceptanceProblems!.length);
    expect(r.acceptanceSources!.map((s) => s.source)).toEqual(["経理規程"]);
    expect((await rawOf(file)).acceptanceSources).toEqual(brokenRaw);
    // 根拠の操作は理由を含めて断る
    await expect(ctx.preflight.updateDraft(rid, runId, key, { sourceOps: [{ id: "A1", source: { op: "add", source: "x" } }] })).rejects.toThrow(/読めないため変えられません/);
  });

  it("壊れた採番だけの案の題を変えると、応答と読み直しが同じで「acceptanceSourceSeq が読めません」は1回。根拠は読めたまま、採番の元の値は残る", async () => {
    const { ctx, dataDir, rid, runId, key, file } = await setup();
    await editFrontmatter(file, (d) => (d.acceptanceSourceSeq = "壊れた"));
    const r = await ctx.preflight.updateDraft(rid, runId, key, { title: "題だけ直す" });
    expect(view(r)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(r.acceptanceProblems).toEqual(["acceptanceSourceSeq が読めません"]);
    expect(r.acceptanceSources!.map((s) => s.id)).toEqual(["S1"]);
    expect((await rawOf(file)).acceptanceSourceSeq).toBe("壊れた");
    await expect(ctx.preflight.updateDraft(rid, runId, key, { sourceOps: [{ id: "A1", source: { op: "add", source: "x" } }] })).rejects.toThrow(/acceptanceSourceSeq が読めません/);
  });

  it("基準と根拠の両方が壊れた案: 題の変更では基準の元の値も残す。基準を置き換えると基準の理由は消え、根拠と採番の理由は1回ずつ残る", async () => {
    const { ctx, dataDir, rid, runId, key, file } = await setup();
    await editFrontmatter(file, (d) => {
      d.acceptanceCriteria = [...(d.acceptanceCriteria as unknown[]), { id: "壊れた id", text: "x" }];
      d.acceptanceSources = "壊れた";
      d.acceptanceSourceSeq = -1;
    });
    const before = await rawOf(file);
    const titled = await ctx.preflight.updateDraft(rid, runId, key, { title: "題を変えた" });
    expect(view(titled)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(count(titled.acceptanceProblems, /id が使えません/)).toBe(1);
    expect(count(titled.acceptanceProblems, /acceptanceSources が並びになっていません/)).toBe(1);
    expect(count(titled.acceptanceProblems, /acceptanceSourceSeq が読めません/)).toBe(1);
    const afterTitle = await rawOf(file);
    expect([afterTitle.acceptanceCriteria, afterTitle.acceptanceSources, afterTitle.acceptanceSourceSeq]).toEqual([before.acceptanceCriteria, "壊れた", -1]);

    // 壊れているあいだはタスク化を断る（理由を含める）
    await expect(ctx.preflight.materialize(rid, runId)).rejects.toThrow(/acceptanceSourceSeq が読めません/);

    const replaced = await ctx.preflight.updateDraft(rid, runId, key, { acceptanceCriteria: [{ id: "A1", text: "直した基準" }] });
    expect(view(replaced)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(replaced.acceptanceCriteria).toEqual([{ id: "A1", text: "直した基準" }]);
    expect(count(replaced.acceptanceProblems, /id が使えません/)).toBe(0);
    expect(count(replaced.acceptanceProblems, /acceptanceSources が並びになっていません/)).toBe(1);
    expect(count(replaced.acceptanceProblems, /acceptanceSourceSeq が読めません/)).toBe(1);
    expect(replaced.acceptanceProblems).toHaveLength(2);
    const afterReplace = await rawOf(file);
    expect([afterReplace.acceptanceSources, afterReplace.acceptanceSourceSeq]).toEqual(["壊れた", -1]);
    await expect(ctx.preflight.materialize(rid, runId)).rejects.toThrow(/acceptanceSources が並びになっていません/);
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(0);
  });
});
