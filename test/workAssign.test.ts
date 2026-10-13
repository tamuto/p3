import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { writeRepoEntry } from "../src/core/store/projectFile.ts";
import { gitInit, makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

const def = { role: "", readFirst: false, map: [] };

/** 参照先: app・infra（git・作業先にできる）、docs（参照だけ）、notes（git でないフォルダ・作業先にできる）、guide と guide-sub（同じ git） */
async function setup() {
  const repo = await makeRepo();
  const infra = tempDir("infra-");
  gitInit(infra);
  const docs = tempDir("docs-");
  const notes = tempDir("notes-");
  const guide = tempDir("guide-");
  gitInit(guide);
  await mkdir(join(guide, "standard"));
  const file = join(repo.dataDir, "project.yaml");
  for (const [name, writable] of [["app", true], ["infra", true], ["docs", false], ["notes", true], ["guide", true], ["guide-sub", true]] as const) {
    await writeRepoEntry(file, name, { ...def, name, writable });
  }
  const ctx = await openTestProject(repo.dataDir, undefined, {
    repos: { app: repo.root, infra, docs, notes, guide, "guide-sub": join(guide, "standard") },
  });
  const app = apiRoutes(ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  /** Mock で評価して、案ごとに作業先と採否を決める */
  const evaluate = async (repos: (string | null)[], include?: boolean[]) => {
    const req = await newRequest(ctx, { title: "multi", status: "draft", body: repos.map((_, i) => `- 作業 ${i + 1}`).join("\n") });
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.preflight.wait(req.id, id);
    for (const [i, r] of repos.entries()) {
      const res = await call("PATCH", `/requests/${req.id}/preflight/${id}/drafts/D${i + 1}`, { repo: r, include: include?.[i] ?? true });
      expect(res.status).toBe(200);
    }
    return { rid: req.id, run: id };
  };
  return { ctx, call, evaluate, repo };
}

describe("タスク化で作業先の分だけブランチを割り当てる", () => {
  it("2つのリポジトリ: 採用した案の作業先の分だけ割り当てる（不採用・作業先なしは除く）", async () => {
    const { ctx, evaluate } = await setup();
    const { rid, run } = await evaluate(["app", "infra", null, "notes"], [true, true, true, false]);
    const { tasks } = await ctx.preflight.materialize(rid, run);
    expect(tasks.map((t) => [t.title, t.repo])).toEqual([
      ["作業 1", "app"],
      ["作業 2", "infra"],
      ["作業 3", null],
    ]);
    const r = ctx.ws.requests.require(rid);
    expect(Object.keys(r.workstreams ?? {})).toEqual(["app", "infra"]);
    expect(r.workstreams!.app).toEqual({ branch: `req/${rid}-multi` });
  });

  it("作業先なしだけならブランチは割り当てない。git でないフォルダは作業先を残してブランチなし", async () => {
    const { ctx, evaluate } = await setup();
    const a = await evaluate([null, null]);
    await ctx.preflight.materialize(a.rid, a.run);
    expect(ctx.ws.requests.require(a.rid).workstreams).toBeUndefined();
    const b = await evaluate(["notes"]);
    const { tasks } = await ctx.preflight.materialize(b.rid, b.run);
    expect(tasks[0].repo).toBe("notes");
    expect(ctx.ws.requests.require(b.rid).workstreams).toBeUndefined();
  });

  it("参照だけ・登録の無い名前は、案を変える前に断る。手で直した案もタスク化の前に断り、何も変えない", async () => {
    const { ctx, call, evaluate } = await setup();
    const { rid, run } = await evaluate(["app"]);
    for (const bad of ["docs", "nope"]) {
      const res = await call("PATCH", `/requests/${rid}/preflight/${run}/drafts/D1`, { repo: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/参照だけ|登録されていません/);
    }
    expect((await ctx.ws.preflight.get(rid, run))!.drafts[0].repo).toBe("app");
    // ファイルを手で直した
    const file = join(ctx.ws.preflight.runDir(rid, run), "drafts", "D1.md");
    await writeFile(file, (await readFile(file, "utf8")).replace(/^repo: app$/m, "repo: docs"));
    await expect(ctx.preflight.materialize(rid, run)).rejects.toThrow("参照だけ");
    expect(ctx.ws.tasksOf(rid).list()).toEqual([]);
    expect(ctx.ws.requests.require(rid).status).toBe("reviewed");
  });

  it("同じ git のリポジトリを指す2つの名前に割り当てる計画は、理由を添えて断る。サブフォルダは含む git を基準にする", async () => {
    const { ctx, evaluate } = await setup();
    const { rid, run } = await evaluate(["guide", "guide-sub"]);
    await expect(ctx.preflight.materialize(rid, run)).rejects.toThrow("同じ git のリポジトリです");
    expect(ctx.ws.tasksOf(rid).list()).toEqual([]);
    const one = await evaluate(["guide-sub"]);
    await ctx.preflight.materialize(one.rid, one.run);
    expect(ctx.ws.requests.require(one.rid).workstreams).toEqual({ "guide-sub": { branch: expect.any(String) } });
  });

  it("後から作業先を足す（タスクを足す・作業先を変える）と、足りない分だけ割り当て、既存の割当は変えない", async () => {
    const { ctx, call, evaluate } = await setup();
    const { rid, run } = await evaluate(["app"]);
    await ctx.preflight.materialize(rid, run);
    await ctx.ws.requests.update(rid, { workstreams: { app: { branch: "手で変えたブランチ" } } });
    const added = await call("POST", `/requests/${rid}/tasks`, { title: "基盤", repo: "infra" });
    expect(added.status).toBe(201);
    expect(added.body.repo).toBe("infra");
    expect(ctx.ws.requests.require(rid).workstreams).toEqual({
      app: { branch: "手で変えたブランチ" },
      infra: { branch: `req/${rid}-multi` },
    });
    expect((await call("POST", `/requests/${rid}/tasks`, { title: "x", repo: "docs" })).status).toBe(400);
    const t = added.body;
    expect((await call("PATCH", `/requests/${rid}/tasks/${t.id}`, { repo: null, rev: t.rev })).body.repo).toBeNull();
    expect((await call("PATCH", `/requests/${rid}/tasks/${t.id}`, { repo: "nope", rev: t.rev + 1 })).status).toBe(400);
  });

  it("途中で失敗しても、やり直しで同じ割当・同じタスクにする", async () => {
    const { ctx, evaluate } = await setup();
    const { rid, run } = await evaluate(["app", "infra"]);
    const col = ctx.ws.tasksOf(rid);
    const create = col.create.bind(col);
    let calls = 0;
    col.create = async (...args) => {
      if (++calls === 2) throw new Error("途中で失敗");
      return create(...args);
    };
    await expect(ctx.preflight.materialize(rid, run)).rejects.toThrow("途中で失敗");
    expect((await ctx.ws.preflight.get(rid, run))!.materialization!.workstreams!.add).toHaveProperty("infra");
    col.create = create;
    const { tasks } = await ctx.preflight.materialize(rid, run);
    expect(tasks.map((t) => t.id)).toEqual(["T001", "T002"]);
    expect(Object.keys(ctx.ws.requests.require(rid).workstreams!)).toEqual(["app", "infra"]);
  });
});
