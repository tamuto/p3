// CLI を別のプロセスで動かして確かめる: p3 init（データのフォルダの決め方・AI 向けの指示とスキル）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, p3, repo, snapshot } from "./cliHelpers.ts";
import { git, tempDir } from "./helpers.ts";
import { init } from "../packages/p3/src/cli/project.ts";

describe("p3 init", () => {
  it("指定したフォルダにデータを作り、リポジトリの中身から既定値を推測する", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const r = p3(join(root, "src"), ["init", "--yes", "--agents", "--dir", join(root, ".p3")]);
    expect(r.code, r.err).toBe(0);
    const yaml = readFileSync(join(root, ".p3", "project.yaml"), "utf8");
    expect(yaml).toContain(`name: ${root.split("/").at(-1)!.toLowerCase()}`);
    // このリポジトリを本体の参照先として登録する（名前はフォルダ名。このマシンのパスは個人設定）
    const refName = root.split("/").at(-1)!.toLowerCase();
    expect(yaml).toContain(`repos:\n  ${refName}:\n    role: 本体\n    readFirst: true\n    writable: true`);
    expect(yaml).not.toMatch(/^repo:|worktreeDir/m);
    expect(readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8")).toContain(`${refName}: ${root}`);
    // ドキュメントは本体（最初に読む）の主なフォルダ（フォルダの入口はその中の index.md）。プロジェクトの docs は無い
    expect(yaml).toContain("    map:\n      docs:\n        role: ドキュメント\n        entry: docs/index.md\n      README.md: ドキュメント\n      AGENTS.md: ドキュメント");
    expect(yaml).not.toMatch(/^docs:/m);
    expect(yaml).not.toContain("statuses"); // 列は固定なので書かない
    expect(existsSync(join(root, ".p3", "requests"))).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("タスク管理（infodb p3）");
    // 節は入口だけ（手順の本文は p3 guide から読ませる）
    expect(agents).toContain("pnpx @infodb/p3 guide --json");
    expect(agents).toContain("<!-- p3-entry-version: ");
    // サブフォルダから実行しても、スキルはリポジトリのルートに置く
    for (const t of [".claude", ".agents"]) {
      expect(existsSync(join(root, t, "skills", "p3", "SKILL.md"))).toBe(true);
      expect(existsSync(join(root, "src", t))).toBe(false);
    }
    // 2回目は拒む（未指定もルートの .p3 なので同じ）。参加は join
    for (const args of [["--dir", ".p3"], []]) {
      const again = p3(root, ["init", "--yes", ...args]);
      expect(again.code).toBe(1);
      expect(again.err).toContain("には既にプロジェクトがあります");
      expect(again.err).toContain("p3 join");
    }
  });
});

describe("p3 init のデータのフォルダ（既定はリポジトリのルートの .p3）", () => {
  const registered = (home = CONFIG_HOME) => readFileSync(join(home, "infodb-p3", "config.yaml"), "utf8");

  it("未指定ならサブフォルダから実行してもルートの .p3 に作り、個人設定も同じ絶対パスを指す", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const r = p3(join(root, "src"), ["init", "--yes", "--project", "app"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`作りました: app → ${join(root, ".p3")}`);
    expect(existsSync(join(root, ".p3", "project.yaml"))).toBe(true);
    expect(existsSync(join(root, ".p3", "requests"))).toBe(true);
    expect(existsSync(join(root, "src", ".p3"))).toBe(false);
    expect(registered()).toContain(`dir: ${join(root, ".p3")}`);
    // ルート・サブフォルダのどちらからも同じデータに決まる（今いる場所）
    for (const at of [root, join(root, "src")]) expect(p3(at, ["whoami", "--json"]).json()).toMatchObject({ dataDir: join(root, ".p3"), via: "cwd" });
  });

  it("追加の作業ツリーから未指定で実行しても、メインの作業ツリーの .p3 に作る", async () => {
    const root = await repo();
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    const wt = join(tempDir("p3-wt-"), "topic");
    git(root, "worktree", "add", "-q", wt, "-b", "topic");
    const r = p3(wt, ["init", "--yes", "--project", "app"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(root, ".p3", "project.yaml"))).toBe(true);
    expect(existsSync(join(wt, ".p3"))).toBe(false);
    expect(registered()).toContain(`dir: ${join(root, ".p3")}`);
    for (const at of [root, wt]) expect(p3(at, ["whoami", "--json"]).json()).toMatchObject({ dataDir: join(root, ".p3"), via: "cwd" });
  });

  it("git 管理外では実行した場所の .p3", () => {
    const dir = tempDir("p3-plain-");
    expect(p3(dir, ["init", "--yes", "--project", "plain"]).code).toBe(0);
    expect(existsSync(join(dir, ".p3", "project.yaml"))).toBe(true);
  });

  it("指定したフォルダ（相対は実行した場所から・絶対・~）を使い、既定の .p3 は作らない", async () => {
    const home = tempDir("p3-home-");
    const abs = join(tempDir("p3-ext-"), "abs");
    // [説明, --dir の値, できるはずの場所]。実行するのはサブフォルダ（src）
    const cases: [string, (root: string) => string, (root: string) => string][] = [
      ["相対", (root) => `../../${basename(root)}-data`, (root) => `${root}-data`],
      ["絶対", () => abs, () => abs],
      ["~", () => "~/p3-data/app", () => join(home, "p3-data", "app")],
    ];
    for (const [label, arg, expected] of cases) {
      const root = await repo();
      await mkdir(join(root, "src"));
      const dirArg = arg(root);
      const configHome = tempDir("p3-config-");
      const r = p3(join(root, "src"), ["init", "--yes", "--project", "app", "--dir", dirArg], { HOME: home }, configHome);
      expect(r.code, `${label}: ${r.err}`).toBe(0);
      expect(existsSync(join(expected(root), "project.yaml")), label).toBe(true);
      expect(existsSync(join(root, ".p3")), label).toBe(false);
      expect(registered(configHome), label).toContain(`dir: ${expected(root)}`);
    }
  });

  it("明示した空のフォルダは断り、何も作らない", async () => {
    const root = await repo();
    const r = p3(root, ["init", "--yes", "--project", "app", "--dir", ""]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--dir が空です");
    expect(existsSync(join(root, ".p3"))).toBe(false);
    expect(existsSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"))).toBe(false);
  });

  it("ルートの .p3 が既にあれば（clone して共有されたもの）init は何も変えずに断り、join を案内する", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--project", "app", "--description", "共有"]).code).toBe(0);
    const before = snapshot(root);
    const other = tempDir("p3-config-");
    for (const args of [[], ["--agents"]]) {
      const r = p3(join(root, "docs"), ["init", "--yes", "--project", "app", ...args], {}, other);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${join(root, ".p3")} には既にプロジェクトがあります`);
      expect(r.err).toContain("参加するなら: p3 join --project app");
      if (args.length) expect(r.err).toContain("p3 agents claude|codex|both");
    }
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(other, "infodb-p3", "config.yaml"))).toBe(false);
  });

  it("対話では既定値（ルートの .p3 の絶対パス）を示し、Enter でそれを選ぶ", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const questions: string[] = [];
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = CONFIG_HOME;
    const log = console.log;
    console.log = () => {};
    try {
      await init({ cwd: join(root, "src"), project: "app", prompt: async (q) => (questions.push(q), "") });
    } finally {
      console.log = log;
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
    expect(questions.find((q) => q.startsWith("データを置くフォルダ"))).toContain(`[${join(root, ".p3")}]`);
    // 聞くのは六つ: 名前・データのフォルダ・何のプロジェクトか・最初に読むドキュメント・観点・AI 向けの入口の置き先
    expect(questions.map((q) => q.split("（")[0])).toEqual(["プロジェクト名", "データを置くフォルダ", "何を作っているプロジェクトか", "最初に読むドキュメント", "Preflight で重視する観点・制約", "AI 向けの p3 の使い方"]);
    expect(existsSync(join(root, ".p3", "project.yaml"))).toBe(true);
    expect(existsSync(join(root, "src", ".p3"))).toBe(false);
    expect(registered()).toContain(`dir: ${join(root, ".p3")}`);
  });
});

describe("p3 init --agents（AI 向けの指示とスキル）", () => {
  const SKILL = fileURLToPath(new URL("../skills/p3/SKILL.md", import.meta.url));
  /** 置く場所（Claude Code・Codex）。中身は同じ原本 */
  const TARGETS = [".claude/skills/p3/SKILL.md", ".agents/skills/p3/SKILL.md"];
  const original = () => readFileSync(SKILL, "utf8");
  const expectPlaced = (root: string) => {
    for (const t of TARGETS) expect(readFileSync(join(root, t), "utf8"), t).toBe(original());
  };
  const put = async (root: string, t: string, text: string) => {
    await mkdir(dirname(join(root, t)), { recursive: true });
    writeFileSync(join(root, t), text);
  };

  it("新しく作るときに、AGENTS.md へ追記してスキルを2か所に置く。もう一度でも重ねない", async () => {
    const root = await repo();
    const r = p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("AI 向けのスキル（Claude Code）を .claude/skills/p3/SKILL.md に置きました");
    expect(r.out).toContain("AI 向けのスキル（Codex）を .agents/skills/p3/SKILL.md に置きました");
    expectPlaced(root);

    // もう一度 init --agents しても、作らず・置かず・重ねない
    const again = p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("p3 agents");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8").split("タスク管理（infodb p3）")).toHaveLength(2);
  });

  it("新しく作るときに手で直したスキルが既にあれば、上書きせずに案内する", async () => {
    const root = await repo();
    for (const t of TARGETS) await put(root, t, "# 自分で直したスキル\n");
    const r = p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]);
    expect(r.code, r.err).toBe(0);
    for (const t of TARGETS) {
      expect(r.out).toContain(`※ ${t}（`);
      expect(readFileSync(join(root, t), "utf8")).toBe("# 自分で直したスキル\n");
    }
    expect(r.out).toContain("上書きしません");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("タスク管理（infodb p3）");
  });

  // 片方だけが既にある（以前の版で .claude だけ置いた・手で直した）。もう片方は置き、ある方は変えない
  it.each([
    [TARGETS[0], TARGETS[1]],
    [TARGETS[1], TARGETS[0]],
  ])("%s だけがあるとき、%s を置く（同じ内容なら最新、違えば残して知らせる）", async (have, missing) => {
    for (const [text, message] of [
      [original(), `${have} は最新です`],
      ["# 自分で直したスキル\n", `※ ${have}（`],
    ]) {
      const root = await repo();
      await put(root, have, text);
      const r = p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(message);
      expect(r.out).toContain(`を ${missing} に置きました`);
      expect(readFileSync(join(root, have), "utf8")).toBe(text);
      expect(readFileSync(join(root, missing), "utf8")).toBe(original());
    }
  });

  it("登録済みのリポジトリで init --agents しても置かず（p3 agents を案内）、登録・データ・リポジトリを変えない。名前が別のフォルダなら拒む", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--project", "app", "--dir", ".p3"]).code).toBe(0);
    const cfgFile = join(CONFIG_HOME, "infodb-p3", "config.yaml");
    const before = { files: snapshot(root), cfg: readFileSync(cfgFile, "utf8") };
    mkdirSync(join(root, "src"));
    const r = p3(join(root, "src"), ["init", "--yes", "--agents", "--project", "app", "--dir", "../.p3"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("AI 向けの使い方を置く・最新にするなら: p3 agents claude|codex|both");
    rmSync(join(root, "src"), { recursive: true });
    expect(snapshot(root)).toEqual(before.files);
    expect(readFileSync(cfgFile, "utf8")).toBe(before.cfg);

    const other = join(tempDir("p3-assets-"), "other");
    const clash = p3(root, ["init", "--yes", "--agents", "--project", "app", "--dir", other]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("別のフォルダで登録済みです");
    expect(existsSync(other)).toBe(false);
  });

  it("CLAUDE.md だけがあっても AGENTS.md を作って書き、CLAUDE.md は変えない（--force でも）", async () => {
    const root = await repo();
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
    expect(p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]).code).toBe(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# claude\n");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("タスク管理（infodb p3）");
    expectPlaced(root);
    expect(p3(root, ["agents", "both", "--force"]).code).toBe(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# claude\n");
  });

  it("--agents が無ければ（非対話では）both を置く", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--dir", ".p3"]).code).toBe(0);
    expectPlaced(root);
  });
});
