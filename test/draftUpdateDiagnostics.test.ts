import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, stringifyFrontmatter } from "../packages/tasks/src/core/store/frontmatter.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";

/**
 * Preflight の案を更新した直後の応答と、読み直した結果で、基準と読めない理由（acceptanceProblems）が同じになること
 * （261120-0pys5）。壊れた値は関係のない更新でファイルの元の値のまま残し、タスク化は断る。以前の版の要求の根拠は読まない
 */

async function setup() {
  const repo = await makeRepo();
  const ctx = await openTestProject(repo.dataDir);
  const req = await newRequest(ctx, { title: "請求", status: "draft", body: "- 一\n- 二" });
  const { id } = await ctx.preflight.start(req.id, { engine: "mock", actor: "human:a" });
  const run = (await ctx.preflight.wait(req.id, id))!;
  const key = run.drafts[0].key;
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
const view = (d: { acceptanceCriteria?: unknown; acceptanceProblems?: unknown; title: string }) => ({ title: d.title, acceptanceCriteria: d.acceptanceCriteria, acceptanceProblems: d.acceptanceProblems });

describe("案の更新の応答と読み直しの診断を揃える", () => {
  it("壊れた基準（正常な項目と混在）の案: 題の変更では応答と読み直しが同じで理由は1回、元の値は残りタスク化を断る。置き換えると理由は消える", async () => {
    const { ctx, dataDir, rid, runId, key, file } = await setup();
    await editFrontmatter(file, (d) => (d.acceptanceCriteria = [...((d.acceptanceCriteria as unknown[]) ?? []), { id: "壊れた id", text: "x" }]));
    const before = await rawOf(file);
    const titled = await ctx.preflight.updateDraft(rid, runId, key, { title: "題を変えた" });
    expect(view(titled)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(titled.title).toBe("題を変えた");
    expect(count(titled.acceptanceProblems, /id が使えません/)).toBe(1);
    expect(new Set(titled.acceptanceProblems).size).toBe(titled.acceptanceProblems!.length);
    expect((await rawOf(file)).acceptanceCriteria).toEqual(before.acceptanceCriteria);
    await expect(ctx.preflight.materialize(rid, runId)).rejects.toThrow(/id が使えません/);

    const replaced = await ctx.preflight.updateDraft(rid, runId, key, { acceptanceCriteria: [{ id: "A1", text: "直した基準" }] });
    expect(view(replaced)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(replaced.acceptanceCriteria).toEqual([{ id: "A1", text: "直した基準" }]);
    expect(replaced.acceptanceProblems).toBeUndefined();
    expect(ctx.ws.tasksOf(rid).list()).toHaveLength(0);
  });

  it("以前の版の要求の根拠（acceptanceSources・採番）が壊れていても読まず、問題にもせずタスク化できる", async () => {
    const { ctx, dataDir, rid, runId, key, file } = await setup();
    await editFrontmatter(file, (d) => {
      d.acceptanceSources = "壊れた";
      d.acceptanceSourceSeq = -1;
    });
    const r = await ctx.preflight.updateDraft(rid, runId, key, { title: "題だけ直す" });
    expect(view(r)).toEqual(view(await reload(dataDir, rid, runId, key)));
    expect(r.acceptanceProblems).toBeUndefined();
    await ctx.preflight.materialize(rid, runId);
    expect(ctx.ws.tasksOf(rid).list().length).toBeGreaterThan(0);
  });
});
