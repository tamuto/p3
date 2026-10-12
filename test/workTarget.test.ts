import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRepoEntry } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { repoTargetProblem, requestWorkstreams, taskRepo, writableRepos } from "../src/shared/workTarget.ts";
import { makeRepo, newRequest, newTask, openTestProject } from "./helpers.ts";

const base = { role: "", readFirst: false, writable: false, map: [] };

describe("作業先とリポジトリごとのブランチ（データの形）", () => {
  it("作業先は作業先にできる参照先か作業先なし。ブランチは作業先ごと", () => {
    const multi = { repos: [{ ...base, name: "docs" }, { ...base, name: "app", writable: true }, { ...base, name: "infra", writable: true }] };
    expect(writableRepos(multi)).toEqual(["app", "infra"]);
    expect(taskRepo({ repo: "infra" })).toBe("infra");
    expect(taskRepo({ repo: null })).toBeUndefined();
    expect(requestWorkstreams({ workstreams: { infra: { branch: "req/a" } } })).toEqual({ infra: { branch: "req/a" } });
    expect(requestWorkstreams({})).toEqual({});
    expect(repoTargetProblem("docs", multi)).toContain("参照だけ");
    expect(repoTargetProblem("nope", multi)).toContain("登録されていません");
    expect(repoTargetProblem(null, multi)).toBeUndefined();
    expect(repoTargetProblem("app", multi)).toBeUndefined();
  });

  it("ファイルとの往復: 作業先なし（null）・任意の名前・複数の PR・作業先ごとのブランチを残す", async () => {
    const repo = await makeRepo();
    const file = join(repo.dataDir, "project.yaml");
    await writeRepoEntry(file, "ガイド", { ...base, name: "ガイド", writable: true });
    await writeRepoEntry(file, "app", { ...base, name: "app", writable: true });
    const ctx = await openTestProject(repo.dataDir);
    const r = await newRequest(ctx, { title: "要望" });
    const none = await newTask(ctx, r.id, { title: "調査", repo: null });
    const named = await newTask(ctx, r.id, {
      title: "ドキュメント",
      repo: "ガイド",
      repoOutputs: [
        { repo: "ガイド", output: "https://example.com/doc/pull/2" },
        { repo: "app", output: "https://example.com/app/pull/3" },
      ],
    });
    await ctx.ws.requests.update(r.id, { workstreams: { ガイド: { branch: "req/x" }, app: { branch: "req/x" } } });
    const text = await readFile(join(repo.dataDir, "requests", r.id, "tasks", `${none.id}.md`), "utf8");
    expect(text).toContain("repo: null");
    const fresh = new Workspace(repo.dataDir);
    await fresh.load();
    const col = fresh.tasksOf(r.id);
    expect(col.require(none.id).repo).toBeNull();
    expect(col.require(named.id)).toMatchObject({ repo: "ガイド", repoOutputs: [{ repo: "ガイド" }, { repo: "app" }] });
    expect(fresh.requests.require(r.id).workstreams).toEqual({ ガイド: { branch: "req/x" }, app: { branch: "req/x" } });
    // 更新しても項目を落とさない
    await col.update(named.id, { status: "doing" });
    const again = new Workspace(repo.dataDir);
    await again.load();
    expect(again.tasksOf(r.id).require(named.id).repoOutputs).toHaveLength(2);
  });

  it("タスク案の作業先: none・空・null は作業先なし、無いものは指定なし（タスク化では作業先なし）", async () => {
    const repo = await makeRepo();
    const ctx = await openTestProject(repo.dataDir);
    const r = await newRequest(ctx, { title: "要望", status: "draft" });
    const { id } = await ctx.preflight.start(r.id, { engine: "mock" });
    await ctx.preflight.wait(r.id, id);
    const dir = join(ctx.ws.preflight.runDir(r.id, id), "drafts");
    const d1 = join(dir, "D1.md");
    const t = await readFile(d1, "utf8");
    for (const [v, expected] of [["none", null], ['""', null], ["null", null], ["app", "app"]] as const) {
      await writeFile(d1, t.replace(/^repo: main$/m, `repo: ${v}`));
      expect((await ctx.ws.preflight.loadDrafts(r.id, id)).find((d) => d.key === "D1")!.repo).toBe(expected);
    }
    await writeFile(d1, t.replace(/^repo: main\n/m, ""));
    expect("repo" in (await ctx.ws.preflight.loadDrafts(r.id, id)).find((d) => d.key === "D1")!).toBe(false);
  });
});

describe("画面の作業先の選択肢と成果物の表示", () => {
  it("作業先にできるものと「作業先なし」。今の値が選べないものでも黙って置き換えずに残す", async () => {
    const { repoChoices } = await import("../src/shared/workTarget.ts");
    const p = { repos: [{ ...base, name: "app", writable: true }, { ...base, name: "lib" }] };
    expect(repoChoices(p, "app").map((c) => c.value)).toEqual(["app", ""]);
    expect(repoChoices(p, null).map((c) => c.label)).toEqual(["app", "作業先なし"]);
    expect(repoChoices(p, "lib")[0]).toEqual({ value: "lib", label: "lib（作業先にできません）", invalid: true });
    expect(repoChoices(p, "消えた名前")[0]).toMatchObject({ value: "消えた名前", invalid: true });
    expect(repoChoices({ repos: [] }, undefined).map((c) => c.value)).toEqual([""]);
  });

  it("リポジトリごとの成果物は、どのリポジトリのものかを付けて出す（URL はリンク）", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Outputs } = await import("../src/web/components/Outputs.tsx");
    const html = renderToStaticMarkup(createElement(Outputs, { outputs: ["メモ"], repoOutputs: [{ repo: "infra", output: "https://example.com/infra/pull/2" }] }));
    expect(html).toContain(">infra</span>");
    expect(html).toContain('href="https://example.com/infra/pull/2"');
    expect(html).toContain("メモ");
  });

  it("API: タスクの成果物の参照先も作業先にできるものだけ。値は往復で変わらない", async () => {
    const { apiRoutes } = await import("../src/server/api/routes.ts");
    const repo = await makeRepo();
    const file = join(repo.dataDir, "project.yaml");
    await writeRepoEntry(file, "app", { ...base, name: "app", writable: true });
    await writeRepoEntry(file, "lib", { ...base, name: "lib" });
    const ctx = await openTestProject(repo.dataDir, undefined, { repos: { app: repo.root } });
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const r = await newRequest(ctx, { title: "要望" });
    const made = await call("POST", `/requests/${r.id}/tasks`, { title: "t", repo: "app", repoOutputs: [{ repo: "app", output: "https://x/pull/1" }] });
    expect(made.status).toBe(201);
    expect(made.body.repoOutputs).toEqual([{ repo: "app", output: "https://x/pull/1" }]);
    expect((await call("PATCH", `/requests/${r.id}/tasks/${made.body.id}`, { repoOutputs: [{ repo: "lib", output: "x" }], rev: made.body.rev })).status).toBe(400);
    expect(ctx.ws.tasksOf(r.id).require(made.body.id).repoOutputs).toEqual([{ repo: "app", output: "https://x/pull/1" }]);
  });
});
