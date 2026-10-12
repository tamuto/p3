import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mountNames, parseRepoPath, repoNameProblem } from "../src/shared/repos.ts";
import { normalizeProject, normalizeRepos } from "../src/server/store/normalize.ts";
import { writeProjectFile, writeRepoEntry } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { makeRepo } from "./helpers.ts";

describe("参照先の定義（project.yaml の repos）", () => {
  it("名前をキーにした対応と、name を持つ並びの両方を読む。主なフォルダは「パス: 役割」か { role, entry }", () => {
    const repos = normalizeRepos({
      app: { role: "システム本体", readFirst: true, writable: true, map: { "src/server": "API", "src/web": { role: "画面", entry: "src/web/main.tsx" } } },
      "ガイド": { role: "ドキュメント", mapFile: "MAP.md" },
      infra: "基盤",
    });
    expect(repos).toEqual([
      { name: "app", role: "システム本体", readFirst: true, writable: true, map: [{ path: "src/server", role: "API" }, { path: "src/web", role: "画面", entry: "src/web/main.tsx" }], mapFile: undefined },
      { name: "ガイド", role: "ドキュメント", readFirst: false, writable: false, map: [], mapFile: "MAP.md" },
      { name: "infra", role: "基盤", readFirst: false, writable: false, map: [], mapFile: undefined },
    ]);
    expect(normalizeRepos([{ name: "a", role: "x", map: [{ path: "src", role: "s" }] }, { name: "a" }, { name: "b:c" }, { name: "" }, { role: "名前なし" }]).map((r) => r.name)).toEqual(["a"]);
    expect(normalizeRepos(undefined)).toEqual([]);
    expect(normalizeRepos("文字列")).toEqual([]);
  });

  it("名前に使えない文字・予約名", () => {
    expect(repoNameProblem("docsrepo")).toBeUndefined();
    expect(repoNameProblem("ガイド")).toBeUndefined();
    for (const bad of ["", "a b", "a:b", "a/b", "a\\b", ".", ".."]) expect(repoNameProblem(bad)).toBeDefined();
  });

  it("コンテナの中の名前は論理名と分ける", () => {
    expect(mountNames(["app", "ガイド", "app-doc", "a b", "App", "...", "x", "x"])).toEqual(["app", "repo2", "app-doc", "a-b", "App", "repo6", "x", "x-2"]);
  });
});

describe("参照の書き方（<名前>:<パス>）", () => {
  const known = ["app", "docs", "infra"];
  it("名前つきは登録した名前のときだけ。名前なしは既定（先頭）の参照先", () => {
    expect(parseRepoPath("docs:guide/", known, "app")).toEqual({ ok: true, repo: "docs", path: "guide", qualified: true });
    expect(parseRepoPath("src/server", known, "app")).toEqual({ ok: true, repo: "app", path: "src/server", qualified: false });
    expect(parseRepoPath("./README.md", known, "app")).toEqual({ ok: true, repo: "app", path: "README.md", qualified: false });
    expect(parseRepoPath("infra:", known, "app")).toEqual({ ok: true, repo: "infra", path: "", qualified: true });
    expect(parseRepoPath("src/a:b", known, "app")).toMatchObject({ ok: true, repo: "app", path: "src/a:b" });
  });

  it("登録に無い名前・絶対パス・.. は読まない（別の参照先の同じパスにしない）", () => {
    expect(parseRepoPath("unknown:src", known, "app")).toMatchObject({ ok: false, reason: expect.stringContaining("unknown") });
    expect(parseRepoPath("/etc/passwd", known, "app")).toMatchObject({ ok: false });
    expect(parseRepoPath("docs:../secret", known, "app")).toMatchObject({ ok: false });
    expect(parseRepoPath("C:\\work\\x", known, "app")).toMatchObject({ ok: false });
    expect(parseRepoPath("src", [], undefined)).toMatchObject({ ok: false });
  });
});

describe("project.yaml への読み書き", () => {
  it("p3 repo の書き込みは1件だけを変え、コメント・ほかの項目・知らない項目を残す。設定の保存は repos を消さない", async () => {
    const { dataDir } = await makeRepo({ repos: [] });
    const file = join(dataDir, "project.yaml");
    await writeFile(file, `${await readFile(file, "utf8")}# 参照先\nrepos:\n  # 本体のリポジトリ\n  app:\n    role: システム本体\n    owner: team-a   # 知らない項目\n  legacy-list-ok: 基盤\n`);
    await writeRepoEntry(file, "app", { name: "app", role: "本体（更新）", readFirst: true, writable: true, map: [{ path: "src", role: "コード", entry: "src/main.ts" }] });
    await writeRepoEntry(file, "docs", { name: "docs", role: "ドキュメント", readFirst: false, writable: false, map: [], mapFile: "MAP.md" });
    await writeRepoEntry(file, "legacy-list-ok", null);
    const text = await readFile(file, "utf8");
    expect(text).toContain("# 本体のリポジトリ");
    expect(text).toContain("owner: team-a # 知らない項目");
    expect(text).not.toContain("legacy-list-ok");
    const ws = new Workspace(dataDir);
    await ws.load();
    expect(ws.project.repos.map((r) => [r.name, r.role, r.readFirst, r.map, r.mapFile])).toEqual([
      ["app", "本体（更新）", true, [{ path: "src", role: "コード", entry: "src/main.ts" }], undefined],
      ["docs", "ドキュメント", false, [], "MAP.md"],
    ]);
    // 画面・p3 config の保存（repos を知らない経路）でも消えない
    await ws.saveProject({ description: "説明を変えた" });
    const after = await readFile(file, "utf8");
    expect(after).toContain("owner: team-a");
    expect(normalizeProject((await import("yaml")).default.parse(after)).repos.map((r) => r.name)).toEqual(["app", "docs"]);
    await writeProjectFile(file, { ...ws.project, repos: [] });
    expect(await readFile(file, "utf8")).toContain("app:");
  });

  it("repos が対応でない（並びで書かれた）ときは書き換えずにエラーにする", async () => {
    const { dataDir } = await makeRepo({ repos: [] });
    const file = join(dataDir, "project.yaml");
    await writeFile(file, `${await readFile(file, "utf8")}repos:\n  - name: a\n`);
    await expect(writeRepoEntry(file, "b", { name: "b", role: "", readFirst: false, writable: false, map: [] })).rejects.toThrow("対応で書いてください");
  });
});
