import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDataDir, resolveProject } from "../packages/tasks/src/core/store/locate.ts";
import { loadUserConfig, normalizeUserConfig, saveUserConfig, type UserConfig } from "../packages/tasks/src/core/userConfig.ts";
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

describe("resolveProject: 同じ場所が複数のプロジェクトに当たったとき（データのフォルダ → 本体 → ほかの参照先）", () => {
  /** 共有の定義（project.yaml）の参照先と役割を書いたデータのフォルダ */
  async function dataWith(repos: Record<string, string>, dir = tempDir()) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project.yaml"), `name: x\nrepos:\n${Object.entries(repos).map(([n, r]) => `  ${n}:\n    role: ${r}\n`).join("")}`);
    return dir;
  }

  it("A を本体にする PA を、A を参照先にする PB より優先する（ルート・サブフォルダ・外の作業ツリー）。PB は alsoReferencedBy に出る", async () => {
    const { root } = await makeRepo();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const wt = join(tempDir(), "wt");
    git(root, "worktree", "add", "-q", wt, "-b", "req/x");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(wt, "src"), { recursive: true });
    const u = user({
      pb: { dir: await dataWith({ b: "本体", a: "使う側" }), repos: { b: tempDir(), a: root } },
      pa: { dir: await dataWith({ a: "本体" }), repos: { a: root } },
    });
    for (const cwd of [root, join(root, "src"), wt, join(wt, "src")]) {
      expect(resolveProject({ cwd, user: u }), cwd).toMatchObject({ name: "pa", via: "cwd", alsoReferencedBy: ["pb"] });
    }
    // 明示したときも、ほかの登録を添える
    expect(resolveProject({ cwd: root, project: "pb", user: u })).toMatchObject({ name: "pb", via: "project", alsoReferencedBy: ["pa"] });
  });

  it("データのフォルダの中なら、ほかのプロジェクトの本体・参照先と重なってもそのプロジェクト", async () => {
    const repo = tempDir();
    const pbData = await dataWith({ b: "本体" }, join(repo, ".pb"));
    const u = user({ pa: { dir: await dataWith({ a: "本体" }), repos: { a: repo } }, pb: { dir: pbData, repos: { b: tempDir() } } });
    expect(resolveProject({ cwd: pbData, user: u })).toMatchObject({ name: "pb", via: "cwd", alsoReferencedBy: ["pa"] });
  });

  it("決まらなければ止める: データのフォルダが複数・本体が複数・本体が無く参照先が複数・共有の定義が無い・壊れている", async () => {
    const repo = tempDir();
    const outer = await dataWith({}, join(repo, "d"));
    const nested = await dataWith({}, join(outer, "e"));
    expect(() => resolveProject({ cwd: nested, user: user({ x: { dir: outer }, y: { dir: nested } }) })).toThrow(/複数のプロジェクトに登録されています: x, y[\s\S]*--project/);

    const twoMains = user({ x: { dir: await dataWith({ a: "本体" }), repos: { a: repo } }, y: { dir: await dataWith({ m: "本体" }), repos: { m: repo } } });
    expect(() => resolveProject({ cwd: repo, user: twoMains })).toThrow(/x, y/);

    const noMain = user({ x: { dir: await dataWith({ a: "使う側" }), repos: { a: repo } }, y: { dir: await dataWith({ a: "参考" }), repos: { a: repo } } });
    expect(() => resolveProject({ cwd: repo, user: noMain })).toThrow(/x, y/);

    // 「本体」に完全一致しない役割は本体と扱わない
    const near = user({ x: { dir: await dataWith({ a: "本体のドキュメント" }), repos: { a: repo } }, y: { dir: await dataWith({ a: "使う側" }), repos: { a: repo } } });
    expect(() => resolveProject({ cwd: repo, user: near })).toThrow(/x, y/);

    const broken = tempDir();
    await writeFile(join(broken, "project.yaml"), "repos: [\n");
    for (const dir of [tempDir(), broken]) {
      const u = user({ x: { dir: await dataWith({ a: "本体" }), repos: { a: repo } }, y: { dir, repos: { a: repo } } });
      expect(() => resolveProject({ cwd: repo, user: u })).toThrow(/x, y[\s\S]*本体かを確かめられません: y の project.yaml/);
    }
  });

  it("参照先として1つだけに当たるなら、共有の定義を読まずにそれ（今までどおり）", () => {
    const repo = tempDir();
    const u = user({ x: { dir: "/no/such", repos: { a: repo } }, y: { dir: "/other", repos: { b: tempDir() } } });
    expect(resolveProject({ cwd: repo, user: u })).toEqual({ name: "x", dataDir: "/no/such", repos: { a: repo }, via: "cwd" });
  });
});

describe("findDataDir（個人設定に登録していないリポジトリの中の .p3/）", () => {
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
