import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexPrompt } from "../src/core/preflight/codexEngine.ts";
import type { PreflightJob } from "../src/core/preflight/engine.ts";
import { StaleInputError } from "../src/core/preflight/input.ts";
import { ChildDraftsChangedError } from "../src/core/preflight/service.ts";
import { createRequest, updateRequest } from "../src/core/requestOps.ts";
import { stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newTask } from "./helpers.ts";

/** Preflight の分割の案（docs/architecture.md の「Preflight の分割の案」） */
const bullets = (n: number) => Array.from({ length: n }, (_, i) => `- 項目${i + 1}`).join("\n");

async function setup(n = 6) {
  const p = await makeProject({ milestones: [{ id: "v1", title: "最初" }] });
  const parent = await createRequest(p.ctx, { title: "大きい要望", body: bullets(n), milestone: "v1", tags: ["big"], due: "2026-12-01" });
  const run = async (rid = parent.id) => {
    const { id } = await p.ctx.preflight.start(rid, { engine: "mock" });
    return (await p.ctx.preflight.wait(rid, id))!;
  };
  const runDir = (runId: string, rid = parent.id) => p.ctx.ws.preflight.runDir(rid, runId);
  return { ...p, parent, run, runDir };
}

describe("Mock の両モード", () => {
  it("想定 5 件はタスク案（分けない判断を残す）、6 件は子の案だけを書く", async () => {
    const five = await setup(5);
    const r5 = await five.run();
    expect(r5.drafts).toHaveLength(5);
    expect(r5.children).toBeUndefined();
    expect(r5.assessment?.split).toMatchObject({ decision: "keep", estimatedTasks: 5 });

    const six = await setup(6);
    const r6 = await six.run();
    expect(r6.drafts).toEqual([]);
    expect(r6.children?.map((c) => c.key)).toEqual(["C1", "C2"]);
    expect(r6.children?.[1]).toMatchObject({ estimatedTasks: 3, requires: ["C1"], include: true });
    expect(r6.assessment?.split).toMatchObject({ decision: "split", estimatedTasks: 6 });
    expect(r6.draftProblems).toBeUndefined();
    // 子の案の run はタスク化しない
    await expect(six.ctx.preflight.materialize(six.parent.id, r6.id)).rejects.toThrow("子の要望の案の run");
  });

  it("Codex の依頼文に分割の基準・子の案の形・親の目的・今ある子を入れる", () => {
    const job = {
      project: { name: "p", description: "", repos: {}, milestones: [], branchPattern: "req/{id}", preflight: { instructions: "" } },
      request: { id: "261001-aaaaa", title: "子", status: "draft", areas: [], tags: [], rev: 1, createdAt: "", updatedAt: "", body: "範囲" },
      refs: [],
      dataDir: "/tmp/data",
      runDir: "/tmp/data/requests/261001-aaaaa/preflight/PF-1",
      parent: { id: "261001-bbbbb", title: "親の題", body: "親の目的" },
      children: [{ id: "261001-ccccc", title: "孫", status: "draft" }],
    } as unknown as PreflightJob;
    const text = codexPrompt(job);
    expect(text).toContain("想定するタスクの数が 6 以上");
    expect(text).toContain("children/C1.md");
    expect(text).toContain("> 親の目的");
    expect(text).toContain("261001-ccccc 孫");
  });
});

describe("子の案の読み込み", () => {
  it("混在・キーの重なり・目的と完了条件の欠け・無い案や親に無いタスクへの参照を問題にし、採用しない", async () => {
    const { ctx, parent, run, runDir } = await setup(6);
    const r = await run();
    const dir = join(runDir(r.id), "children");
    writeFileSync(join(dir, "C3.md"), stringifyFrontmatter({ key: "C1", title: "", requires: ["C9"], overlaps: ["T005"] }, "## 範囲\nx"));
    mkdirSync(join(runDir(r.id), "drafts"), { recursive: true });
    writeFileSync(join(runDir(r.id), "drafts", "D1.md"), stringifyFrontmatter({ key: "D1", title: "混ざった案" }, "x"));
    const preview = await ctx.preflight.previewMaterialize(parent.id, r.id);
    expect(preview.mode).toBe("children");
    const problems = (preview as { problems: string[] }).problems.join("\n");
    for (const p of ["両方あります", "キーが重なっています: C1", "題がありません", "「## 目的」がありません", "「## 完了条件」がありません", "C9 という子の案はありません", "T005 は親のタスクにありません"]) {
      expect(problems).toContain(p);
    }
    await expect(ctx.preflight.adopt(parent.id, r.id)).rejects.toThrow("問題がある");
    expect(ctx.ws.requests.list()).toHaveLength(1);
  });
});

describe("子の案の採用", () => {
  it("選んだ案ごとに下書きの子を作り、管理情報を写し、親の目的を本文に固定する。親は進行中にし、親のタスクは変えない", async () => {
    const { ctx, parent, run } = await setup(9);
    await newTask(ctx, parent.id, { title: "既存の作業", status: "doing" });
    const r = await run();
    await ctx.preflight.updateChild(parent.id, r.id, "C3", { include: false });
    const result = await ctx.preflight.adopt(parent.id, r.id, "human:test");
    expect(result.failed).toEqual([]);
    expect(result.created.map((c) => c.key)).toEqual(["C1", "C2"]);
    const [c1, c2] = result.created.map((c) => ctx.ws.requests.require(c.id));
    expect(c1).toMatchObject({ status: "draft", parent: parent.id, splitFrom: `${r.id}/C1`, milestone: "v1", tags: ["big"], due: "2026-12-01", title: expect.stringContaining("項目1") });
    expect(c1.workstreams).toBeUndefined();
    expect(c1.body).toContain("## 親の目的");
    expect(c1.body).toContain("> - 項目9");
    expect(c2.body).toContain(`- C1 → ${c1.id}`);
    // 子のタスク化・Preflight はしない
    expect(ctx.ws.tasksOf(c1.id).list()).toEqual([]);
    expect(c1.lastPreflight).toBeUndefined();
    expect(ctx.ws.requests.require(parent.id).status).toBe("active");
    expect(ctx.ws.tasksOf(parent.id).list().map((t) => [t.title, t.status])).toEqual([["既存の作業", "doing"]]);
    // 済んだ採用はやり直さない
    await expect(ctx.preflight.adopt(parent.id, r.id)).rejects.toThrow("既に採用済み");
    const shown = await ctx.preflight.get(parent.id, r.id);
    expect(shown?.adoption).toMatchObject({ done: true, created: ["C1", "C2"] });
  });

  it("親の題・本文が変わった・別の run から採用した・子を足したなら何も書かずに断る", async () => {
    const { ctx, parent, run } = await setup(6);
    const r1 = await run();
    await updateRequest(ctx, parent.id, { body: `${bullets(6)}\n- 追加` });
    const stale = await ctx.preflight.adopt(parent.id, r1.id).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(StaleInputError);
    expect((stale as StaleInputError).match.changed).toEqual(["body"]);
    await updateRequest(ctx, parent.id, { body: bullets(6) });
    // 別の run から採用した
    const r2 = await run();
    await ctx.preflight.adopt(parent.id, r2.id);
    const other = await ctx.preflight.adopt(parent.id, r1.id).catch((e: unknown) => e);
    expect((other as StaleInputError).match.changed).toEqual(["children"]);
    expect(ctx.ws.requests.list().filter((x) => x.parent === parent.id)).toHaveLength(2);
    // 手で子を足した後の run の採用も断る
    const r3 = await run();
    await createRequest(ctx, { title: "手で足した子", parent: parent.id });
    expect(((await ctx.preflight.adopt(parent.id, r3.id).catch((e: unknown) => e)) as StaleInputError).match.changed).toEqual(["children"]);
  });

  it("確認したときの版と違えば断る（drafts_changed）", async () => {
    const { ctx, parent, run } = await setup(6);
    const r = await run();
    const preview = (await ctx.preflight.previewMaterialize(parent.id, r.id)) as { version: string };
    await ctx.preflight.updateChild(parent.id, r.id, "C1", { title: "直した題" });
    await expect(ctx.preflight.adopt(parent.id, r.id, "x", { version: preview.version })).rejects.toBeInstanceOf(ChildDraftsChangedError);
    expect(ctx.ws.requests.list()).toHaveLength(1);
  });

  it("同時に頼んでも子は1回だけ作る", async () => {
    const { ctx, parent, run } = await setup(6);
    const r = await run();
    const results = await Promise.allSettled([ctx.preflight.adopt(parent.id, r.id), ctx.preflight.adopt(parent.id, r.id)]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(ctx.ws.requests.list().filter((x) => x.parent === parent.id)).toHaveLength(2);
  });

  it("子を作った直後に落ちても、やり直すと同じ ID を使い、作り直さない", async () => {
    const { ctx, parent, run } = await setup(6);
    const r = await run();
    const save = ctx.ws.preflight.save.bind(ctx.ws.preflight);
    let calls = 0;
    // 1回目の save は ID の予約、2回目（C1 を作った後の記録）で落ちる
    const spy = vi.spyOn(ctx.ws.preflight, "save").mockImplementation(async (x) => {
      if (++calls === 2) throw new Error("ディスクがいっぱい");
      return save(x);
    });
    const first = await ctx.preflight.adopt(parent.id, r.id);
    expect(first.failed).toEqual([{ key: "C1", error: "ディスクがいっぱい", code: "error" }]);
    expect(first.pending).toEqual(["C2"]);
    spy.mockRestore();
    const reserved = (await ctx.preflight.get(parent.id, r.id))!.adoption!.reserved;
    expect(ctx.ws.requests.get(reserved.C1)).toBeDefined();
    const again = await ctx.preflight.adopt(parent.id, r.id);
    expect(again).toMatchObject({ failed: [], pending: [], created: [{ key: "C1", id: reserved.C1 }, { key: "C2", id: reserved.C2 }] });
    expect(ctx.ws.requests.list().filter((x) => x.parent === parent.id)).toHaveLength(2);
  });

  it("予約した ID に別の要望があれば上書きせず競合で止め、作った子は消さない", async () => {
    const { ctx, parent, run, dataDir } = await setup(6);
    const r = await run();
    const save = ctx.ws.preflight.save.bind(ctx.ws.preflight);
    let calls = 0;
    const spy = vi.spyOn(ctx.ws.preflight, "save").mockImplementation(async (x) => {
      if (++calls === 2) throw new Error("落ちた"); // C1 を作った後の記録で落ちる
      return save(x);
    });
    await ctx.preflight.adopt(parent.id, r.id);
    spy.mockRestore();
    const reserved = (await ctx.preflight.get(parent.id, r.id))!.adoption!.reserved;
    // 予約した C2 の ID に、外で別の要望ができた
    const file = join(dataDir, "requests", reserved.C2, "request.md");
    mkdirSync(join(dataDir, "requests", reserved.C2), { recursive: true });
    writeFileSync(file, stringifyFrontmatter({ id: reserved.C2, title: "別の要望", status: "draft" }, "外で書いた"));
    const again = await ctx.preflight.adopt(parent.id, r.id);
    expect(again.created.map((c) => c.key)).toEqual(["C1"]);
    expect(again.failed).toEqual([expect.objectContaining({ key: "C2", code: "conflict" })]);
    expect(readFileSync(file, "utf8")).toContain("外で書いた");
    expect(ctx.ws.requests.get(reserved.C1)?.parent).toBe(parent.id);
    rmSync(file);
  });

  it("子の Preflight は親の目的を固定し、親の題・本文が変わったら子のタスク化を断る", async () => {
    const { ctx, parent, run } = await setup(6);
    const r = await run();
    const { created } = await ctx.preflight.adopt(parent.id, r.id);
    const child = created[0].id;
    await updateRequest(ctx, child, { body: "- 子の作業A\n- 子の作業B" });
    const cr = await run(child);
    expect(cr.input?.parent).toEqual({ id: parent.id, hash: expect.any(String) });
    expect(cr.drafts).toHaveLength(2);
    await updateRequest(ctx, parent.id, { title: "親の題を変えた" });
    const stale = await ctx.preflight.materialize(child, cr.id).catch((e: unknown) => e);
    expect((stale as StaleInputError).match.changed).toEqual(["parent"]);
    await updateRequest(ctx, parent.id, { title: "大きい要望" });
    const done = await ctx.preflight.materialize(child, cr.id);
    expect(done.tasks).toHaveLength(2);
    // 子のブランチは子のタスク化で、子の ID から割り当てる
    expect(ctx.ws.requests.require(child).workstreams?.main.branch).toContain(child);
  });

  it("再評価には前回の子の案を引き継ぐ", async () => {
    const { ctx, parent, run, runDir } = await setup(6);
    await run();
    await ctx.preflight.addNote(parent.id, "C2 は不要");
    const r2 = await run();
    const carry = readFileSync(join(runDir(r2.id), "carryover.md"), "utf8");
    expect(carry).toContain("## 前回の子の要望の案");
    expect(carry).toContain("### C1");
  });
});

describe("API", () => {
  it("確認で子の案の版を返し、子の案を直し、materialize で子を作る", async () => {
    const { ctx, parent, run } = await setup(6);
    const r = await run();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const base = `/requests/${parent.id}/preflight/${r.id}`;
    const preview = await call("GET", `${base}/materialize`);
    expect(preview.body).toMatchObject({ mode: "children", include: ["C1", "C2"], inputMatch: { status: "same" } });
    const patched = await call("PATCH", `${base}/children/C2`, { include: false, expectedTitle: "違う題" });
    expect(patched).toMatchObject({ status: 409, body: { code: "rev_conflict" } });
    await call("PATCH", `${base}/children/C2`, { include: false });
    const old = await call("POST", `${base}/materialize`, { version: preview.body.version });
    expect(old).toMatchObject({ status: 409, body: { code: "drafts_changed" } });
    const fresh = await call("GET", `${base}/materialize`);
    const made = await call("POST", `${base}/materialize`, { version: fresh.body.version });
    expect(made.status).toBe(201);
    expect(made.body.created.map((c: { key: string }) => c.key)).toEqual(["C1"]);
    expect((await call("GET", `${base}`)).body.adoption).toMatchObject({ done: true });
  });
});
