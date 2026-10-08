import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { locateDataDir } from "../src/server/store/locate.ts";
import { git, makeRepo, tempDir } from "./helpers.ts";

describe("locateDataDir", () => {
  it("明示された場所（--dir / PCUBE_DATA_DIR）を最優先する", () => {
    expect(locateDataDir("/somewhere", "../data")).toBe("/data");
  });

  it("サブディレクトリから実行しても、リポジトリのルートの .pcube/ を見つける", async () => {
    const { root, dataDir } = await makeRepo();
    await mkdir(join(root, "src", "deep"), { recursive: true });
    expect(locateDataDir(join(root, "src", "deep"), undefined)).toBe(dataDir);
  });

  it("要望ごとの作業ツリーの中でも、メインの作業ツリーの .pcube/ を使う（状態をブランチごとに分岐させない）", async () => {
    const { root, dataDir } = await makeRepo();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const wt = join(root, ".worktrees", "REQ-0001");
    git(root, "worktree", "add", "-q", wt, "-b", "req/REQ-0001");
    // 作業ツリーにも .pcube/ の写しがあるが、そちらではない
    expect(locateDataDir(wt, undefined)).toBe(dataDir);
  });

  it("git 管理外なら上へ辿って探し、無ければ undefined", async () => {
    const dir = tempDir();
    await mkdir(join(dir, ".pcube"), { recursive: true });
    await writeFile(join(dir, ".pcube", "project.yaml"), "name: x\n");
    await mkdir(join(dir, "a", "b"), { recursive: true });
    expect(locateDataDir(join(dir, "a", "b"), undefined)).toBe(join(dir, ".pcube"));
    expect(locateDataDir(tempDir(), undefined)).toBeUndefined();
  });
});
