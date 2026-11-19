// CLI を別のプロセスで動かして確かめる: 作業先とリポジトリごとのブランチ・添付。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { p3, initialized } from "./cliHelpers.ts";
import { git, gitInit, tempDir } from "./helpers.ts";

describe("作業先とリポジトリごとのブランチ（CLI）", () => {
  /** app（このリポジトリ）と infra（別の git）。両方を作業先にし、Mock の案を2つのリポジトリに分けてタスク化する */
  async function twoRepos() {
    const { root, rid } = await initialized();
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const infra = tempDir("infra-");
    gitInit(infra);
    await mkdir(join(infra, "terraform"));
    writeFileSync(join(infra, "terraform", "main.tf"), "# tf\n");
    git(infra, "add", "-A");
    git(infra, "commit", "-qm", "init");
    expect(p3(root, ["repo", "add", "infra", infra, "role=基盤", "writable=true"]).code).toBe(0);
    expect(p3(root, ["repo", "add", "lib", tempDir("lib-"), "role=依存"]).code).toBe(0); // 参照だけ
    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    const runDir = join(root, ".p3", "requests", rid, "preflight");
    const run = readdirSync(runDir)[0];
    const d2 = join(runDir, run, "drafts", "D2.md");
    writeFileSync(d2, readFileSync(d2, "utf8").replace(/^repo: app$/m, "repo: infra"));
    const accepted = p3(root, ["accept", rid]);
    expect(accepted.code, accepted.err).toBe(0);
    return { root, rid, infra };
  }

  it("タスク化で作業先ごとにブランチを割り当て、どちらのリポジトリのブランチ（作業ツリー・サブフォルダ）からも今の要望を操作できる", async () => {
    const { root, rid, infra } = await twoRepos();
    const shown = p3(root, ["request", "show", rid, "--json"]).json();
    expect(Object.keys(shown.workstreams)).toEqual(["app", "infra"]);
    const branch = shown.workstreams.infra.branch;
    expect(p3(root, ["ls", "--req", rid, "--json"]).json().map((t: any) => t.repo)).toEqual(["app", "infra", "app"]);
    // 各リポジトリに要望の作業ツリーを作る（P3 は作らない。AI や人が作る）
    git(root, "worktree", "add", "-q", join(root, ".worktrees", rid), "-b", shown.workstreams.app.branch);
    git(infra, "worktree", "add", "-q", join(infra, ".worktrees", rid), "-b", branch);
    const infraTree = join(infra, ".worktrees", rid);
    for (const where of [join(root, ".worktrees", rid), infraTree, join(infraTree, "terraform")]) {
      const who = p3(where, ["whoami", "--json"]).json();
      expect(who.request).toBe(rid);
      expect(who.dataDir).toBe(join(root, ".p3")); // 同じデータのフォルダ
    }
    expect(p3(infraTree, ["whoami", "--json"]).json().here).toEqual(["infra"]);
    const made = p3(join(infraTree, "terraform"), ["new", "基盤の追加", "--repo", "infra", "--json"]).json();
    expect(made.ref.startsWith(`${rid}/`)).toBe(true);
    // detached HEAD ではブランチが無いので決めない（--req で指定する）
    git(infraTree, "checkout", "-q", "--detach");
    expect(p3(infraTree, ["whoami", "--json"]).json().request).toBeNull();
    expect(p3(infraTree, ["whoami", "--req", rid, "--json"]).json().request).toBe(rid);
    // 明示が先
    const other = p3(root, ["request", "new", "別の要望", "--json"]).json().id;
    expect(p3(infraTree, ["whoami", "--req", other, "--json"]).json().request).toBe(other);
  });

  it("別のリポジトリの同じ名前のブランチと取り違えない。パスに要望 ID が入っているだけでは決めない", async () => {
    const { root, rid, infra } = await twoRepos();
    const other = p3(root, ["request", "new", "別の要望", "--json"]).json().id;
    // 別の要望の app のブランチを、rid の infra のブランチと同じ名前にする
    const infraBranch = p3(root, ["request", "show", rid, "--json"]).json().workstreams.infra.branch;
    const otherFile = join(root, ".p3", "requests", other, "request.md");
    writeFileSync(otherFile, readFileSync(otherFile, "utf8").replace(/^---\n/, `---\nworkstreams:\n  app: { branch: "${infraBranch}", worktree: .worktrees/x }\n`));
    git(infra, "checkout", "-q", "-b", infraBranch);
    expect(p3(infra, ["whoami", "--json"]).json().request).toBe(rid);
    // 要望 ID の名前のフォルダ（作業ツリーではない）
    const fake = join(root, "notes", rid);
    await mkdir(fake, { recursive: true });
    git(root, "checkout", "-q", "-b", "unrelated");
    expect(p3(fake, ["whoami", "--json"]).json().request).toBeNull();
  });

  it("作業先の指定・外す・断る、作業先で絞る、リポジトリごとの成果物（以前の --output も使える）", async () => {
    const { root, rid } = await twoRepos();
    expect(p3(root, ["new", "x", "--req", rid, "--repo", "lib"]).err).toContain("参照だけ");
    expect(p3(root, ["new", "x", "--req", rid, "--repo", "nope"]).err).toContain("登録されていません");
    const none = p3(root, ["new", "調査", "--req", rid, "--repo", "none", "--json"]).json();
    expect(none.repo).toBeNull();
    expect(p3(root, ["set", none.id, "--req", rid, "repo=infra"]).code).toBe(0);
    expect(p3(root, ["set", none.id, "--req", rid, "repo=none"]).code).toBe(0);
    expect(p3(root, ["show", none.id, "--req", rid, "--json"]).json().item.repo).toBeNull();
    expect(p3(root, ["set", none.id, "--req", rid, "repo=lib"]).code).not.toBe(0);
    expect(p3(root, ["ls", "--req", rid, "--repo", "infra", "--json"]).json().map((t: any) => t.repo)).toEqual(["infra"]);
    expect(p3(root, ["ls", "--req", rid, "--repo", "none", "--json"]).json().map((t: any) => t.id)).toEqual([none.id]);
    expect(p3(root, ["ls", "--all", "--repo", "app", "--json"]).json().length).toBe(2);
    expect(p3(root, ["ls", "--req", rid, "--repo", "zzz"]).err).toContain("登録されていません");
    const text = p3(root, ["ls", "--req", rid]).out;
    expect(text).toMatch(/T002\s+todo\s+infra/);

    // 最後のタスクに、関係するリポジトリの PR を全部残す
    const last = p3(root, ["move", "T003", "done", "--req", rid, "--repo-output", "app=https://example.com/app/pull/1", "--repo-output", "infra=https://example.com/infra/pull/2", "--output", "設計メモ docs/x.md"]);
    expect(last.code, last.err).toBe(0);
    const t3 = p3(root, ["show", "T003", "--req", rid, "--json"]).json().item;
    expect(t3.repoOutputs).toEqual([
      { repo: "app", output: "https://example.com/app/pull/1" },
      { repo: "infra", output: "https://example.com/infra/pull/2" },
    ]);
    expect(t3.outputs).toEqual(["設計メモ docs/x.md"]);
    expect(p3(root, ["move", "T003", "done", "--req", rid, "--repo-output", "lib=x"]).err).toContain("参照だけ");
    expect(p3(root, ["move", "T003", "done", "--req", rid, "--repo-output", "noequal"]).err).toContain("<参照先の名前>=<成果物>");
    const brief = p3(root, ["show", "T002", "--req", rid, "--brief"]).out;
    expect(brief).toMatch(/作業先 {2}infra {2}branch req\//);
    const briefJson = p3(root, ["show", "T003", "--req", rid, "--brief", "--json"]).json();
    expect(briefJson.item.repoOutputs).toHaveLength(2);
    expect(p3(root, ["show", "T003", "--req", rid, "--brief"]).out).toContain("成果物  infra: https://example.com/infra/pull/2");
    const req = p3(root, ["request", "show", rid, "--brief"]).out;
    expect(req).toMatch(/branch {2}app: req\//);
    expect(req).toMatch(/branch {2}infra: req\//);
    expect(p3(root, ["set", "T003", "--req", rid, "repoOutputs="]).code).toBe(0);
    expect(p3(root, ["show", "T003", "--req", rid, "--json"]).json().item.repoOutputs).toBeUndefined(); // 空の配列はファイルに書かない
    expect(p3(root, ["drafts", rid]).out).toMatch(/D2\s+infra/);
  });
});

describe("p3 request new --attach", () => {
  it("作るときに添付する。どれかがだめなら要望を作らない", async () => {
    const { root } = await initialized();
    const { png } = await import("./imageFixture.ts");
    const { makeXlsx } = await import("./zipFixture.ts");
    writeFileSync(join(root, "今の画面.png"), png(640, 480));
    writeFileSync(join(root, "仕様.xlsx"), makeXlsx());
    writeFileSync(join(root, "偽物.png"), "<html>");
    const before = p3(root, ["request", "ls", "--json"]).json().length;
    const bad = p3(root, ["request", "new", "添付つき", "--attach", "今の画面.png", "--attach", "偽物.png"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("偽物.png: PNG / JPEG として読めません（要望は作っていません）");
    expect(p3(root, ["request", "new", "添付つき", "--attach", "無い.png"]).err).toContain("ファイルが読めません: 無い.png");
    expect(p3(root, ["request", "ls", "--json"]).json().length).toBe(before);

    const made = p3(root, ["request", "new", "添付つき", "--attach", "今の画面.png", "--attach", "仕様.xlsx", "--json"]);
    expect(made.code, made.err).toBe(0);
    const r = made.json();
    expect(r.attachments.map((a: { name: string; format: string }) => [a.name, a.format])).toEqual([
      ["今の画面.png", "png"],
      ["仕様.xlsx", "xlsx"],
    ]);
    expect(r.failedAttachments).toBeUndefined();
    const ls = p3(root, ["attach", "--req", r.id]);
    expect(ls.out).toContain("今の画面.png");
    expect(ls.out).toContain("仕様.xlsx");
    const text = p3(root, ["request", "new", "添付つき2", "--attach", "今の画面.png"]);
    expect(text.out).toMatch(/添付: A-\d{8}-\d{6}-[0-9a-f]{4}  今の画面.png/);
  });
});

describe("p3 attach", () => {
  it("serve なしで添付を足し・一覧し・書き出し・外す。不正な形式は使い方の誤り", async () => {
    const { root, rid } = await initialized();
    const { png } = await import("./imageFixture.ts");
    writeFileSync(join(root, "今の画面.png"), png(640, 480));
    writeFileSync(join(root, "偽物.png"), "<html>");
    const added = p3(root, ["attach", "add", "今の画面.png", "--description", "今の一覧", "--source", "利用者", "--req", rid, "--json"]);
    expect(added.code, added.err).toBe(0);
    const a = added.json();
    expect(a).toMatchObject({ name: "今の画面.png", format: "png", description: "今の一覧", source: "利用者" });
    const ls = p3(root, ["attach", "--req", rid]);
    expect(ls.out).toContain(a.id);
    expect(ls.out).toContain("次の Preflight を始めるときに");
    const bad = p3(root, ["attach", "add", "偽物.png", "--req", rid]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("PNG / JPEG として読めません");
    const got = p3(root, ["attach", "get", a.id, "--out", "out.png", "--req", rid]);
    expect(got.code, got.err).toBe(0);
    expect(readFileSync(join(root, "out.png"))).toEqual(png(640, 480));
    expect(p3(root, ["attach", "get", a.id, "--out", "out.png", "--req", rid]).code).toBe(1);
    expect(p3(root, ["attach", "rm", a.id, "--req", rid]).code).toBe(0);
    expect(p3(root, ["attach", "--req", rid]).out).toContain("添付はありません");
  });
});
