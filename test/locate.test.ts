import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDataDir, resolveProject } from "../src/core/store/locate.ts";
import { readFile } from "node:fs/promises";
import { loadUserConfig, normalizeUserConfig, saveUserConfig, type UserConfig } from "../src/core/userConfig.ts";
import { git, makeRepo, tempDir } from "./helpers.ts";

const user = (projects: Record<string, { dir: string; repos?: Record<string, string> }> = {}): UserConfig => normalizeUserConfig({ projects });

describe("resolveProject（操作するプロジェクトを決める）", () => {
  it("--dir はデータのフォルダを直接指す。登録済みなら名前とリポジトリも付く", () => {
    expect(resolveProject({ cwd: "/somewhere", dir: "../data", user: user() })).toEqual({ dataDir: "/data", repos: {}, via: "dir" });
    const u = user({ p: { dir: "/data", repos: { main: "/repo" } } });
    expect(resolveProject({ cwd: "/", dir: "/data", user: u })).toMatchObject({ name: "p", repos: { main: "/repo" } });
  });

  it("--project は登録した名前。無ければ登録済みの一覧を添えて断る", () => {
    const u = user({ p3: { dir: "/mnt/assets/p3" }, other: { dir: "/somefolder/other" } });
    expect(resolveProject({ cwd: "/", project: "other", user: u })).toMatchObject({ name: "other", dataDir: "/somefolder/other", via: "project" });
    expect(() => resolveProject({ cwd: "/", project: "x", user: u })).toThrow(/p3 +\/mnt\/assets\/p3/);
  });

  it("今いる場所: 登録したリポジトリ（サブフォルダ・作業ツリー）かデータのフォルダの中ならそのプロジェクト", async () => {
    const { root } = await makeRepo();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const wt = join(tempDir(), "wt");
    git(root, "worktree", "add", "-q", wt, "-b", "req/x");
    const data = tempDir();
    const u = user({ a: { dir: data, repos: { main: root } }, b: { dir: tempDir() } });
    await mkdir(join(root, "src", "deep"), { recursive: true });
    expect(resolveProject({ cwd: join(root, "src", "deep"), user: u })).toMatchObject({ name: "a", repos: { main: root }, via: "cwd" });
    expect(resolveProject({ cwd: wt, user: u }).name).toBe("a");
    expect(resolveProject({ cwd: join(data), user: u }).name).toBe("a");
    // 名前の前方一致で取り違えない（/x/data と /x/data2）
    expect(() => resolveProject({ cwd: `${data}2`, user: u })).toThrow(/決まりません/);
  });

  it("登録が1つだけならどこからでもそれ。無ければ init を案内する", () => {
    expect(resolveProject({ cwd: tempDir(), user: user({ only: { dir: "/d" } }) })).toMatchObject({ name: "only", via: "only" });
    expect(() => resolveProject({ cwd: tempDir(), user: user() })).toThrow(/p3 init --project/);
  });

  it("同じ場所が複数のプロジェクトに登録されていたら選ばせる", () => {
    const repo = tempDir();
    const u = user({ a: { dir: "/a", repos: { main: repo } }, b: { dir: "/b", repos: { main: repo } } });
    expect(() => resolveProject({ cwd: repo, user: u })).toThrow(/複数のプロジェクト.*a, b/);
  });
});

describe("findDataDir（リポジトリの中の .p3/。以前の置き方）", () => {
  it("要望ごとの作業ツリーの中でも、メインの作業ツリーの .p3/ を使う（状態をブランチごとに分岐させない）", async () => {
    const { root, dataDir } = await makeRepo();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const wt = join(root, ".worktrees", "REQ-0001");
    git(root, "worktree", "add", "-q", wt, "-b", "req/REQ-0001");
    expect(findDataDir(wt)).toBe(dataDir);
    expect(resolveProject({ cwd: wt, user: user() })).toEqual({ dataDir, repos: {}, via: "legacy" });
  });

  it("git 管理外なら上へ辿って探し、無ければ undefined", async () => {
    const dir = tempDir();
    await mkdir(join(dir, ".p3"), { recursive: true });
    await writeFile(join(dir, ".p3", "project.yaml"), "name: x\n");
    await mkdir(join(dir, "a", "b"), { recursive: true });
    expect(findDataDir(join(dir, "a", "b"))).toBe(join(dir, ".p3"));
    expect(findDataDir(tempDir())).toBeUndefined();
  });
});

describe("個人設定", () => {
  it("名前 → フォルダ（文字列だけでも可）を読み、壊れた項目は捨てる", () => {
    const u = normalizeUserConfig({ projects: { p3: "/mnt/assets/p3", other: { dir: "/somefolder/other", repos: { main: "/w/o" } }, "bad name": { dir: "/x" }, nodir: {} }, ui: { theme: "dark" } });
    expect(u.projects).toEqual({ p3: { dir: "/mnt/assets/p3", repos: {} }, other: { dir: "/somefolder/other", repos: { main: "/w/o" } } });
    expect(u.ui.theme).toBe("dark");
  });

  it("書き戻しても人が書いたコメントは残る", async () => {
    const path = join(tempDir(), "config.yaml");
    await writeFile(path, "# 自分用のメモ\nprojects:\n  p3: /mnt/assets/p3 # タスク管理\n");
    const u = await loadUserConfig(path);
    u.projects.other = { dir: "/somefolder/other", repos: {} };
    await saveUserConfig(u, path);
    const text = await readFile(path, "utf8");
    expect(text).toContain("# 自分用のメモ");
    expect((await loadUserConfig(path)).projects).toMatchObject({ p3: { dir: "/mnt/assets/p3" }, other: { dir: "/somefolder/other" } });
  });
});
