import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRepoEntry } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { primaryRepo, repoTargetProblem, requestWorkstreams, taskRepo, writableRepos } from "../src/shared/workTarget.ts";
import { makeRepo, newRequest, newTask, openTestProject } from "./helpers.ts";

const base = { role: "", readFirst: false, writable: false, map: [] };

describe("作業先とリポジトリごとのブランチ（データの形）", () => {
  it("以前のタスク・要望はそのまま読み、作業先は主リポジトリ、ブランチは主リポジトリの分", async () => {
    const legacy = { repos: [] };
    expect(primaryRepo(legacy)).toBe("main");
    expect(writableRepos(legacy)).toEqual(["main"]);
    expect(taskRepo({}, legacy)).toBe("main");
    expect(taskRepo({ repo: null }, legacy)).toBeUndefined();
    const multi = { repos: [{ ...base, name: "docs" }, { ...base, name: "allesc", writable: true }, { ...base, name: "infra", writable: true }] };
    expect(primaryRepo(multi)).toBe("allesc");
    expect(writableRepos(multi)).toEqual(["allesc", "infra"]);
    expect(taskRepo({}, multi)).toBe("allesc");
    expect(taskRepo({ repo: "infra" }, multi)).toBe("infra");
    expect(requestWorkstreams({ workstream: { branch: "req/a", worktree: ".worktrees/a" }, workstreams: { infra: { branch: "req/a", worktree: ".worktrees/a" } } }, multi)).toEqual({
      allesc: { branch: "req/a", worktree: ".worktrees/a" },
      infra: { branch: "req/a", worktree: ".worktrees/a" },
    });
    expect(repoTargetProblem("docs", multi)).toContain("参照だけ");
    expect(repoTargetProblem("nope", multi)).toContain("登録されていません");
    expect(repoTargetProblem(null, multi)).toBeUndefined();
    expect(repoTargetProblem("main", legacy)).toBeUndefined();
  });

  it("ファイルとの往復: 作業先なし（null）・任意の名前・複数の PR を残し、以前のファイルは更新しても項目を落とさない", async () => {
    const repo = await makeRepo();
    const file = join(repo.dataDir, "project.yaml");
    await writeRepoEntry(file, "標準ガイド", { ...base, name: "標準ガイド", writable: true });
    await writeRepoEntry(file, "allesc", { ...base, name: "allesc", writable: true });
    const ctx = await openTestProject(repo.dataDir);
    const r = await newRequest(ctx, { title: "要望" });
    // 以前のタスク（repo が無い）
    const old = await newTask(ctx, r.id, { title: "以前", outputs: ["https://example.com/pull/1"] });
    const none = await newTask(ctx, r.id, { title: "調査", repo: null });
    const named = await newTask(ctx, r.id, {
      title: "ドキュメント",
      repo: "標準ガイド",
      repoOutputs: [
        { repo: "標準ガイド", output: "https://example.com/doc/pull/2" },
        { repo: "allesc", output: "https://example.com/app/pull/3" },
      ],
    });
    await ctx.ws.requests.update(r.id, { workstream: { branch: "req/x", worktree: ".worktrees/x" }, workstreams: { 標準ガイド: { branch: "req/x", worktree: ".worktrees/x" } } });
    const text = await readFile(join(repo.dataDir, "requests", r.id, "tasks", `${none.id}.md`), "utf8");
    expect(text).toContain("repo: null");
    const fresh = new Workspace(repo.dataDir);
    await fresh.load();
    const col = fresh.tasksOf(r.id);
    expect("repo" in col.require(old.id)).toBe(false);
    expect(col.require(none.id).repo).toBeNull();
    expect(col.require(named.id)).toMatchObject({ repo: "標準ガイド", repoOutputs: [{ repo: "標準ガイド" }, { repo: "allesc" }] });
    expect(fresh.requests.require(r.id)).toMatchObject({ workstream: { branch: "req/x" }, workstreams: { 標準ガイド: { branch: "req/x" } } });
    // 以前のタスクを更新しても repo は付かない（主リポジトリのまま）、outputs も残る
    await col.update(old.id, { status: "doing" });
    const again = new Workspace(repo.dataDir);
    await again.load();
    expect("repo" in again.tasksOf(r.id).require(old.id)).toBe(false);
    expect(again.tasksOf(r.id).require(old.id).outputs).toEqual(["https://example.com/pull/1"]);
  });

  it("タスク案の作業先: none・空・null は作業先なし、無いものは指定なし", async () => {
    const repo = await makeRepo();
    const ctx = await openTestProject(repo.dataDir);
    const r = await newRequest(ctx, { title: "要望", status: "draft" });
    const { id } = await ctx.preflight.start(r.id, { engine: "mock" });
    await ctx.preflight.wait(r.id, id);
    const dir = join(ctx.ws.preflight.runDir(r.id, id), "drafts");
    const d1 = join(dir, "D1.md");
    const t = await readFile(d1, "utf8");
    for (const [v, expected] of [["none", null], ['""', null], ["null", null], ["allesc", "allesc"]] as const) {
      await writeFile(d1, t.replace(/^key: D1$/m, `key: D1\nrepo: ${v}`));
      expect((await ctx.ws.preflight.loadDrafts(r.id, id)).find((d) => d.key === "D1")!.repo).toBe(expected);
    }
    await writeFile(d1, t);
    expect("repo" in (await ctx.ws.preflight.loadDrafts(r.id, id)).find((d) => d.key === "D1")!).toBe(false);
  });
});
