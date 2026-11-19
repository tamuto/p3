// CLI を別のプロセスで動かして確かめる: p3 join（既にあるプロジェクトへの参加）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, p3, repo, withConfigHome, relativeFrom, snapshot } from "./cliHelpers.ts";
import { git, tempDir } from "./helpers.ts";
import { joinProject } from "../packages/p3/src/cli/project.ts";

describe("p3 join（既にあるプロジェクトへの参加）", () => {
  const cfgFile = (home: string) => join(home, "infodb-p3", "config.yaml");
  /** 共有されたプロジェクト（ほかの人が init したリポジトリ。AGENTS.md への追記とスキル入り） */
  async function shared(args: string[] = []) {
    const root = await repo();
    const r = p3(root, ["init", "--yes", "--agents", "--project", "app", "--repo-name", "app", ...args], {}, tempDir("p3-config-"));
    expect(r.code, r.err).toBe(0);
    return root;
  }

  it("既定はルートの .p3。サブフォルダ・追加の作業ツリーからでもルートの .p3 に参加し、データ・リポジトリのファイルを変えない", async () => {
    const root = await shared();
    // データ（.p3）はコミットしない（作業ツリーに写しができないように）
    git(root, "add", "-A", "--", ".", ":!.p3");
    git(root, "commit", "-qm", "init");
    const wt = join(tempDir("p3-wt-"), "topic");
    git(root, "worktree", "add", "-q", wt, "-b", "topic");
    for (const at of [join(root, "docs"), wt]) {
      const before = snapshot(root);
      const home = tempDir("p3-config-");
      const r = p3(at, ["join", "--yes", "--project", "app"], {}, home);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`参加しました: app → ${join(root, ".p3")}`);
      expect(r.out).toContain("参照先 app");
      expect(snapshot(root)).toEqual(before);
      expect(existsSync(join(at, ".p3"))).toBe(false);
      expect(p3(at, ["whoami", "--json"], {}, home).json()).toMatchObject({ project: "app", dataDir: join(root, ".p3"), via: "cwd" });
    }
  });

  it("外のフォルダ（相対は実行した場所から・絶対・~）に参加する。空の --dir は断る", async () => {
    const home = tempDir("p3-home-");
    const data = join(home, "p3-data", "app");
    const first = await repo();
    expect(p3(first, ["init", "--yes", "--project", "app", "--dir", data], { HOME: home }, tempDir("p3-config-")).code).toBe(0);
    const clone = await repo();
    await mkdir(join(clone, "src"));
    for (const [label, arg] of [["相対", relativeFrom(join(clone, "src"), data)], ["絶対", data], ["~", "~/p3-data/app"]]) {
      const cfg = tempDir("p3-config-");
      const r = p3(join(clone, "src"), ["join", "--yes", "--project", "app", "--dir", arg], { HOME: home }, cfg);
      expect(r.code, `${label}: ${r.err}`).toBe(0);
      expect(readFileSync(cfgFile(cfg), "utf8"), label).toContain(`dir: ${data}`);
    }
    const empty = p3(clone, ["join", "--yes", "--project", "app", "--dir", ""]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("--dir が空です");
    expect(existsSync(cfgFile(CONFIG_HOME))).toBe(false);
  });

  it("参照先: 名前が同じ → それ、1つだけ → それ、決まらない → 登録せず repo path を案内、--repo-name は共有の定義にある名前だけ", async () => {
    const data = join(tempDir("p3-assets-"), "shared");
    const first = await repo();
    expect(p3(first, ["init", "--yes", "--project", "s", "--dir", data, "--repo-name", "app"], {}, tempDir("p3-config-")).code).toBe(0);
    const clone = await repo();
    const ref = (home: string) => readFileSync(cfgFile(home), "utf8");
    // 1つだけ → それ（フォルダ名が違っても）
    let home = tempDir("p3-config-");
    expect(p3(clone, ["join", "--yes", "--project", "s", "--dir", data], {}, home).out).toContain(`参照先 app  ${clone}`);
    expect(ref(home)).toContain(`app: ${clone}`);
    // 複数（app・infra）で、名前が決まらない → 登録せず案内
    expect(p3(first, ["--dir", data, "repo", "add", "infra", "role=基盤"], {}, tempDir("p3-config-")).code).toBe(0);
    home = tempDir("p3-config-");
    const none = p3(clone, ["join", "--yes", "--project", "s", "--dir", data], {}, home);
    expect(none.code, none.err).toBe(0);
    expect(none.out).toContain(`p3 repo path <名前> ${clone}`);
    expect(ref(home)).not.toContain(clone);
    // 明示した名前
    home = tempDir("p3-config-");
    expect(p3(clone, ["join", "--yes", "--project", "s", "--dir", data, "--repo-name", "infra"], {}, home).code).toBe(0);
    expect(ref(home)).toContain(`infra: ${clone}`);
    home = tempDir("p3-config-");
    const bad = p3(clone, ["join", "--yes", "--project", "s", "--dir", data, "--repo-name", "nope"], {}, home);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("参照先「nope」は共有の定義にありません（あるもの: app, infra）");
    expect(existsSync(cfgFile(home))).toBe(false);
    // 参照先が無いプロジェクト
    const bare = join(tempDir("p3-assets-"), "bare");
    mkdirSync(join(bare, "requests"), { recursive: true });
    writeFileSync(join(bare, "project.yaml"), "name: bare\n");
    home = tempDir("p3-config-");
    const zero = p3(clone, ["join", "--yes", "--project", "bare", "--dir", bare], {}, home);
    expect(zero.code, zero.err).toBe(0);
    expect(zero.out).toContain("参照先として登録していません");
  });

  it("同じ名前で別のフォルダは断り、同じ参加はもう一度でも何も変えない。個人設定のほかの登録・項目は残す", async () => {
    const root = await shared();
    const otherData = join(tempDir("p3-assets-"), "other");
    expect(p3(await repo(), ["init", "--yes", "--project", "other", "--dir", otherData]).code).toBe(0);
    expect(p3(root, ["user-config", "set", "ui.theme=dark"]).code).toBe(0);
    expect(p3(root, ["join", "--yes", "--project", "app"]).code).toBe(0);
    const before = readFileSync(cfgFile(CONFIG_HOME), "utf8");
    expect(before).toContain("other:");
    expect(before).toContain("theme: dark");
    const again = p3(root, ["join", "--yes", "--project", "app"]);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("登録済みです: app");
    expect(readFileSync(cfgFile(CONFIG_HOME), "utf8")).toBe(before);
    const clash = p3(root, ["join", "--yes", "--project", "other"]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain(`プロジェクト名「other」は別のフォルダで登録済みです: ${otherData}`);
    expect(readFileSync(cfgFile(CONFIG_HOME), "utf8")).toBe(before);
  });

  it("参加先が無い・p3 のプロジェクトでない・project.yaml が壊れている・読めないときは、理由を出して何も作らず登録もしない", async () => {
    const root = await repo();
    const missing = join(tempDir("p3-assets-"), "missing");
    const plain = tempDir("p3-plain-");
    writeFileSync(join(plain, "memo.txt"), "x");
    const broken = tempDir("p3-broken-");
    writeFileSync(join(broken, "project.yaml"), "name: [\n");
    const list = tempDir("p3-list-");
    writeFileSync(join(list, "project.yaml"), "- a\n- b\n");
    const unreadable = tempDir("p3-dir-");
    mkdirSync(join(unreadable, "project.yaml"));
    const cases: [string, string, string][] = [
      ["無い", missing, `データのフォルダがありません: ${missing}`],
      ["project.yaml が無い", plain, "は p3 のプロジェクトではありません（project.yaml がありません）"],
      ["壊れた YAML", broken, "project.yaml を読めません（YAML として壊れています）"],
      ["設定ではない", list, "project.yaml の中身が p3 の設定ではありません"],
      ["読めない", unreadable, "project.yaml を読めません:"],
    ];
    for (const [label, dir, message] of cases) {
      const before = snapshot(dir === missing ? root : dir);
      const r = p3(root, ["join", "--yes", "--project", "x", "--dir", dir]);
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain(message);
      expect(snapshot(dir === missing ? root : dir), label).toEqual(before);
      expect(existsSync(cfgFile(CONFIG_HOME)), label).toBe(false);
    }
    expect(existsSync(missing)).toBe(false);
    // 既定の場所（ルートの .p3）が無いときも同じ。init にはならない
    const r = p3(root, ["join", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`データのフォルダがありません: ${join(root, ".p3")}`);
    expect(r.err).toContain("新しく作るなら p3 init");
    expect(existsSync(join(root, ".p3"))).toBe(false);
  });

  it("--agents（値の有無によらず）・作るときだけの項目・位置引数は、書き込む前に断る", async () => {
    const root = await shared();
    const before = snapshot(root);
    for (const args of [["--agents"], ["--agents", "claude"], ["--name", "x"], ["--description", "x"], ["--instructions", "x"], ["extra"]]) {
      const r = p3(root, ["join", "--yes", "--project", "app", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toMatch(/join (は|では)/);
    }
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(cfgFile(CONFIG_HOME))).toBe(false);
  });

  it("AI 向けのファイルを書かない・聞かない。消したスキルや指示の節は、AGENTS.md / CLAUDE.md の有無・対話でも戻らない", async () => {
    for (const layout of ["AGENTS.md", "CLAUDE.md", "なし"] as const) {
      const root = await shared();
      // チームで Codex 向けを消した・指示の節を消した
      rmSync(join(root, ".agents"), { recursive: true });
      rmSync(join(root, "AGENTS.md"));
      if (layout === "AGENTS.md") writeFileSync(join(root, "AGENTS.md"), "# rules\n");
      if (layout === "CLAUDE.md") writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
      const before = snapshot(root);
      // 非対話
      expect(p3(root, ["join", "--yes", "--project", "app"], {}, tempDir("p3-config-")).code, layout).toBe(0);
      expect(snapshot(root), layout).toEqual(before);
      // 対話（Enter だけ）。聞くのはプロジェクト名とフォルダだけ
      const questions: string[] = [];
      await withConfigHome(tempDir("p3-config-"), () => joinProject({ cwd: join(root, "docs"), prompt: async (q) => (questions.push(q), "") }));
      expect(questions.map((q) => q.split("（")[0]), layout).toEqual(["プロジェクト名", "参加するデータのフォルダ"]);
      expect(snapshot(root), layout).toEqual(before);
      expect(existsSync(join(root, ".agents")), layout).toBe(false);
    }
  });
});
