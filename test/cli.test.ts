import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { git, gitInit, tempDir } from "./helpers.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { init, joinProject } from "../src/cli/project.ts";

/** タスクの関係をファイルに書く（関係は Preflight のタスク化だけが張るので、CLI には張る操作が無い） */
function relate(root: string, rid: string, tid: string, relations: { type: string; target: string; note?: string; origin?: string }[]) {
  const file = join(root, ".p3", "requests", rid, "tasks", `${tid}.md`);
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  writeFileSync(file, stringifyFrontmatter({ ...data, relations: [...((data.relations as unknown[]) ?? []), ...relations.map((r) => ({ origin: "preflight", ...r }))] }, body));
}

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));

/** 個人設定（~/.config/infodb-p3）はテストごとに分ける */
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

/** CLI を別プロセスで動かす。このマシンの P3_* の環境変数（Codex の設定など）は効かないようにする */
function p3(cwd: string, args: string[], env: Record<string, string> = {}, configHome = CONFIG_HOME, input?: string) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...base, XDG_CONFIG_HOME: configHome, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

async function repo() {
  const root = tempDir("p3-cli-");
  gitInit(root);
  await mkdir(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.md"), "# docs\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  writeFileSync(join(root, "AGENTS.md"), "# rules\n");
  return root;
}

/** 初期化して要望を1つ作る */
async function initialized() {
  const root = await repo();
  const r = p3(root, ["init", "--yes", "--description", "在庫管理", "--dir", ".p3", "--repo-name", "app"]);
  expect(r.code, r.err).toBe(0);
  const req = p3(root, ["request", "new", "通知機能", "--body", "- 送信基盤\n- 設定画面\n- 再送", "--json"]).json();
  return { root, rid: req.id as string };
}

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
    expect(agents).toContain("status=resolved"); // 作業を終えたら対応済にする
    expect(agents).toContain("完了済（done）・見送り（rejected）とタスクの済み（check）は人が決める");
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
    expect(existsSync(join(root, ".p3", "project.yaml"))).toBe(true);
    expect(existsSync(join(root, "src", ".p3"))).toBe(false);
    expect(registered()).toContain(`dir: ${join(root, ".p3")}`);
  });
});

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

/** 個人設定の場所を変えて、この中で init / join を直接呼ぶ（対話の問いを渡すため）。出力は捨てる */
async function withConfigHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

const relativeFrom = (from: string, to: string) => relative(from, to);

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
    for (const t of TARGETS) expect(existsSync(join(root, t))).toBe(false);
    rmSync(join(root, "src"), { recursive: true });
    expect(snapshot(root)).toEqual(before.files);
    expect(readFileSync(cfgFile, "utf8")).toBe(before.cfg);

    const other = join(tempDir("p3-assets-"), "other");
    const clash = p3(root, ["init", "--yes", "--agents", "--project", "app", "--dir", other]);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain("別のフォルダで登録済みです");
    expect(existsSync(other)).toBe(false);
  });

  it("CLAUDE.md だけがあればそちらに追記する", async () => {
    const root = await repo();
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
    expect(p3(root, ["init", "--yes", "--agents", "--dir", ".p3"]).code).toBe(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("タスク管理（infodb p3）");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expectPlaced(root);
  });

  it("--agents が無ければ（非対話では）何も置かない", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--dir", ".p3"]).code).toBe(0);
    for (const t of TARGETS) expect(existsSync(join(root, t))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# rules\n");
  });
});

describe("AI 向けの使い方の置く先（init --agents claude|codex|both・p3 agents）", () => {
  const SKILL = fileURLToPath(new URL("../skills/p3/SKILL.md", import.meta.url));
  const CLAUDE = ".claude/skills/p3/SKILL.md";
  const CODEX = ".agents/skills/p3/SKILL.md";
  const original = () => readFileSync(SKILL, "utf8");
  const has = (root: string, t: string) => existsSync(join(root, t));
  const agentsMd = (root: string) => readFileSync(join(root, "AGENTS.md"), "utf8");
  /** AGENTS.md の p3 の節が指すスキル */
  const refs = (root: string) => [CLAUDE, CODEX].filter((t) => agentsMd(root).includes(`\`${t}\``));

  it.each([
    ["claude", ["--agents", "claude"], [CLAUDE]],
    ["codex（= の形）", ["--agents=codex"], [CODEX]],
    ["both", ["--agents", "both"], [CLAUDE, CODEX]],
    ["値なし（both）", ["--agents"], [CLAUDE, CODEX]],
    ["値なしの後ろにオプション", ["--agents", "--description", "x"], [CLAUDE, CODEX]],
    ["指定なし（置かない）", [], []],
  ])("init %s", async (_label, args, placed) => {
    const root = await repo();
    const r = p3(root, ["init", "--yes", ...args, "--project", "app"]);
    expect(r.code, r.err).toBe(0);
    for (const t of [CLAUDE, CODEX]) expect(has(root, t), t).toBe(placed.includes(t));
    if (placed.length) expect(refs(root)).toEqual(placed);
    else expect(agentsMd(root)).toBe("# rules\n");
    expect(agentsMd(root).includes("中身は同じ")).toBe(placed.length > 1);
  });

  it("init: 知らない値・空の値・余分な位置引数は、何も書く前に断る", async () => {
    for (const args of [["--agents", "cursor"], ["--agents="], ["--agents", "claude", "codex"], ["extra"]]) {
      const root = await repo();
      const before = snapshot(root);
      const r = p3(root, ["init", "--yes", ...args, "--project", "app"]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toMatch(/--agents は claude \/ codex \/ both|位置引数/);
      expect(snapshot(root), args.join(" ")).toEqual(before);
      expect(existsSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"))).toBe(false);
    }
  });

  it("対話の init: 置く先を選べ、Enter は置かない（既にある AGENTS.md から推測しない）。--agents を付ければ聞かない", async () => {
    for (const [answer, placed] of [["", []], ["claude", [CLAUDE]], ["codex", [CODEX]], ["both", [CLAUDE, CODEX]]] as const) {
      const root = await repo();
      const questions: string[] = [];
      await withConfigHome(tempDir("p3-config-"), () =>
        init({ cwd: root, project: "app", prompt: async (q) => (questions.push(q), q.startsWith("AI 向けの p3 の使い方") ? answer : "") }),
      );
      const q = questions.find((x) => x.startsWith("AI 向けの p3 の使い方"));
      expect(q).toContain("（置かない / claude / codex / both）");
      expect(q).toContain("[置かない]");
      for (const t of [CLAUDE, CODEX]) expect(has(root, t), `${answer || "Enter"}: ${t}`).toBe((placed as readonly string[]).includes(t));
    }
    // 知らない答えは何も作らずに断る
    const root = await repo();
    await expect(
      withConfigHome(tempDir("p3-config-"), () => init({ cwd: root, project: "app", prompt: async (q) => (q.startsWith("AI 向け") ? "cursor" : "") })),
    ).rejects.toThrow("置く先は 置かない / claude / codex / both のどれか");
    expect(existsSync(join(root, ".p3"))).toBe(false);
    // 明示すれば聞かない
    const root2 = await repo();
    const asked: string[] = [];
    await withConfigHome(tempDir("p3-config-"), () => init({ cwd: root2, project: "app", agents: "codex", prompt: async (q) => (asked.push(q), "") }));
    expect(asked.some((x) => x.startsWith("AI 向け"))).toBe(false);
    expect([has(root2, CLAUDE), has(root2, CODEX)]).toEqual([false, true]);
  });

  it("p3 agents: 置く先は省けない。今いるリポジトリのルートに置き、データ・個人設定を作らない・変えない", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    for (const args of [[], ["cursor"], ["claude", "codex"]]) {
      const r = p3(root, ["agents", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("p3 agents claude|codex|both");
    }
    expect(p3(root, ["init", "--yes", "--force"]).err).toContain("--force は p3 agents でだけ使えます");
    const r = p3(join(root, "src"), ["agents", "claude"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("作成  AI 向けのスキル（Claude Code）を ../.claude/skills/p3/SKILL.md に置きました");
    expect([has(root, CLAUDE), has(root, CODEX), has(join(root, "src"), ".claude")]).toEqual([true, false, false]);
    expect(refs(root)).toEqual([CLAUDE]);
    expect(existsSync(join(root, ".p3"))).toBe(false);
    expect(existsSync(join(CONFIG_HOME, "infodb-p3"))).toBe(false);
    // もう一度は同じ
    const again = p3(root, ["agents", "claude"]);
    expect(again.out).toContain("同一  AI 向けのスキル（Claude Code）.claude/skills/p3/SKILL.md は最新です");
    expect(again.out).toContain("同一  AI 向けの使い方（AGENTS.md の節）は最新です");
  });

  it("p3 agents: 後から片方を足すと、スキルを置き、節の参照は変えずに知らせる。--force で節だけを置き換え（前後の文は残す）、参照は両方になる", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "claude", "--project", "app"]).code).toBe(0);
    writeFileSync(join(root, "AGENTS.md"), `${agentsMd(root)}\n## 自分たちの決まり\n\n- レビューは2人\n`);
    const r = p3(root, ["agents", "codex"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("作成  AI 向けのスキル（Codex）を .agents/skills/p3/SKILL.md に置きました");
    expect(r.out).toContain("保護  ※ AGENTS.md の「タスク管理（infodb p3）」の節は同梱の版と違うので変えません。最新にするなら p3 agents codex --force");
    expect(refs(root)).toEqual([CLAUDE]);
    const f = p3(root, ["agents", "codex", "--force"]);
    expect(f.out).toContain("同一  AI 向けのスキル（Codex）");
    expect(f.out).toContain("更新  AI 向けの使い方（AGENTS.md の「タスク管理（infodb p3）」の節）を置き換えました");
    expect(refs(root)).toEqual([CLAUDE, CODEX]);
    const text = agentsMd(root);
    expect(text.startsWith("# rules\n")).toBe(true);
    expect(text).toContain("## 自分たちの決まり\n\n- レビューは2人\n");
    expect(text.split("タスク管理（infodb p3）")).toHaveLength(2);
    expect(p3(root, ["agents", "both"]).out).toContain("同一  AI 向けの使い方（AGENTS.md の節）は最新です");
  });

  it("p3 agents: 手で直したスキルは上書きせず違う行を出し、--force で選んだ先だけを同梱の版にする。選ばなかった先・ほかの指示は変えない", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "--project", "app"]).code).toBe(0);
    for (const t of [CLAUDE, CODEX]) writeFileSync(join(root, t), original().replace(/\n/, "\n手で足した行\n"));
    const before = { codex: readFileSync(join(root, CODEX), "utf8"), md: agentsMd(root), yaml: readFileSync(join(root, ".p3", "project.yaml"), "utf8"), cfg: readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8") };
    const r = p3(root, ["agents", "claude"]);
    expect(r.out).toContain("保護  ※ .claude/skills/p3/SKILL.md（Claude Code）は既にあり、同梱の版と違うので上書きしません（2 行目から違います）。最新にするなら p3 agents claude --force");
    const f = p3(root, ["agents", "claude", "--force"]);
    expect(f.out).toContain("更新  AI 向けのスキル（Claude Code）.claude/skills/p3/SKILL.md を同梱の版にしました");
    expect(readFileSync(join(root, CLAUDE), "utf8")).toBe(original());
    expect(readFileSync(join(root, CODEX), "utf8")).toBe(before.codex);
    expect(agentsMd(root)).toBe(before.md);
    expect(readFileSync(join(root, ".p3", "project.yaml"), "utf8")).toBe(before.yaml);
    expect(readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8")).toBe(before.cfg);
  });

  it("p3 agents: 消した先は戻さない。以前の版の節（両方を指す）は通常は残し、--force で今ある先だけを指す節にする", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "--project", "app"]).code).toBe(0); // 以前と同じ両方
    rmSync(join(root, ".agents"), { recursive: true });
    const r = p3(root, ["agents", "claude"]);
    expect(r.out).toContain("保護  ※ AGENTS.md の「タスク管理（infodb p3）」の節は同梱の版と違うので変えません");
    expect(has(root, CODEX)).toBe(false);
    expect(refs(root)).toEqual([CLAUDE, CODEX]);
    expect(p3(root, ["agents", "claude", "--force"]).code).toBe(0);
    expect(has(root, CODEX)).toBe(false);
    expect(refs(root)).toEqual([CLAUDE]);
  });

  it("p3 agents: 節が複数・見出しになっていないときは --force でも変えず、手で整理するよう知らせる。### の節は段を保って置き換える", async () => {
    const dup = await repo();
    writeFileSync(join(dup, "AGENTS.md"), "# rules\n\n## タスク管理（infodb p3）\n\n- 古い1\n\n## タスク管理（infodb p3）\n\n- 古い2\n");
    const inline = await repo();
    writeFileSync(join(inline, "AGENTS.md"), "# rules\n\nタスク管理（infodb p3）は使わない\n");
    for (const [root, message] of [[dup, "の節が2 つあります"], [inline, "の節が見出しとして見つかりません"]] as const) {
      const before = agentsMd(root);
      const r = p3(root, ["agents", "claude", "--force"]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(message);
      expect(r.out).toContain("手で1つの節");
      expect(agentsMd(root)).toBe(before);
      expect(has(root, CLAUDE)).toBe(true); // スキルは置く
    }
    const deep = await repo();
    writeFileSync(join(deep, "AGENTS.md"), "# rules\n\n### タスク管理（infodb p3）\n\n- 古い\n\n### 次の節\n\n- そのまま\n");
    expect(p3(deep, ["agents", "claude", "--force"]).out).toContain("更新  AI 向けの使い方");
    const text = agentsMd(deep);
    expect(text).toContain("### タスク管理（infodb p3）\n\n- 作業の単位は要望");
    expect(text).not.toContain("- 古い\n");
    expect(text).toContain("### 次の節\n\n- そのまま\n");
    // コードの囲みの中の見出しは数えない
    const fenced = await repo();
    writeFileSync(join(fenced, "AGENTS.md"), "# rules\n\n```md\n## タスク管理（infodb p3）\n```\n");
    expect(p3(fenced, ["agents", "claude"]).out).toContain("の節が見出しとして見つかりません");
  });
});

describe("p3 request", () => {
  it("要望は日付-乱数のフォルダになり、一部の ID でも指せる", async () => {
    const { root, rid } = await initialized();
    expect(rid).toMatch(/^\d{6}-[0-9a-z]{5}$/);
    expect(existsSync(join(root, ".p3", "requests", rid, "request.md"))).toBe(true);
    expect(p3(root, ["request", "ls", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["request", "set", rid.slice(-5), "status=active"]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
    expect(p3(root, ["request", "set", rid, "status=accepted"]).err).toContain("要望のステータス");
  });
});

describe("p3 のタスク操作（--req で要望を指定）", () => {
  it("作成・一覧・更新・移動・関係・アーカイブ", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    expect(p3(root, ["new", "API の認証", "--area", "src/api", ...r]).out).toContain(`${rid}/T001`);
    // 本文が - で始まっても受け取れる
    expect(p3(root, ["new", "通知", "--body", "- 箇条書き", ...r]).code).toBe(0);
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T002.md"), "utf8")).toContain("- 箇条書き");

    relate(root, rid, "T002", [{ type: "depends_on", target: "T001" }]);
    // 関係を手で張る・影響範囲のコマンドは無い
    for (const cmd of ["link", "unlink", "impact"]) expect(p3(root, [cmd, "T2", "depends_on", "T1", ...r]).err).toContain("不明なコマンド");

    expect(p3(root, ["move", "T2", "doing", ...r]).code).toBe(0);
    expect(p3(root, ["move", "2", "in_progress", ...r]).err).toContain("ステータスは");
    expect(p3(root, ["set", "1", "labels=a,b", "outputs=docs/a.md", ...r]).code).toBe(0);
    expect(p3(root, ["set", "1", "outputs=", ...r]).code).toBe(0);
    expect(p3(root, ["set", "1", "due=2026-10-20", ...r]).err).toContain("変更できるキー"); // 予定の日付は持たない

    const ls = p3(root, ["ls", "--status", "todo", "--json", ...r]).json();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ id: "T001", labels: ["a", "b"], outputs: [] });
    // 作業中にした日時は記録される
    expect(p3(root, ["show", "T2", "--json", ...r]).json().item.startedAt).toBeTruthy();

    const show = p3(root, ["show", "T1", "--json", ...r]).json();
    expect(show.dependents).toEqual([{ ref: `${rid}/T002`, title: "通知", status: "doing" }]);
    expect(show).not.toHaveProperty("graph");
    // 「相手の役割 + 相手」で見せる: T002 → depends_on → T001 なら、T001 には「依存元 T002」、T002 には「依存先 T001」
    expect(p3(root, ["show", "T1", ...r]).out).toMatch(/← 依存元 +T002/);
    expect(p3(root, ["show", "T2", ...r]).out).toMatch(/→ 依存先 +T001/);
    expect(p3(root, ["help"]).out).toContain("depends_on    依存する（相手が先に終わっている必要がある）  →「依存先」/ 逆「依存元」");
    expect(p3(root, ["find", "通知", "--json", ...r]).json().candidates.map((c: any) => c.ref)).toContain(`${rid}/T002`);

    expect(p3(root, ["archive", "2", ...r]).code).toBe(0);
    expect(p3(root, ["show", "T2", ...r]).code).toBe(2); // アーカイブしたら見つからない
  });

  it("move --output で成果物（PR の URL など）を足す。全要望の一覧と進捗", async () => {
    const { root, rid } = await initialized();
    p3(root, ["new", "A", "--req", rid]);
    p3(root, ["new", "B", "--req", rid]);
    // AI が完了にするときは変更の記録が要る（無ければ何も変えずに断る）
    const ng = p3(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--req", rid], { P3_ACTOR: "ai:claude" });
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("--record で変更の記録");
    expect(p3(root, ["show", `${rid}/T1`, "--json"]).json().item.status).toBe("todo");
    const record = "- 認証の失敗を 401 で返すようにした\n- 理由: 画面が再ログインに誘導できないため\n- 決まり: 期限切れは 401、権限なしは 403";
    const done = p3(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--record", "-", "--req", rid], { P3_ACTOR: "ai:claude" }, CONFIG_HOME, record);
    expect(done.code, done.err).toBe(0);
    const t = p3(root, ["show", `${rid}/T1`, "--json"]).json().item;
    expect(t).toMatchObject({ status: "done", outputs: ["https://example.com/pull/7"], updatedBy: "ai:claude", record });
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("期限切れは 401");
    // 作業に読む短い出力にも出る。人は記録なしでも完了にできる
    expect(p3(root, ["show", `${rid}/T1`, "--brief", "--json"]).json().item.record).toBe(record);
    expect(p3(root, ["show", `${rid}/T1`, "--brief"]).out).toContain("## 変更の記録\n- 認証の失敗");
    expect(p3(root, ["show", `${rid}/T1`]).out).toContain("変更の記録:\n  - 認証の失敗");
    expect(p3(root, ["move", "T2", "done", "--req", rid]).code).toBe(0);
    expect(p3(root, ["move", "T2", "todo", "--req", rid]).code).toBe(0);
    // 人が確認して「済み」にする（完了前のタスクは拒む）
    expect(p3(root, ["check", "T2", "--req", rid]).err).toContain("まだ完了していません");
    expect(p3(root, ["check", "T1", "--req", rid]).code).toBe(0);
    expect(p3(root, ["show", `${rid}/T1`, "--json"]).json().item.checkedAt).toBeTruthy();
    expect(p3(root, ["check", "T1", "--off", "--req", rid]).code).toBe(0);
    expect(p3(root, ["show", `${rid}/T1`, "--json"]).json().item.checkedAt).toBeUndefined();
    expect(p3(root, ["ls", "--all", "--json"]).json()).toHaveLength(2);
    const progress = p3(root, ["progress", "--json"]).json();
    expect(progress[0]).toMatchObject({ total: 2, done: 1, counts: { todo: 1, doing: 0, done: 1 } });
    expect(p3(root, ["progress"]).out).toContain("1/2");
  });

  it("終了コード: 競合は 3、見つからないは 2、使い方の誤りは 1。要望が決まらなければ案内する", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    p3(root, ["new", "A", ...r]);
    p3(root, ["set", "1", "labels=x", ...r]);
    const conflict = p3(root, ["move", "1", "done", "--rev", "1", ...r]);
    expect(conflict.code).toBe(3);
    expect(conflict.err).toContain("競合");
    expect(p3(root, ["move", "1", "done", "--rev", "2", ...r]).code).toBe(0);
    expect(p3(root, ["move", "99", "done", ...r]).code).toBe(2);
    expect(p3(root, ["show", "T099", ...r]).code).toBe(2); // show は語句でも探す。何も当たらなければ 2
    expect(p3(root, ["nope"]).code).toBe(1);
    expect(p3(root, ["set", "1", "color=red", ...r]).err).toContain("変更できるキー");
    const noReq = p3(root, ["new", "どこに？"]);
    expect(noReq.code).toBe(1);
    expect(noReq.err).toContain("要望を指定");
  });

  it("プロジェクトが無ければ init を案内する", async () => {
    const root = await repo();
    const r = p3(root, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("p3 init --project");
  });
});

describe("要望の作業ツリー", () => {
  it("要望のブランチ・作業ツリーの中では要望の指定を省け、書き込みはメインの .p3/ に行く", async () => {
    const { root, rid } = await initialized();
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    p3(root, ["accept", rid]);
    const branch = p3(root, ["request", "show", rid, "--json"]).json().item.workstreams.app.branch;
    expect(branch).toBe(`req/${rid}`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "p3");
    const wt = join(root, ".worktrees", rid);
    git(root, "worktree", "add", "-q", wt, "-b", branch);

    // AI が作業ツリーで作業している想定
    const ai = { P3_ACTOR: "ai:claude" };
    expect(p3(wt, ["whoami", "--json"], ai).json()).toMatchObject({ actor: "ai:claude", request: rid });
    expect(p3(wt, ["move", "T1", "doing"], ai).code).toBe(0);
    const added = p3(wt, ["new", "作業中に見つかった追加の作業", "--json"], ai).json();
    expect(added.ref).toBe(`${rid}/T004`);
    expect(readFileSync(join(root, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: doing");
    expect(existsSync(join(root, ".p3", "requests", rid, "tasks", "T004.md"))).toBe(true);
    // 作業ツリーの .p3/ はブランチ時点の写しのまま
    expect(readFileSync(join(wt, ".p3", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: todo");
    expect(existsSync(join(wt, ".p3", "requests", rid, "tasks", "T004.md"))).toBe(false);

    // `pnpm --dir <p3 の場所> p3 ...` で呼ばれたとき（pnpm がカレントを p3 の場所に移し、元の場所は INIT_CWD）
    const viaPnpm = { ...ai, npm_lifecycle_event: "p3", npm_package_name: "@infodb/p3", INIT_CWD: wt };
    expect(p3(fileURLToPath(new URL("..", import.meta.url)), ["whoami", "--json"], viaPnpm).json()).toMatchObject({ actor: "ai:claude", request: rid });
    // 利用者のパッケージの "p3" スクリプトから呼ばれたとき（pnpx・npm exec も）は、今の場所のまま
    const viaUserScript = { ...ai, npm_lifecycle_event: "p3", npm_package_name: "myapp", INIT_CWD: tempDir() };
    expect(p3(wt, ["whoami", "--json"], viaUserScript).json()).toMatchObject({ request: rid });
  });
});

describe("p3 preflight / drafts / accept", () => {
  it("mock エンジンで評価し、一部を除いてタスク化する", async () => {
    const { root, rid } = await initialized();
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(run.json()).toMatchObject({ status: "completed", engine: "mock" });
    expect(p3(root, ["drafts", rid]).out).toContain("D3");

    const accepted = p3(root, ["accept", rid, "--skip", "d3", "--json"]).json();
    expect(accepted).toMatchObject({ archived: [], kept: [] });
    expect(accepted.tasks.map((t: any) => [t.id, t.title])).toEqual([
      ["T001", "送信基盤"],
      ["T002", "設定画面"],
    ]);
    expect(accepted.tasks[1].relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });

  it("評価のあとで本文を変えると accept は断り（--json で理由）、再評価すればタスク化できる", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    const rev = p3(root, ["request", "show", rid, "--brief", "--json"]).json().item.rev;
    const set = p3(root, ["request", "set", rid, "--body", "-", "--rev", String(rev), "--json"], {}, CONFIG_HOME, "- 送信基盤\n- 再送\n");
    expect(set.code, set.err).toBe(0);
    expect(set.json().body).toContain("- 再送");
    // 古い rev では保存しない
    expect(p3(root, ["request", "set", rid, "--body", "x", "--rev", String(rev)]).code).toBe(3);

    expect(p3(root, ["drafts", rid]).out).toContain("古い評価からはタスク化しません");
    expect(p3(root, ["drafts", rid, "--json"]).json().inputMatch).toEqual({ status: "changed", changed: ["body"] });
    const json = p3(root, ["accept", rid, "--json"]);
    expect(json.code).toBe(1);
    expect(json.json()).toMatchObject({ code: "stale_input", request: rid, inputMatch: { status: "changed", changed: ["body"] } });
    const human = p3(root, ["accept", rid]);
    expect(human.code).toBe(1);
    expect(human.err).toContain(`p3 preflight ${rid}`);
    expect(p3(root, ["ls", "--req", rid, "--json"]).json()).toEqual([]);

    expect(p3(root, ["preflight", rid, "--engine", "mock"]).code).toBe(0);
    const ok = p3(root, ["accept", rid, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json().tasks.map((t: any) => t.title)).toEqual(["送信基盤", "再送"]);
  });
});

describe("マシンごとの設定（環境変数と個人設定。.env は読まない）", () => {
  const configFile = () => join(CONFIG_HOME, "infodb-p3", "config.yaml");
  const appendConfig = (text: string) => writeFileSync(configFile(), `${readFileSync(configFile(), "utf8")}${text}`);

  it("個人設定の preflight.engine: mock で Mock になり、無ければ Codex が使えない理由で失敗する（Mock にしない）", async () => {
    const { root, rid } = await initialized();
    const codex = p3(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(codex.code).not.toBe(0);
    expect(codex.out + codex.err).not.toContain('"engine": "mock"');

    appendConfig("preflight:\n  engine: mock\n");
    const mock = p3(root, ["preflight", rid, "--json"]);
    expect(mock.code, mock.err).toBe(0);
    expect(mock.json()).toMatchObject({ status: "completed", engine: "mock" });
  });

  it("パッケージやプロジェクトに .env があっても読まない", async () => {
    const { root, rid } = await initialized();
    writeFileSync(join(root, ".env"), "P3_PREFLIGHT_ENGINE=mock\n");
    writeFileSync(join(root, ".p3", ".env"), "P3_PREFLIGHT_ENGINE=mock\n");
    const r = p3(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(r.code).not.toBe(0);
    expect(readFileSync(new URL("../src/core/context.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
    expect(readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
  });

  it("読めない設定は、直す場所を示して終了コード 1", async () => {
    const { root } = await initialized();
    const env = p3(root, ["request", "ls"], { P3_CODEX_PATH_MAP: "/workspaces" });
    expect(env.code).toBe(1);
    expect(env.err).toMatch(/設定: 環境変数 P3_CODEX_PATH_MAP の「\/workspaces」が読めません/);
    appendConfig("serve:\n  port: web\n");
    const cfg = p3(root, ["whoami"]);
    expect(cfg.code).toBe(1);
    expect(cfg.err).toContain("個人設定 serve.port");
    // 個人設定のプロジェクトの一覧・登録は、マシンの設定が読めなくても使える
    expect(p3(root, ["project", "ls"]).code).toBe(0);
  });

  it("init・project add / rm で個人設定を書いても、マシンの設定は残る", async () => {
    const { root } = await initialized();
    appendConfig("codex:\n  pathMap:\n    /workspaces: /home/me/workspaces\n  ensureImage: false\n");
    const other = await repo();
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", join(other, ".p3")]).code).toBe(0);
    expect(p3(root, ["project", "rm", "other"]).code).toBe(0);
    expect(p3(other, ["project", "add", "other", join(other, ".p3")]).code).toBe(0);
    const text = readFileSync(configFile(), "utf8");
    expect(text).toContain("/workspaces: /home/me/workspaces");
    expect(text).toContain("ensureImage: false");
  });
});

describe("p3 preflight --note / notes", () => {
  it("メモだけ書き足し、一覧で渡すものを確かめ、次の Preflight で引き継ぐ", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["preflight", rid, "--note-only"]).err).toContain("--note");
    expect(p3(root, ["preflight", rid, "--note", " ", "--note-only"]).err).toContain("空");
    const first = p3(root, ["preflight", rid, "--engine", "mock", "--json"]).json();

    const note = p3(root, ["preflight", rid, "--note", "- 再送は不要", "--note-only", "--json"], { P3_ACTOR: "human:a" });
    expect(note.code, note.err).toBe(0);
    expect(note.json()).toMatchObject({ body: "- 再送は不要", createdBy: "human:a" });
    const notes = p3(root, ["notes", rid, "--json"]).json();
    expect(notes).toMatchObject({ previous: first.id, notes: [{ id: note.json().id, pending: true }] });
    expect(p3(root, ["notes", rid]).out).toContain(`前回 ${first.id} を引き継ぐ・メモ 1 件を渡す`);

    const second = p3(root, ["preflight", rid, "--engine", "mock", "--note", "設定画面は後回し"]);
    expect(second.code, second.err).toBe(0);
    expect(second.err).toContain("を書き足しました");
    expect(second.out).toContain(`引き継ぎ: 前回 ${first.id} / メモ `);
    expect(p3(root, ["notes", rid, "--json"]).json().notes.map((n: any) => n.pending)).toEqual([false, false]);
  });
});

describe("show --brief（作業に要る項目だけ）", () => {
  /**
   * T001 done・T002 doing（← T001）・T003 todo（← T002・別の要望のタスク・別の要望・アーカイブした T004）、
   * T005 が T001 を置き換え、要望も T001 を置き換える
   */
  async function prepared() {
    const { root, rid } = await initialized();
    const other = p3(root, ["request", "new", "別の要望", "--json"]).json().id as string;
    p3(root, ["new", "別の要望のタスク", "--req", other]);
    for (const t of ["下準備", "本体", "仕上げ", "消す予定", "新しい方式"]) p3(root, ["new", t, "--req", rid, "--body", `${t}の作業内容\n\n## 完了条件\n- できる`]);
    p3(root, ["move", "T001", "done", "--req", rid, "--output", "https://example.com/pull/1"]);
    p3(root, ["move", "T002", "doing", "--req", rid]);
    relate(root, rid, "T002", [{ type: "depends_on", target: "T001" }]);
    relate(root, rid, "T003", [{ type: "depends_on", target: "T002" }, { type: "depends_on", target: "T004" }]);
    relate(root, rid, "T005", [{ type: "supersedes", target: "T001", note: "新しい方式に替える" }]);
    p3(root, ["archive", "T004", "--req", rid]);
    return { root, rid, other };
  }

  it("タスク: 本文・依存とその状態（見つからないものは null）・置き換えの注意・成果物・rev を残し、ほかを省く", async () => {
    const { root, rid } = await prepared();
    const full = p3(root, ["show", "T003", "--req", rid, "--json"]).json();
    const brief = p3(root, ["show", "T003", "--req", rid, "--brief", "--json"]);
    expect(brief.code, brief.err).toBe(0);
    const b = brief.json();
    expect(Object.keys(b)).toEqual(["item", "work", "superseded", "dependencies", "warnings"]);
    expect(b.work).toMatchObject({ repo: "app", registered: true }); // 作業先にできる参照先が1つなので、それ
    expect(Object.keys(b.item)).toEqual(["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"]);
    for (const k of Object.keys(b.item)) if (k !== "relations") expect(b.item[k]).toEqual(full.item[k]);
    expect(b.item.body).toContain("## 完了条件");
    // 依存だけ。type / target は元のまま
    expect(b.item.relations.map((r: any) => [r.type, r.target])).toEqual([
      ["depends_on", "T002"],
      ["depends_on", "T004"],
    ]);
    const deps = [
      { ref: `${rid}/T002`, title: "本体", status: "doing" },
      { ref: `${rid}/T004`, title: null, status: null }, // アーカイブした: 状態不明（完了とは扱わない）
    ];
    expect(b.dependencies).toEqual(deps);
    expect(full.dependencies).toEqual(deps); // 通常の --json にも同じ項目
    expect(b).not.toHaveProperty("graph");
    expect(b).not.toHaveProperty("file");
    expect(b.item).not.toHaveProperty("createdAt");

    const text = p3(root, ["show", "T003", "--req", rid, "--brief"]).out;
    expect(text).toContain("依存    T002 doing / T004 （状態不明）");
    expect(text).toContain("仕上げの作業内容");
    expect(text).not.toContain("関係しそう");
    expect(text).not.toContain("影響範囲");
    expect(text).not.toContain("ファイル:");
    expect(text.length).toBeLessThan(p3(root, ["show", "T003", "--req", rid]).out.length);

    // 依存なし・完了・成果物
    const done = p3(root, ["show", "T001", "--req", rid, "--brief", "--json"]).json();
    expect(done.item).toMatchObject({ status: "done", outputs: ["https://example.com/pull/1"], relations: [] });
    expect(done.dependencies).toEqual([]);
  });

  it("置き換え: 印と警告を、通常・短い出力で同じ形で出す", async () => {
    const { root, rid } = await prepared();
    const superseded = [{ from: `${rid}/T005`, note: "新しい方式に替える" }];
    const warnings = [{ code: "superseded", target: `${rid}/T001`, from: [`${rid}/T005`], message: expect.stringContaining("置き換えられています") }];
    for (const extra of [[], ["--brief"]]) {
      const j = p3(root, ["show", "T001", "--req", rid, ...extra, "--json"]).json();
      expect(j.superseded).toEqual(superseded);
      expect(j.warnings).toEqual(warnings);
    }
    expect(p3(root, ["show", "T001", "--req", rid, "--brief"]).out).toContain("※ 261");
    // 着手の警告（move）は今までどおり
    expect(p3(root, ["move", "T002", "doing", "--req", rid, "--json"]).json().warnings).toBeUndefined();
  });

  it("要望: 本文・状態・ブランチ・タスクの一覧（id・ref・title・status）と issue。show <要望> と request show は同じ", async () => {
    const { root, rid } = await prepared();
    // 未完了のタスクがあるのに対応済（ファイルを人が直したなど。CLI からはこの状態にできない）
    const reqFile = join(root, ".p3", "requests", rid, "request.md");
    writeFileSync(reqFile, readFileSync(reqFile, "utf8").replace(/^status: \w+$/m, "status: resolved"));
    const full = p3(root, ["request", "show", rid, "--json"]).json();
    const b = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(Object.keys(b)).toEqual(["item", "branches", "tasks", "issue", "parent", "ancestors", "children", "hierarchyIssues"]);
    expect(Object.keys(b.item)).toEqual(["id", "title", "status", "body", "rev", "workstreams"]); // タスクを足したときに作業先のブランチを割り当てている
    for (const k of Object.keys(b.item)) expect(b.item[k]).toEqual(full.item[k]);
    expect(b.tasks).toEqual(full.tasks.map((t: any) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status, repo: "app" })));
    expect(b.issue).toBe(full.issue);
    expect(p3(root, ["show", rid, "--brief", "--json"]).json()).toEqual(b);
    // 今の要望を省略しても同じ
    expect(p3(root, ["request", "show", "--req", rid, "--brief", "--json"]).json()).toEqual(b);
    const text = p3(root, ["request", "show", rid, "--brief"]).out;
    expect(text).toMatch(/^※ 対応済ですが/);
    expect(text).toContain("タスク (4):");
    expect(text).not.toContain("関係:");
  });

  it("ブランチのある要望は作業先ごとのブランチを残し、曖昧な指定・見つからない指定は今までどおり", async () => {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    const b = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(b.item.workstreams.app.branch).toMatch(/^req\//);
    expect(b.branches).toEqual(b.item.workstreams);
    expect(p3(root, ["request", "show", rid, "--brief"]).out).toContain(`branch  app: ${b.item.workstreams.app.branch}`);
    expect(p3(root, ["show", "存在しない語句", "--brief"]).code).toBe(2);
  });
});

describe("置き換えられたタスク", () => {
  /** 初回のタスク化（T001〜T003）の後に再評価し、新しい案 D1 が T001・T002 を、D2 が T003 を置き換えると書かれた状態を作る */
  async function reassessed() {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    p3(root, ["move", "T002", "doing", "--req", rid]);
    const run = p3(root, ["preflight", rid, "--engine", "mock", "--json"]).json();
    expect(run, JSON.stringify({ status: run.status, error: run.error, log: run.log?.slice(-3) })).toMatchObject({ status: "completed" });
    const dir = join(root, ".p3", "requests", rid, "preflight", run.id);
    const d1 = join(dir, "drafts", "D1.md");
    writeFileSync(d1, readFileSync(d1, "utf8").replace("include: true", "supersedes: [T001, T002]\ninclude: true"));
    const d2 = join(dir, "drafts", "D2.md");
    writeFileSync(d2, readFileSync(d2, "utf8").replace("include: true", "supersedes: [T003]\ninclude: true"));
    return { root, rid };
  }

  it("タスク化の前に候補を見せ、フラグが無ければ残して印を付け、着手すると警告する", async () => {
    const { root, rid } = await reassessed();
    expect(p3(root, ["drafts", rid, "--json"]).json().supersedes.map((c: any) => [c.id, c.status])).toEqual([
      ["T001", "todo"],
      ["T002", "doing"],
      ["T003", "todo"],
    ]);
    // D2・D3 を外すと、D1 の置き換えだけが残る
    const accepted = p3(root, ["accept", rid, "--only", "D1"]);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.out).toContain("置き換えられるタスクを残しました");
    const ls = p3(root, ["ls", "--req", rid, "--json"]).json();
    expect(ls.map((t: any) => [t.id, (t.superseded ?? []).map((m: any) => m.from)])).toEqual([
      ["T001", [`${rid}/T004`]],
      ["T002", [`${rid}/T004`]],
      ["T003", []], // 不採用の D2 にだけあった
      ["T004", []],
    ]);
    expect(p3(root, ["ls", "--req", rid]).out).toMatch(/T001 .*※置換 ← T004/);
    expect(p3(root, ["ls", "--all"]).out).toContain("※置換");
    expect(p3(root, ["show", "T003", "--req", rid]).out).not.toContain("※ 置き換えられています");
    expect(p3(root, ["show", "T001", "--req", rid, "--json"]).json().superseded).toEqual([{ from: `${rid}/T004` }]);

    // 着手は止めずに警告する。--json の stdout は JSON のまま、warnings で返す
    const moved = p3(root, ["move", "T001", "doing", "--req", rid, "--json"]);
    expect(moved.code).toBe(0);
    expect(moved.err).toContain("警告: ");
    expect(moved.json()).toMatchObject({ status: "doing", warnings: [{ code: "superseded", target: `${rid}/T001`, from: [`${rid}/T004`] }] });
    // 作業中のままの再指定や、置き換えられていないタスクでは出さない
    expect(p3(root, ["move", "T001", "doing", "--req", rid, "--json"]).json().warnings).toBeUndefined();
    expect(p3(root, ["move", "T004", "doing", "--req", rid]).err).not.toContain("警告");
    expect(p3(root, ["set", "T002", "status=todo", "--req", rid]).err).not.toContain("警告");
    expect(p3(root, ["set", "T002", "status=doing", "--req", rid]).err).toContain("警告");
  });

  it("--archive-superseded で確定時点の候補をアーカイブする", async () => {
    const { root, rid } = await reassessed();
    const r = p3(root, ["accept", rid, "--only", "d1", "--archive-superseded", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ tasks: [{ id: "T004" }], archived: ["T001", "T002"], kept: [] });
    expect(p3(root, ["ls", "--req", rid, "--json"]).json().map((t: any) => t.id)).toEqual(["T003", "T004"]);
    // 最大番号をアーカイブしても番号は再利用しない
    p3(root, ["archive", "T004", "--req", rid]);
    expect(p3(root, ["new", "次の作業", "--req", rid, "--json"]).json().id).toBe("T005");
  });
});

describe("要望の対応済", () => {
  it("全タスクを完了したら対応済にでき、未完了のタスクができたら進行中に戻す", async () => {
    const { root, rid } = await initialized();
    p3(root, ["preflight", rid, "--engine", "mock"]);
    p3(root, ["accept", rid]);
    const ng = p3(root, ["request", "set", rid, "status=resolved"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("完了していないタスクがあります: T001(todo), T002(todo), T003(todo)");
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");

    for (const t of ["T001", "T002", "T003"]) p3(root, ["move", t, "done", "--req", rid]);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active"); // 自動では対応済にしない
    const ok = p3(root, ["request", "set", rid, "status=resolved", "--json"], { P3_ACTOR: "ai:claude" });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json()).toMatchObject({ status: "resolved", updatedBy: "ai:claude" });
    expect(p3(root, ["request", "ls", "--status", "resolved", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["progress"]).out).toContain("resolved"); // 既定の一覧に残る（確認待ち）

    const back = p3(root, ["move", "T002", "doing", "--req", rid, "--json"]);
    expect(back.err).toContain("進行中に戻しました");
    expect(back.json().reopened).toBe(rid);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });
});

describe("p3 milestone と要望の管理項目", () => {
  it("マイルストーンを作り、要望に期限・マイルストーン・タグを付け、進捗をマイルストーンごとにまとめる", async () => {
    const { root, rid } = await initialized();
    expect(p3(root, ["milestone", "add", "v0.2", "--title", "要望単位の運用", "--due", "2026-11-30"]).code).toBe(0);
    expect(p3(root, ["milestone", "add", "v0.2"]).err).toContain("既にあります");
    expect(p3(root, ["request", "set", rid, "milestone=nope"]).err).toContain("マイルストーンがありません");
    expect(p3(root, ["request", "set", rid, "milestone=v0.2", "due=2026-11-15", "tags=ui,feature"]).code).toBe(0);
    const other = p3(root, ["request", "new", "別の要望", "--tag", "bug", "--json"]).json();
    expect(other.tags).toEqual(["bug"]);
    expect(p3(root, ["request", "ls", "--milestone", "v0.2", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(p3(root, ["request", "ls", "--tag", "bug", "--json"]).json().map((r: any) => r.id)).toEqual([other.id]);
    const text = p3(root, ["progress"]).out;
    expect(text).toContain("■ 要望単位の運用（v0.2 · 2026-11-30）");
    expect(text).toContain("■ マイルストーンなし");
    expect(p3(root, ["milestone", "rm", "v0.2"]).err).toContain("使用中のマイルストーンは消せません");
    expect(p3(root, ["milestone", "set", "v0.2", "--done"]).code).toBe(0);
    expect(p3(root, ["milestone", "--json"]).json()).toEqual([{ id: "v0.2", title: "要望単位の運用", due: "2026-11-30", done: true }]);
  });

  it("一覧・進捗・概要はマイルストーンを ID のバージョンの降順に出す（project.yaml の順は変えない）", async () => {
    const { root, rid } = await initialized();
    for (const id of ["v0.9", "v0.10", "v0.2"]) expect(p3(root, ["milestone", "add", id, "--title", `題 ${id}`]).code).toBe(0);
    const yaml = readFileSync(join(root, ".p3", "project.yaml"), "utf8");
    expect(p3(root, ["milestone", "--json"]).json().map((m: any) => m.id)).toEqual(["v0.10", "v0.9", "v0.2"]);
    const ls = p3(root, ["milestone"]).out;
    expect(ls.indexOf("v0.10")).toBeLessThan(ls.indexOf("v0.9"));
    expect(ls.indexOf("v0.9")).toBeLessThan(ls.indexOf("v0.2"));
    expect(p3(root, ["config"]).out).toContain("milestones     v0.10, v0.9, v0.2");
    // 進捗のまとまりも同じ順。マイルストーンなしは最後
    expect(p3(root, ["request", "set", rid, "milestone=v0.2"]).code).toBe(0);
    const b = p3(root, ["request", "new", "十", "--milestone", "v0.10", "--json"]).json();
    p3(root, ["request", "new", "なし", "--json"]);
    const text = p3(root, ["progress"]).out;
    const pos = ["（v0.10", "（v0.2", "マイルストーンなし"].map((h) => text.indexOf(h));
    expect(pos.every((x) => x >= 0), text).toBe(true);
    expect([...pos].sort((x, y) => x - y)).toEqual(pos);
    expect(b.milestone).toBe("v0.10");
    // 表示だけでは project.yaml を書き換えない（登録の順のまま）
    expect(readFileSync(join(root, ".p3", "project.yaml"), "utf8")).toBe(yaml);
    expect(yaml.indexOf("v0.9")).toBeLessThan(yaml.indexOf("v0.10"));
  });
});

describe("p3 config", () => {
  it("設定を変え、project.yaml に書く", async () => {
    const { root } = await initialized();
    expect(p3(root, ["config", "set", "description=経費精算", "instructions=個人情報に注意"]).code).toBe(0);
    expect(p3(root, ["config", "set", "branchPattern=feature"]).err).toContain("{id}");
    expect(p3(root, ["config", "set", "docs=docs"]).err).toContain("設定できるキー");
    expect(p3(root, ["config", "--json"]).json()).toMatchObject({
      description: "経費精算",
      preflight: { instructions: "個人情報に注意" },
    });
  });
});

describe("個人設定のプロジェクト（データはリポジトリの外）", () => {
  it("init で外のフォルダに作って登録し、以後はリポジトリの中・作業ツリー・プロジェクト名で決まる", async () => {
    const app = await repo();
    const p3Data = join(tempDir("p3-assets-"), "p3");
    const r = p3(join(app, "docs"), ["init", "--yes", "--project", "p3", "--dir", p3Data]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(p3Data, "project.yaml"))).toBe(true);
    expect(existsSync(join(app, ".p3"))).toBe(false);
    expect(readFileSync(join(p3Data, "project.yaml"), "utf8")).not.toContain("repo:"); // 手元の場所は共有するデータに書かない
    const cfg = readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
    expect(cfg).toContain(`dir: ${p3Data}`);
    expect(cfg).toContain(`${app.split("/").at(-1)!.toLowerCase()}: ${app}`);

    // 2つめのプロジェクト
    const other = await repo();
    const otherData = join(tempDir("p3-some-"), "other");
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", otherData]).code).toBe(0);

    // リポジトリの中なら、そのプロジェクト
    expect(p3(join(app, "docs"), ["whoami", "--json"]).json()).toMatchObject({ project: "p3", dataDir: p3Data, here: [app.split("/").at(-1)!.toLowerCase()] });
    expect(p3(other, ["whoami", "--json"]).json()).toMatchObject({ project: "other", dataDir: otherData });
    // データのフォルダの中でも
    expect(p3(p3Data, ["whoami", "--json"]).json().project).toBe("p3");
    // 関係ない場所では決まらず、選び方を案内する。--project で選べる
    const nowhere = tempDir();
    const ng = p3(nowhere, ["ls"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("p3 --project <名前>");
    expect(ng.err).toContain(p3Data);
    expect(p3(nowhere, ["whoami", "--json", "--project", "other"]).json().project).toBe("other");
    expect(p3(nowhere, ["whoami", "--project", "nope"]).err).toContain("登録されていません");

    // 要望を作り、要望の作業ツリーの中からでも決まる（作業ツリーはリポジトリの外に置いてもよい）
    const rid = p3(app, ["request", "new", "通知", "--json"]).json().id as string;
    expect(existsSync(join(p3Data, "requests", rid, "request.md"))).toBe(true);
    git(app, "add", "-A");
    git(app, "commit", "-qm", "x");
    const wt = join(tempDir("p3-wt-"), rid);
    git(app, "worktree", "add", "-q", wt, "-b", `req/${rid}`);
    expect(p3(wt, ["whoami", "--json"]).json()).toMatchObject({ project: "p3", request: rid });

    // 一覧（今いる場所のプロジェクトに *）・登録を外す
    expect(p3(app, ["project"]).out).toMatch(/^\* p3/m);
    expect(p3(nowhere, ["project", "rm", "other"]).code).toBe(0);
    // 登録が1つだけなら、どこからでもそれ
    expect(p3(nowhere, ["whoami", "--json"]).json().project).toBe("p3");
  });

  it("whoami はプロジェクトの決まり方（via）を出す。今いる場所で決まったのか、登録が1つだけで決まったのかを区別できる", async () => {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    const nowhere = tempDir();
    const via = (cwd: string, args: string[] = [], configHome = CONFIG_HOME) => p3(cwd, ["whoami", "--json", ...args], {}, configHome).json();

    expect(via(app)).toMatchObject({ project: "app", dataDir: data, via: "cwd" });
    expect(via(data).via).toBe("cwd");
    expect(via(nowhere)).toMatchObject({ project: "app", via: "only", here: [] });
    expect(via(nowhere, ["--project", "app"]).via).toBe("project");
    expect(via(nowhere, ["--dir", data]).via).toBe("dir");
    // 表でも分かる
    expect(p3(app, ["whoami"]).out).toContain("決まり方      cwd（今いる場所）");
    expect(p3(nowhere, ["whoami"]).out).toContain("決まり方      only（登録が1つだけ。今いる場所では決まっていない）");
    // 登録していないリポジトリの中の .p3/（via: legacy。initialized は自分の個人設定にも登録するので、空の個人設定で見る）
    const { root } = await initialized();
    expect(via(root, [], tempDir("p3-config-")).via).toBe("legacy");
  });

  it("既にあるデータのフォルダには join で参加する（別の人・別のマシンの想定）", async () => {
    const data = join(tempDir("p3-assets-"), "shared");
    const first = await repo();
    expect(p3(first, ["init", "--yes", "--project", "shared", "--dir", data, "--description", "共有"]).code).toBe(0);
    const before = readFileSync(join(data, "project.yaml"), "utf8");

    // 別の人: 個人設定は空、リポジトリは別の場所に clone した。init は断り、join で参加する
    CONFIG_HOME = tempDir("p3-config-");
    const clone = await repo();
    expect(p3(clone, ["init", "--yes", "--project", "shared", "--dir", data]).err).toContain(`参加するなら: p3 join --project shared --dir ${data}`);
    const r = p3(clone, ["join", "--yes", "--project", "shared", "--dir", data]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("参加しました");
    expect(readFileSync(join(data, "project.yaml"), "utf8")).toBe(before);
    // 共有の参照先が1つなので、このマシンのパスとして clone を登録する
    expect(p3(clone, ["whoami", "--json"]).json()).toMatchObject({ project: "shared", here: [expect.any(String)] });

    // init せずに登録だけ（リポジトリを指定）
    CONFIG_HOME = tempDir("p3-config-");
    expect(p3(tempDir(), ["project", "add", "shared", data, "--repo", clone]).err).toContain("--repo は使えなくなりました");
    expect(p3(tempDir(), ["project", "add", "shared", data]).code).toBe(0);
    const name = p3(tempDir(), ["--project", "shared", "repo", "ls", "--json"]).json()[0].name;
    expect(p3(tempDir(), ["--project", "shared", "repo", "path", name, clone]).code).toBe(0);
    expect(p3(clone, ["whoami", "--json"]).json().project).toBe("shared");
    expect(p3(tempDir(), ["project", "add", "x", tempDir()]).err).toContain("まだ p3 のプロジェクトではありません");
  });
});

/** フォルダの中身（相対パス → 内容）。変わっていないことを比べる */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) files[join(f.parentPath, f.name).slice(dir.length)] = readFileSync(join(f.parentPath, f.name), "base64");
  }
  return files;
}

describe("登録が1つだけで決まったとき（今いる場所では決まっていない）", () => {
  /** 登録が1つのプロジェクトに、要望・マイルストーン・添付を用意する（リポジトリの中で） */
  async function single() {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    const rid = p3(app, ["request", "new", "通知", "--json"]).json().id as string;
    expect(p3(app, ["new", "送信", "--req", rid]).code).toBe(0);
    expect(p3(app, ["milestone", "add", "v1"]).code).toBe(0);
    const { png } = await import("./imageFixture.ts");
    writeFileSync(join(app, "画面.png"), png(64, 48));
    const aid = p3(app, ["attach", "add", "画面.png", "--req", rid, "--json"]).json().id as string;
    return { app, data, rid, aid, nowhere: tempDir() };
  }

  it("変える操作は、何も読み書きせずに止まり、明示の方法と移る先を案内する", async () => {
    const { data, rid, aid, nowhere } = await single();
    writeFileSync(join(nowhere, "メモ.md"), "回答");
    const before = snapshot(data);
    const writes: string[][] = [
      ["request", "new", "関係ない作業"],
      ["req", "add", "関係ない作業"],
      ["new", "req", "関係ない作業"],
      ["add", "request", "関係ない作業"],
      ["new", "task", "x", "--req", rid],
      ["new", "x", "--req", rid],
      ["set", "T001", "title=x", "--req", rid],
      ["move", "T001", "doing", "--req", rid],
      ["check", "T001", "--req", rid],
      ["archive", "T001", "--req", rid],
      ["request", "set", rid, "status=active"],
      ["req", "archive", rid],
      ["request"],
      ["milestone", "add", "v2"],
      ["milestones", "set", "v1", "--title", "x"],
      ["milestone", "rm", "v1"],
      ["milestone", "remove", "v1"],
      ["config", "set", "name=x"],
      ["config", "x"],
      ["repo", "add", "infra"],
      ["repo", "set", "app", "role=x"],
      ["repo", "path", "app", nowhere],
      ["repo", "rm", "app"],
      ["preflight", rid],
      ["preflight", rid, "--note", "-", "--note-only"],
      ["accept", rid],
      ["attach", "add", "メモ.md", "--req", rid],
      ["attach", "get", aid, "--req", rid],
      ["attach", "get", aid, "--out", "out.png", "--req", rid],
      ["attach", "rm", aid, "--req", rid],
      ["release-notes", "generate", "v1"],
      ["release-note", "save", "v1"],
      ["serve", "--port", "0"],
      ["知らないコマンド"],
    ];
    for (const args of writes) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: nowhere,
        encoding: "utf8",
        input: "回答",
        timeout: 10_000, // serve が待ち受けを始めたら止める（その場合は失敗になる）
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: CONFIG_HOME, P3_PREFLIGHT_ENGINE: "mock" },
      });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("今いる場所ではプロジェクトが決まりません（登録が1つだけなので「app」になりますが、変える操作はしません）");
      expect(r.stderr).toContain(data);
      expect(r.stderr).toContain("p3 --project app <コマンド>");
      expect(r.stderr).toContain("データのフォルダの中で実行する");
      expect(r.stdout).toBe("");
    }
    expect(snapshot(data)).toEqual(before);
    expect(readdirSync(nowhere)).toEqual(["メモ.md"]);
  });

  it("読むだけの操作は続け、標準エラーに警告する（--json の出力はそのまま読める）", async () => {
    const { rid, nowhere } = await single();
    const reads: string[][] = [
      ["whoami"],
      ["progress"],
      ["ls", "--req", rid],
      ["list", "--req", rid],
      ["show", `${rid}/T001`],
      ["find", rid],
      ["resolve", rid],
      ["request", "ls"],
      ["req", "list"],
      ["request", "show", rid],
      ["milestone"],
      ["milestones", "ls"],
      ["config"],
      ["repo"],
      ["repo", "ls"],
      ["notes", rid],
      ["attach", "--req", rid],
      ["attach", "ls", "--req", rid],
      ["release-notes"],
      ["release-note", "ls"],
      ["release-notes", "show", "v1"],
    ];
    for (const args of reads) {
      const r = p3(nowhere, [...args, "--json"]);
      expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
      expect(r.err).toContain("※ 今いる場所ではプロジェクトが決まらず、登録が1つだけなので「app」を表示しています。変える操作の前には対象を明示してください。");
      expect(r.err).toContain("p3 --project app <コマンド>");
      expect(() => r.json()).not.toThrow();
    }
    // まだ無いもの（Preflight のタスク案・リリースノート）を読むときも、止めずに「無い」と返す
    for (const args of [["drafts", rid], ["release-notes", "export", "v1"]]) {
      const r = p3(nowhere, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("を表示しています");
      expect(r.err).not.toContain("変える操作はしません");
    }
    expect(p3(nowhere, ["whoami", "--json"]).json()).toMatchObject({ project: "app", via: "only", here: [] });
  });

  it("プロジェクトを明示するか、今いる場所で決まれば、変える操作もできる", async () => {
    const { app, data, nowhere } = await single();
    const made = (cwd: string, args: string[] = []) => {
      const r = p3(cwd, ["request", "new", "書ける", ...args, "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).toBe("");
      expect(existsSync(join(data, "requests", r.json().id, "request.md"))).toBe(true);
    };
    made(nowhere, ["--project", "app"]);
    made(nowhere, ["--dir", data]);
    made(app);
    made(join(app, "docs"));
    made(data);
    git(app, "add", "-A");
    git(app, "commit", "-qm", "x");
    const wt = join(tempDir("p3-wt-"), "wt");
    git(app, "worktree", "add", "-q", wt, "-b", "topic");
    made(wt);
    // 登録していないリポジトリの中の .p3/ は、登録が無くても今いる場所で決まる
    const { root } = await initialized();
    const r = p3(root, ["request", "new", "書ける", "--json"], {}, tempDir("p3-config-"));
    expect(r.code, r.err).toBe(0);
    expect(r.err).toBe("");
  });

  it("登録が無い・複数あるときの案内は今までどおり", async () => {
    const nowhere = tempDir();
    expect(p3(nowhere, ["request", "new", "x"]).err).toContain("プロジェクトがまだありません");
    await single();
    const other = await repo();
    expect(p3(other, ["init", "--yes", "--project", "other", "--dir", join(tempDir("p3-assets-"), "other")]).code).toBe(0);
    const r = p3(nowhere, ["request", "new", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("操作するプロジェクトが決まりません");
    expect(r.err).not.toContain("登録が1つだけ");
  });
});

describe("データのフォルダが無い・project.yaml が無い", () => {
  /** 登録したプロジェクト（データはリポジトリの外）と、関係ない場所 */
  async function registered() {
    const app = await repo();
    const data = join(tempDir("p3-assets-"), "app");
    expect(p3(app, ["init", "--yes", "--project", "app", "--dir", data]).code).toBe(0);
    return { app, data, nowhere: tempDir() };
  }
  const cfgOf = () => readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
  /** 止まったこと（終了コード 1・標準出力は空・案内は標準エラー） */
  const expectStopped = (r: ReturnType<typeof p3>, head: string, label: string) => {
    expect(r.code, `${label}: ${r.err}`).toBe(1);
    expect(r.out, label).toBe("");
    expect(r.err, label).toContain(head);
    expect(r.err).toContain("共有ドライブ");
    expect(r.err).toContain("p3 init --project");
  };
  const commands = (rid?: string): string[][] => [["whoami", "--json"], ["ls", "--json", ...(rid ? ["--req", rid] : [])], ["request", "new", "x", "--json"]];

  it("登録したフォルダが無くなったら、読む・書く・serve のどれも止まり、フォルダを作らない。登録を直せば戻る", async () => {
    const { app, data, nowhere } = await registered();
    const moved = `${data}-moved`;
    renameSync(data, moved);
    const cfg = cfgOf();
    for (const [cwd, extra] of [[app, []], [nowhere, ["--project", "app"]]] as const) {
      for (const args of commands()) {
        const r = p3(cwd, [...extra, ...args]);
        expectStopped(r, `データのフォルダがありません: ${data}`, args.join(" "));
        expect(r.err).toContain("p3 project ls");
        expect(r.err).toContain("p3 project rm app → p3 project add app <正しいフォルダ>（rm はデータを消さない）");
      }
    }
    // serve は自分で異常終了する（待ち受けを始めてタイムアウトで止められたのではない）
    const serve = spawnSync(process.execPath, [BIN, "serve", "--port", "39871"], {
      cwd: app,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: CONFIG_HOME },
    });
    expect(serve.signal).toBeNull();
    expect(serve.status).toBe(1);
    expect(serve.stderr).toContain("データのフォルダがありません");
    expect(existsSync(data)).toBe(false);
    expect(cfgOf()).toBe(cfg);

    // 案内どおりに登録を直す（rm はデータを消さない）
    expect(p3(nowhere, ["project", "ls"]).out).toContain(data);
    expect(p3(nowhere, ["project", "rm", "app"]).code).toBe(0);
    expect(existsSync(join(moved, "project.yaml"))).toBe(true);
    expect(p3(nowhere, ["project", "add", "app", moved]).code).toBe(0);
    expect(p3(nowhere, ["--project", "app", "repo", "path", app.split("/").at(-1)!.toLowerCase(), app]).code).toBe(0);
    const r = p3(app, ["request", "new", "戻った", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(moved, "requests", r.json().id, "request.md"))).toBe(true);
  });

  it("フォルダはあるが project.yaml が無いときも止まり、要望を書き足さない（--project・--dir のどちらでも）", async () => {
    const { app, data, nowhere } = await registered();
    const rid = p3(app, ["request", "new", "前からある", "--json"]).json().id as string;
    rmSync(join(data, "project.yaml"));
    const before = snapshot(data);
    const cfg = cfgOf();
    const yaml = join(data, "project.yaml");
    for (const [cwd, extra] of [[app, []], [nowhere, ["--project", "app"]], [nowhere, ["--dir", data]]] as const) {
      for (const args of commands(rid)) expectStopped(p3(cwd, [...extra, ...args]), `データのフォルダに project.yaml がありません: ${yaml}`, `${extra.join(" ")} ${args.join(" ")}`);
    }
    // 登録していないフォルダを --dir で指したときは、指し方を案内する
    const other = tempDir("p3-assets-");
    const r = p3(nowhere, ["--dir", other, "request", "new", "x"]);
    expectStopped(r, `データのフォルダに project.yaml がありません: ${join(other, "project.yaml")}`, "--dir 未登録");
    expect(r.err).toContain("--dir で指すときは、project.yaml のあるフォルダを指す");
    expect(readdirSync(other)).toEqual([]);
    expect(snapshot(data)).toEqual(before);
    expect(cfgOf()).toBe(cfg);
  });

  it("project.yaml があれば requests/ が無くても空のプロジェクトとして開ける", async () => {
    const { app, data } = await registered();
    rmSync(join(data, "requests"), { recursive: true });
    const ls = p3(app, ["request", "ls", "--json"]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.json()).toEqual([]);
    expect(p3(app, ["request", "new", "最初", "--json"]).code).toBe(0);
  });
});

describe("タグ（外部 ID・分類）", () => {
  it("--tag は値ごと（カンマで分けない）。request set --tag で置き換え、tags= はカンマで分ける。両方は使えない", async () => {
    const { root, rid } = await initialized();
    const made = p3(root, ["request", "new", "外部 ID つき", "--tag", "jira:PROJ-123", "--tag", " group:顧客A ", "--tag", "a,b", "--tag", "jira:PROJ-123", "--tag", " ", "--json"]).json();
    expect(made.tags).toEqual(["jira:PROJ-123", "group:顧客A", "a,b"]);
    const set = p3(root, ["request", "set", rid, "--tag", "release/2026Q4", "--tag", "顧客 A, 東京", "--json"]);
    expect(set.code, set.err).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["release/2026Q4", "顧客 A, 東京"]);
    expect(p3(root, ["request", "set", rid, "tags=x, y"]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["x", "y"]);
    const both = p3(root, ["request", "set", rid, "tags=x", "--tag", "y"]);
    expect(both.code).not.toBe(0);
    expect(both.err).toContain("一緒に使えません");
    expect(p3(root, ["request", "set", rid, "tags="]).code).toBe(0);
    expect(p3(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual([]);
    // 繰り返した --tag はどれか（完全一致）
    expect(p3(root, ["request", "ls", "--tag", "a,b", "--tag", "nothing", "--json"]).json().map((r: any) => r.id)).toEqual([made.id]);
    expect(p3(root, ["request", "ls", "--tag", "JIRA:PROJ-123", "--json"]).json()).toEqual([]);
  });
});

describe("成果物（URL・文章・パス）", () => {
  it("--output は繰り返して足せ、カンマで分けない。outputs= はカンマで分けて置き換える", async () => {
    const { root, rid } = await initialized();
    const made = p3(root, ["new", "成果物つき", "--req", rid, "--output", "https://example.com/pull/1", "--output", "設計の要点, 判断の理由は docs/x.md に", "--json"]).json();
    expect(made.outputs).toEqual(["https://example.com/pull/1", "設計の要点, 判断の理由は docs/x.md に"]);
    expect(p3(root, ["move", made.id, "done", "--req", rid, "--output", "docs/x.md", "--output", "https://example.com/pull/1"]).code).toBe(0);
    const shown = p3(root, ["show", made.id, "--req", rid, "--json"]).json();
    expect(shown.item.outputs).toEqual(["https://example.com/pull/1", "設計の要点, 判断の理由は docs/x.md に", "docs/x.md"]);
    expect(p3(root, ["show", made.id, "--req", rid, "--brief", "--json"]).json().item.outputs).toEqual(shown.item.outputs);
    expect(p3(root, ["set", made.id, "--req", rid, "outputs=a, b"]).code).toBe(0);
    expect(p3(root, ["show", made.id, "--req", rid, "--json"]).json().item.outputs).toEqual(["a", "b"]);
  });
});

describe("p3 repo（Preflight が読む参照先）", () => {
  it("3つ以上（git でないフォルダ・リポジトリの中のサブフォルダを含む）を足し・変え・消す。共有の定義とこのマシンのパスを分ける", async () => {
    const { root } = await initialized();
    // init がこのリポジトリを本体の参照先 app として登録している
    const before = p3(root, ["repo", "ls", "--json"]).json();
    expect(before.map((r: any) => [r.name, r.role, r.status, r.local])).toEqual([["app", "本体", "ok", root]]);

    const docsRepo = tempDir("docsrepo-");
    gitInit(docsRepo);
    await mkdir(join(docsRepo, "guide"));
    const infra = tempDir("infrarepo-"); // git でないフォルダ
    expect(p3(root, ["repo", "set", "app", "role=システム本体"]).code).toBe(0);
    expect(p3(root, ["repo", "add", "docs", join(docsRepo, "guide"), "role=ドキュメント"]).code).toBe(0);
    expect(p3(root, ["repo", "set", "docs", "mapFile=MAP.md"]).err).toContain("変えられるキー: role readFirst writable");
    const added = p3(root, ["repo", "add", "infra", infra, "role=基盤"]);
    expect(added.code, added.err).toBe(0);
    const ls = p3(root, ["repo", "ls", "--json"]).json();
    expect(ls.map((r: any) => [r.name, r.role, r.readFirst, r.writable, r.status, r.mount])).toEqual([
      ["app", "システム本体", true, true, "ok", "app"],
      ["docs", "ドキュメント", false, false, "ok", "docs"],
      ["infra", "基盤", false, false, "ok", "infra"],
    ]);
    // 共有の定義は project.yaml、このマシンのパスは個人設定（パスを共有のファイルに書かない）
    const yaml = readFileSync(join(root, ".p3", "project.yaml"), "utf8");
    expect(yaml).toContain("app:");
    expect(yaml).not.toContain(infra);
    const config = readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
    expect(config).toContain(infra);

    // 変える・同じ名前を足せない・使えない名前・フォルダでないもの
    expect(p3(root, ["repo", "set", "infra", "role=基盤（Terraform）", "readFirst=true"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().find((r: any) => r.name === "infra")).toMatchObject({ role: "基盤（Terraform）", readFirst: true });
    expect(p3(root, ["repo", "add", "infra", infra]).err).toContain("既にあります");
    expect(p3(root, ["repo", "add", "a:b", infra]).err).toContain("使えません");
    expect(p3(root, ["repo", "add", "x", join(root, "README.md")]).err).toContain("フォルダではありません");
    expect(p3(root, ["repo", "set", "infra", "readFirst=maybe"]).err).toContain("true か false");

    // ほかの人: 共有の定義はあるが、このマシンのパスが無い → 未登録として案内
    const otherHome = tempDir("p3-config-other-");
    expect(p3(root, ["project", "add", "other", join(root, ".p3")], {}, otherHome).code).toBe(0);
    expect(p3(root, ["--project", "other", "repo", "path", "app", root], {}, otherHome).code).toBe(0);
    const theirs = p3(root, ["--project", "other", "repo", "ls"], {}, otherHome);
    expect(theirs.out).toContain("未登録 → p3 repo path docs <このマシンのパス>");
    expect(p3(root, ["--project", "other", "repo", "path", "docs", join(docsRepo, "guide")], {}, otherHome).code).toBe(0);
    expect(p3(root, ["--project", "other", "repo", "ls", "--json"], {}, otherHome).json().find((r: any) => r.name === "docs").status).toBe("ok");

    // このマシンのパスだけ外す（共有は残る）・共有ごと消す
    p3(root, ["user-config", "set", "ui.theme=dark"]);
    expect(p3(root, ["repo", "rm", "infra", "--local"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().find((r: any) => r.name === "infra").status).toBe("unregistered");
    expect(p3(root, ["repo", "rm", "docs"]).code).toBe(0);
    expect(p3(root, ["repo", "ls", "--json"]).json().map((r: any) => r.name)).toEqual(["app", "infra"]);
    expect(readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8")).toContain("theme: dark"); // ほかの個人設定は残る
    // --dir で指しても読める（登録していないフォルダではパスの登録は案内）
    expect(p3(root, ["--dir", join(root, ".p3"), "repo", "ls", "--json"]).json().map((r: any) => r.name)).toEqual(["app", "infra"]);
  });
});

describe("Preflight の調べた範囲と根拠（p3 drafts）", () => {
  it("登録から Preflight（Mock）・drafts まで: 読んだ参照先・見ていない参照先・推測の根拠を出し、JSON にもある", async () => {
    const { root, rid } = await initialized();
    const docs = tempDir("docs-");
    expect(p3(root, ["repo", "add", "docs", docs, "role=ドキュメント"]).code).toBe(0);
    expect(p3(root, ["repo", "add", "infra", "role=基盤"]).code).toBe(0); // このマシンのパスなし
    const pf = p3(root, ["preflight", rid, "--engine", "mock"]);
    expect(pf.code, pf.err).toBe(0);
    const text = p3(root, ["drafts", rid]).out;
    expect(text).toContain("調べた範囲:");
    expect(text).toContain("✓ app（本体）  /workspace/app");
    expect(text).toContain("✕ infra（基盤）  このマシンのパスが登録されていません（p3 repo path infra <パス>）");
    expect(text).toContain("判断の根拠:");
    expect(text).toContain("推測      mock: 要望の本文の箇条書きからタスク案を作った（コードは読んでいない）");
    expect(text).toContain("→ このマシンのパスは p3 repo path <名前> <パス> で登録します");
    const json = p3(root, ["drafts", rid, "--json"]).json();
    expect(json.scope.map((s: any) => [s.name, s.status])).toEqual([["app", "ok"], ["docs", "ok"], ["infra", "unregistered"]]);
    expect(JSON.stringify(json.scope)).not.toContain(root); // このマシンのパスは入れない
    expect(json.assessment.evidence[0].kind).toBe("assumed");
  });
});

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

describe("p3 request の親子", () => {
  it("--parent で子を作り、ls --parent・show --brief --json で親子を読み、parent= で外す。規則に合わなければ 1", async () => {
    const { root, rid } = await initialized();
    const child = p3(root, ["request", "new", "送信基盤", "--parent", rid.slice(-5), "--json"]); // 短い書き方でもよい
    expect(child.code, child.err).toBe(0);
    const cid = child.json().id as string;
    expect(child.json().parent).toBe(rid);
    expect(p3(root, ["request", "ls", "--parent", rid, "--json"]).json().map((r: { id: string }) => r.id)).toEqual([cid]);
    const brief = p3(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(brief.children).toEqual([{ id: cid, title: "送信基盤", status: "draft", tasks: { total: 0, done: 0 } }]);
    expect(p3(root, ["request", "show", cid, "--brief", "--json"]).json()).toMatchObject({ parent: rid, ancestors: [{ id: rid }], item: { parent: rid } });
    expect(p3(root, ["request", "show", rid]).out).toContain("子の要望 (1)");
    // 循環・アーカイブ（子がある）は同じ規則で断る
    const cycle = p3(root, ["request", "set", rid, `parent=${cid}`]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("循環");
    const arch = p3(root, ["request", "archive", rid]);
    expect(arch.code).toBe(1);
    expect(arch.err).toContain(cid);
    const freed = p3(root, ["request", "set", cid, "parent=", "--json"]);
    expect(freed.code, freed.err).toBe(0);
    expect(freed.json().parent).toBeUndefined();
  });
});
