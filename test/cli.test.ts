import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { git, gitInit, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/pcube.mjs", import.meta.url));

/** 個人設定（~/.config/infodb-p3）はテストごとに分ける */
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

/** CLI を別プロセスで動かす。このマシンの PCUBE_* の環境変数（Codex の設定など）は効かないようにする */
function pcube(cwd: string, args: string[], env: Record<string, string> = {}, configHome = CONFIG_HOME) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PCUBE_")));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...base, XDG_CONFIG_HOME: configHome, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

async function repo() {
  const root = tempDir("pcube-cli-");
  gitInit(root);
  await mkdir(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# app\n");
  writeFileSync(join(root, "AGENTS.md"), "# rules\n");
  return root;
}

/** 初期化して要望を1つ作る */
async function initialized() {
  const root = await repo();
  const r = pcube(root, ["init", "--yes", "--description", "在庫管理", "--dir", ".pcube"]);
  expect(r.code, r.err).toBe(0);
  const req = pcube(root, ["request", "new", "通知機能", "--body", "- 送信基盤\n- 設定画面\n- 再送", "--json"]).json();
  return { root, rid: req.id as string };
}

describe("pcube init", () => {
  it("指定したフォルダにデータを作り、リポジトリの中身から既定値を推測する", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const r = pcube(join(root, "src"), ["init", "--yes", "--agents", "--dir", join(root, ".pcube")]);
    expect(r.code, r.err).toBe(0);
    const yaml = readFileSync(join(root, ".pcube", "project.yaml"), "utf8");
    expect(yaml).toContain(`name: ${root.split("/").at(-1)!.toLowerCase()}`);
    expect(yaml).toContain("repo: ..");
    expect(yaml).toMatch(/docs:\n {2}- docs\n {2}- README.md\n {2}- AGENTS.md/);
    expect(yaml).not.toContain("statuses"); // 列は固定なので書かない
    expect(existsSync(join(root, ".pcube", "requests"))).toBe(true);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("タスク管理（infodb p3）");
    expect(agents).toContain("status=resolved"); // 作業を終えたら対応済にする
    expect(agents).toContain("完了済（done）・見送り（rejected）とタスクの済み（check）は人が決める");
    expect(pcube(root, ["init", "--yes", "--dir", ".pcube"]).code).toBe(1); // 2回目は拒む
    expect(pcube(root, ["init", "--yes"]).err).toContain("データを置くフォルダを指定"); // フォルダは必須
  });
});

describe("p3 init --agents（AI 向けの指示とスキル）", () => {
  const SKILL = fileURLToPath(new URL("../skills/p3/SKILL.md", import.meta.url));
  const placed = (root: string) => join(root, ".claude", "skills", "p3", "SKILL.md");

  it("新しく作るときに、AGENTS.md へ追記してスキルを置く。もう一度でも重ねない", async () => {
    const root = await repo();
    const r = pcube(root, ["init", "--yes", "--agents", "--dir", ".pcube"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("AI 向けのスキルを .claude/skills/p3/SKILL.md に置きました");
    expect(readFileSync(placed(root), "utf8")).toBe(readFileSync(SKILL, "utf8"));

    // 別の人が同じデータに参加する（同じリポジトリの別のチェックアウト）。指示は重ねず、スキルは最新のまま
    const again = pcube(root, ["init", "--yes", "--agents", "--project", "same", "--dir", ".pcube"], {}, tempDir("p3-config-"));
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("参加しました");
    expect(again.out).toContain("は最新です");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8").split("タスク管理（infodb p3）")).toHaveLength(2);
  });

  it("参加のときも置き、手で直したスキルは上書きせずに案内する", async () => {
    const root = await repo();
    expect(pcube(root, ["init", "--yes", "--dir", ".pcube"]).code).toBe(0);
    await mkdir(join(root, ".claude", "skills", "p3"), { recursive: true });
    writeFileSync(placed(root), "# 自分で直したスキル\n");
    const r = pcube(root, ["init", "--yes", "--agents", "--project", "joined", "--dir", ".pcube"], {}, tempDir("p3-config-"));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("上書きしません");
    expect(readFileSync(placed(root), "utf8")).toBe("# 自分で直したスキル\n");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("タスク管理（infodb p3）");
  });

  it("CLAUDE.md だけがあればそちらに追記する", async () => {
    const root = await repo();
    rmSync(join(root, "AGENTS.md"));
    writeFileSync(join(root, "CLAUDE.md"), "# claude\n");
    expect(pcube(root, ["init", "--yes", "--agents", "--dir", ".pcube"]).code).toBe(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("タスク管理（infodb p3）");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });

  it("--agents が無ければ（非対話では）何も置かない", async () => {
    const root = await repo();
    expect(pcube(root, ["init", "--yes", "--dir", ".pcube"]).code).toBe(0);
    expect(existsSync(placed(root))).toBe(false);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# rules\n");
  });
});

describe("pcube request", () => {
  it("要望は日付-乱数のフォルダになり、一部の ID でも指せる", async () => {
    const { root, rid } = await initialized();
    expect(rid).toMatch(/^\d{6}-[0-9a-z]{5}$/);
    expect(existsSync(join(root, ".pcube", "requests", rid, "request.md"))).toBe(true);
    expect(pcube(root, ["request", "ls", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(pcube(root, ["request", "set", rid.slice(-5), "status=active"]).code).toBe(0);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
    expect(pcube(root, ["request", "set", rid, "status=accepted"]).err).toContain("要望のステータス");
  });
});

describe("pcube のタスク操作（--req で要望を指定）", () => {
  it("作成・一覧・更新・移動・関係・アーカイブ", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    expect(pcube(root, ["new", "API の認証", "--area", "src/api", ...r]).out).toContain(`${rid}/T001`);
    // 本文が - で始まっても受け取れる
    expect(pcube(root, ["new", "通知", "--body", "- 箇条書き", ...r]).code).toBe(0);
    expect(readFileSync(join(root, ".pcube", "requests", rid, "tasks", "T002.md"), "utf8")).toContain("- 箇条書き");

    expect(pcube(root, ["link", "T2", "depends_on", "T1", "--note", "認証が先", ...r]).code).toBe(0);
    const cycle = pcube(root, ["link", "1", "depends_on", "2", ...r]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("循環");

    expect(pcube(root, ["move", "T2", "doing", ...r]).code).toBe(0);
    expect(pcube(root, ["move", "2", "in_progress", ...r]).err).toContain("ステータスは");
    expect(pcube(root, ["set", "1", "labels=a,b", "outputs=docs/a.md", ...r]).code).toBe(0);
    expect(pcube(root, ["set", "1", "outputs=", ...r]).code).toBe(0);
    expect(pcube(root, ["set", "1", "due=2026-10-20", ...r]).err).toContain("変更できるキー"); // 予定の日付は持たない

    const ls = pcube(root, ["ls", "--status", "todo", "--json", ...r]).json();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ id: "T001", labels: ["a", "b"], outputs: [] });
    // 作業中にした日時は記録される
    expect(pcube(root, ["show", "T2", "--json", ...r]).json().item.startedAt).toBeTruthy();

    const show = pcube(root, ["show", "T1", "--json", ...r]).json();
    expect(show.graph.incoming).toEqual([expect.objectContaining({ from: `${rid}/T002`, type: "depends_on" })]);
    expect(show.graph.impactScope).toEqual([`${rid}/T002`]);
    // 「相手の役割 + 相手」で見せる: T002 → depends_on → T001 なら、T001 には「依存元 T002」、T002 には「依存先 T001」
    expect(pcube(root, ["show", "T1", ...r]).out).toMatch(/← 依存元 +T002/);
    expect(pcube(root, ["show", "T2", ...r]).out).toMatch(/→ 依存先 +T001/);
    expect(pcube(root, ["help"]).out).toContain("depends_on    依存する（相手が先に終わっている必要がある）  →「依存先」/ 逆「依存元」");
    expect(pcube(root, ["find", "通知", "--json", ...r]).json().candidates.map((c: any) => c.ref)).toContain(`${rid}/T002`);
    expect(pcube(root, ["impact", "1", "--json", ...r]).json()).toEqual([`${rid}/T002`]);

    expect(pcube(root, ["archive", "2", ...r]).code).toBe(0);
    expect(pcube(root, ["show", "T2", ...r]).code).toBe(2); // アーカイブしたら見つからない
  });

  it("move --output で成果物（PR の URL など）を足す。全要望の一覧と進捗", async () => {
    const { root, rid } = await initialized();
    pcube(root, ["new", "A", "--req", rid]);
    pcube(root, ["new", "B", "--req", rid]);
    const done = pcube(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--req", rid], { PCUBE_ACTOR: "ai:claude" });
    expect(done.code, done.err).toBe(0);
    const t = pcube(root, ["show", `${rid}/T1`, "--json"]).json().item;
    expect(t).toMatchObject({ status: "done", outputs: ["https://example.com/pull/7"], updatedBy: "ai:claude" });
    // 人が確認して「済み」にする（完了前のタスクは拒む）
    expect(pcube(root, ["check", "T2", "--req", rid]).err).toContain("まだ完了していません");
    expect(pcube(root, ["check", "T1", "--req", rid]).code).toBe(0);
    expect(pcube(root, ["show", `${rid}/T1`, "--json"]).json().item.checkedAt).toBeTruthy();
    expect(pcube(root, ["check", "T1", "--off", "--req", rid]).code).toBe(0);
    expect(pcube(root, ["show", `${rid}/T1`, "--json"]).json().item.checkedAt).toBeUndefined();
    expect(pcube(root, ["ls", "--all", "--json"]).json()).toHaveLength(2);
    const progress = pcube(root, ["progress", "--json"]).json();
    expect(progress[0]).toMatchObject({ total: 2, done: 1, counts: { todo: 1, doing: 0, done: 1 } });
    expect(pcube(root, ["progress"]).out).toContain("1/2");
  });

  it("終了コード: 競合は 3、見つからないは 2、使い方の誤りは 1。要望が決まらなければ案内する", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    pcube(root, ["new", "A", ...r]);
    pcube(root, ["set", "1", "labels=x", ...r]);
    const conflict = pcube(root, ["move", "1", "done", "--rev", "1", ...r]);
    expect(conflict.code).toBe(3);
    expect(conflict.err).toContain("競合");
    expect(pcube(root, ["move", "1", "done", "--rev", "2", ...r]).code).toBe(0);
    expect(pcube(root, ["move", "99", "done", ...r]).code).toBe(2);
    expect(pcube(root, ["show", "T099", ...r]).code).toBe(2); // show は語句でも探す。何も当たらなければ 2
    expect(pcube(root, ["nope"]).code).toBe(1);
    expect(pcube(root, ["set", "1", "color=red", ...r]).err).toContain("変更できるキー");
    const noReq = pcube(root, ["new", "どこに？"]);
    expect(noReq.code).toBe(1);
    expect(noReq.err).toContain("要望を指定");
  });

  it("プロジェクトが無ければ init を案内する", async () => {
    const root = await repo();
    const r = pcube(root, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("p3 init --project");
  });
});

describe("要望の作業ツリー", () => {
  it("要望のブランチ・作業ツリーの中では要望の指定を省け、書き込みはメインの .pcube/ に行く", async () => {
    const { root, rid } = await initialized();
    const run = pcube(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    pcube(root, ["accept", rid]);
    const branch = pcube(root, ["request", "show", rid, "--json"]).json().item.workstream.branch;
    expect(branch).toBe(`req/${rid}`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pcube");
    const wt = join(root, ".worktrees", rid);
    git(root, "worktree", "add", "-q", wt, "-b", branch);

    // AI が作業ツリーで作業している想定
    const ai = { PCUBE_ACTOR: "ai:claude" };
    expect(pcube(wt, ["whoami", "--json"], ai).json()).toMatchObject({ actor: "ai:claude", request: rid });
    expect(pcube(wt, ["move", "T1", "doing"], ai).code).toBe(0);
    const added = pcube(wt, ["new", "作業中に見つかった追加の作業", "--json"], ai).json();
    expect(added.ref).toBe(`${rid}/T004`);
    expect(readFileSync(join(root, ".pcube", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: doing");
    expect(existsSync(join(root, ".pcube", "requests", rid, "tasks", "T004.md"))).toBe(true);
    // 作業ツリーの .pcube/ はブランチ時点の写しのまま
    expect(readFileSync(join(wt, ".pcube", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: todo");
    expect(existsSync(join(wt, ".pcube", "requests", rid, "tasks", "T004.md"))).toBe(false);

    // `pnpm --dir <p3 の場所> pcube ...` で呼ばれたとき（pnpm がカレントを p3 の場所に移し、元の場所は INIT_CWD）
    const viaPnpm = { ...ai, npm_lifecycle_event: "pcube", npm_package_name: "@infodb/p3", INIT_CWD: wt };
    expect(pcube(fileURLToPath(new URL("..", import.meta.url)), ["whoami", "--json"], viaPnpm).json()).toMatchObject({ actor: "ai:claude", request: rid });
    // 利用者のパッケージの "p3" スクリプトから呼ばれたとき（pnpx・npm exec も）は、今の場所のまま
    const viaUserScript = { ...ai, npm_lifecycle_event: "p3", npm_package_name: "myapp", INIT_CWD: tempDir() };
    expect(pcube(wt, ["whoami", "--json"], viaUserScript).json()).toMatchObject({ request: rid });
  });
});

describe("pcube preflight / drafts / accept", () => {
  it("mock エンジンで評価し、一部を除いてタスク化する", async () => {
    const { root, rid } = await initialized();
    const run = pcube(root, ["preflight", rid, "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(run.json()).toMatchObject({ status: "completed", engine: "mock" });
    expect(pcube(root, ["drafts", rid]).out).toContain("D3");

    const accepted = pcube(root, ["accept", rid, "--skip", "d3", "--json"]).json();
    expect(accepted).toMatchObject({ archived: [], kept: [] });
    expect(accepted.tasks.map((t: any) => [t.id, t.title])).toEqual([
      ["T001", "送信基盤"],
      ["T002", "設定画面"],
    ]);
    expect(accepted.tasks[1].relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });
});

describe("マシンごとの設定（環境変数と個人設定。.env は読まない）", () => {
  const configFile = () => join(CONFIG_HOME, "infodb-p3", "config.yaml");
  const appendConfig = (text: string) => writeFileSync(configFile(), `${readFileSync(configFile(), "utf8")}${text}`);

  it("個人設定の preflight.engine: mock で Mock になり、無ければ Codex が使えない理由で失敗する（Mock にしない）", async () => {
    const { root, rid } = await initialized();
    const codex = pcube(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(codex.code).not.toBe(0);
    expect(codex.out + codex.err).not.toContain('"engine": "mock"');

    appendConfig("preflight:\n  engine: mock\n");
    const mock = pcube(root, ["preflight", rid, "--json"]);
    expect(mock.code, mock.err).toBe(0);
    expect(mock.json()).toMatchObject({ status: "completed", engine: "mock" });
  });

  it("パッケージやプロジェクトに .env があっても読まない", async () => {
    const { root, rid } = await initialized();
    writeFileSync(join(root, ".env"), "PCUBE_PREFLIGHT_ENGINE=mock\n");
    writeFileSync(join(root, ".pcube", ".env"), "PCUBE_PREFLIGHT_ENGINE=mock\n");
    const r = pcube(root, ["preflight", rid, "--json"], { DOCKER_HOST: "unix:///nonexistent.sock" });
    expect(r.code).not.toBe(0);
    expect(readFileSync(new URL("../src/server/context.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
    expect(readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8")).not.toContain("loadEnvFile");
  });

  it("読めない設定は、直す場所を示して終了コード 1", async () => {
    const { root } = await initialized();
    const env = pcube(root, ["request", "ls"], { PCUBE_CODEX_PATH_MAP: "/workspaces" });
    expect(env.code).toBe(1);
    expect(env.err).toMatch(/設定: 環境変数 PCUBE_CODEX_PATH_MAP の「\/workspaces」が読めません/);
    appendConfig("serve:\n  port: web\n");
    const cfg = pcube(root, ["whoami"]);
    expect(cfg.code).toBe(1);
    expect(cfg.err).toContain("個人設定 serve.port");
    // 個人設定のプロジェクトの一覧・登録は、マシンの設定が読めなくても使える
    expect(pcube(root, ["project", "ls"]).code).toBe(0);
  });

  it("init・project add / rm で個人設定を書いても、マシンの設定は残る", async () => {
    const { root } = await initialized();
    appendConfig("codex:\n  pathMap:\n    /workspaces: /home/me/workspaces\n  ensureImage: false\n");
    const other = await repo();
    expect(pcube(other, ["init", "--yes", "--project", "other", "--dir", join(other, ".pcube")]).code).toBe(0);
    expect(pcube(root, ["project", "rm", "other"]).code).toBe(0);
    expect(pcube(other, ["project", "add", "other", join(other, ".pcube")]).code).toBe(0);
    const text = readFileSync(configFile(), "utf8");
    expect(text).toContain("/workspaces: /home/me/workspaces");
    expect(text).toContain("ensureImage: false");
  });
});

describe("pcube preflight --note / notes", () => {
  it("メモだけ書き足し、一覧で渡すものを確かめ、次の Preflight で引き継ぐ", async () => {
    const { root, rid } = await initialized();
    expect(pcube(root, ["preflight", rid, "--note-only"]).err).toContain("--note");
    expect(pcube(root, ["preflight", rid, "--note", " ", "--note-only"]).err).toContain("空");
    const first = pcube(root, ["preflight", rid, "--engine", "mock", "--json"]).json();

    const note = pcube(root, ["preflight", rid, "--note", "- 再送は不要", "--note-only", "--json"], { PCUBE_ACTOR: "human:a" });
    expect(note.code, note.err).toBe(0);
    expect(note.json()).toMatchObject({ body: "- 再送は不要", createdBy: "human:a" });
    const notes = pcube(root, ["notes", rid, "--json"]).json();
    expect(notes).toMatchObject({ previous: first.id, notes: [{ id: note.json().id, pending: true }] });
    expect(pcube(root, ["notes", rid]).out).toContain(`前回 ${first.id} を引き継ぐ・メモ 1 件を渡す`);

    const second = pcube(root, ["preflight", rid, "--engine", "mock", "--note", "設定画面は後回し"]);
    expect(second.code, second.err).toBe(0);
    expect(second.err).toContain("を書き足しました");
    expect(second.out).toContain(`引き継ぎ: 前回 ${first.id} / メモ `);
    expect(pcube(root, ["notes", rid, "--json"]).json().notes.map((n: any) => n.pending)).toEqual([false, false]);
  });
});

describe("show --brief（作業に要る項目だけ）", () => {
  /**
   * T001 done・T002 doing（← T001）・T003 todo（← T002・別の要望のタスク・別の要望・アーカイブした T004）、
   * T005 が T001 を置き換え、要望も T001 を置き換える
   */
  async function prepared() {
    const { root, rid } = await initialized();
    const other = pcube(root, ["request", "new", "別の要望", "--json"]).json().id as string;
    pcube(root, ["new", "別の要望のタスク", "--req", other]);
    for (const t of ["下準備", "本体", "仕上げ", "消す予定", "新しい方式"]) pcube(root, ["new", t, "--req", rid, "--body", `${t}の作業内容\n\n## 完了条件\n- できる`]);
    pcube(root, ["move", "T001", "done", "--req", rid, "--output", "https://example.com/pull/1"]);
    pcube(root, ["move", "T002", "doing", "--req", rid]);
    for (const [from, to] of [["T002", "T001"], ["T003", "T002"], ["T003", `${other}/T001`], ["T003", other], ["T003", "T004"]]) {
      const r = pcube(root, ["link", from, "depends_on", to, "--req", rid]);
      expect(r.code, r.err).toBe(0);
    }
    pcube(root, ["link", "T003", "relates_to", "T005", "--req", rid]);
    pcube(root, ["link", "T005", "supersedes", "T001", "--req", rid, "--note", "新しい方式に替える"]);
    pcube(root, ["archive", "T004", "--req", rid]);
    const reqFile = join(root, ".pcube", "requests", rid, "request.md");
    writeFileSync(reqFile, readFileSync(reqFile, "utf8").replace(/^---\n/, `---\nrelations:\n  - { type: supersedes, target: T001 }\n`));
    return { root, rid, other };
  }

  it("タスク: 本文・依存とその状態（見つからないものは null）・置き換えの注意・成果物・rev を残し、ほかを省く", async () => {
    const { root, rid, other } = await prepared();
    const full = pcube(root, ["show", "T003", "--req", rid, "--json"]).json();
    const brief = pcube(root, ["show", "T003", "--req", rid, "--brief", "--json"]);
    expect(brief.code, brief.err).toBe(0);
    const b = brief.json();
    expect(Object.keys(b)).toEqual(["item", "superseded", "dependencies", "warnings"]);
    expect(Object.keys(b.item)).toEqual(["id", "ref", "request", "title", "status", "body", "rev", "outputs", "relations"]);
    for (const k of Object.keys(b.item)) if (k !== "relations") expect(b.item[k]).toEqual(full.item[k]);
    expect(b.item.body).toContain("## 完了条件");
    // 依存だけ（関係しそうな相手・relates_to は省く）。type / target は元のまま
    expect(b.item.relations.map((r: any) => [r.type, r.target])).toEqual([
      ["depends_on", "T002"],
      ["depends_on", `${other}/T001`],
      ["depends_on", other],
      ["depends_on", "T004"],
    ]);
    const deps = [
      { ref: `${rid}/T002`, title: "本体", status: "doing" },
      { ref: `${other}/T001`, title: "別の要望のタスク", status: "todo" },
      { ref: other, title: "別の要望", status: "draft" },
      { ref: `${rid}/T004`, title: null, status: null }, // アーカイブした: 状態不明（完了とは扱わない）
    ];
    expect(b.dependencies).toEqual(deps);
    expect(full.dependencies).toEqual(deps); // 通常の --json にも同じ項目
    expect(b).not.toHaveProperty("graph");
    expect(b).not.toHaveProperty("file");
    expect(b.item).not.toHaveProperty("createdAt");

    const text = pcube(root, ["show", "T003", "--req", rid, "--brief"]).out;
    expect(text).toContain("依存    T002 doing / " + `${other}/T001 todo / ${other} draft / T004 （状態不明）`);
    expect(text).toContain("仕上げの作業内容");
    expect(text).not.toContain("関係しそう");
    expect(text).not.toContain("影響範囲");
    expect(text).not.toContain("ファイル:");
    expect(text.length).toBeLessThan(pcube(root, ["show", "T003", "--req", rid]).out.length);

    // 依存なし・完了・成果物
    const done = pcube(root, ["show", "T001", "--req", rid, "--brief", "--json"]).json();
    expect(done.item).toMatchObject({ status: "done", outputs: ["https://example.com/pull/1"], relations: [] });
    expect(done.dependencies).toEqual([]);
  });

  it("置き換え: タスクから・要望からの複数の印と警告を、通常・短い出力で同じ形で出す", async () => {
    const { root, rid } = await prepared();
    const superseded = [{ from: rid }, { from: `${rid}/T005`, note: "新しい方式に替える" }];
    const warnings = [{ code: "superseded", target: `${rid}/T001`, from: [rid, `${rid}/T005`], message: expect.stringContaining("置き換えられています") }];
    for (const extra of [[], ["--brief"]]) {
      const j = pcube(root, ["show", "T001", "--req", rid, ...extra, "--json"]).json();
      expect(j.superseded).toEqual(superseded);
      expect(j.warnings).toEqual(warnings);
    }
    expect(pcube(root, ["show", "T001", "--req", rid, "--brief"]).out).toContain("※ 261");
    // 着手の警告（move）は今までどおり
    expect(pcube(root, ["move", "T002", "doing", "--req", rid, "--json"]).json().warnings).toBeUndefined();
  });

  it("要望: 本文・状態・ブランチ・タスクの一覧（id・ref・title・status）と issue。show <要望> と request show は同じ", async () => {
    const { root, rid } = await prepared();
    // 未完了のタスクがあるのに対応済（ファイルを人が直したなど。CLI からはこの状態にできない）
    const reqFile = join(root, ".pcube", "requests", rid, "request.md");
    writeFileSync(reqFile, readFileSync(reqFile, "utf8").replace(/^status: \w+$/m, "status: resolved"));
    const full = pcube(root, ["request", "show", rid, "--json"]).json();
    const b = pcube(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(Object.keys(b)).toEqual(["item", "tasks", "issue"]);
    expect(Object.keys(b.item)).toEqual(["id", "title", "status", "body", "rev"]); // ブランチが無い要望は workstream を出さない
    for (const k of Object.keys(b.item)) expect(b.item[k]).toEqual(full.item[k]);
    expect(b.tasks).toEqual(full.tasks.map((t: any) => ({ id: t.id, ref: t.ref, title: t.title, status: t.status })));
    expect(b.issue).toBe(full.issue);
    expect(pcube(root, ["show", rid, "--brief", "--json"]).json()).toEqual(b);
    // 今の要望を省略しても同じ
    expect(pcube(root, ["request", "show", "--req", rid, "--brief", "--json"]).json()).toEqual(b);
    const text = pcube(root, ["request", "show", rid, "--brief"]).out;
    expect(text).toMatch(/^※ 対応済ですが/);
    expect(text).toContain("タスク (4):");
    expect(text).not.toContain("関係:");
  });

  it("ブランチのある要望は workstream を残し、曖昧な指定・見つからない指定は今までどおり", async () => {
    const { root, rid } = await initialized();
    pcube(root, ["preflight", rid, "--engine", "mock"]);
    pcube(root, ["accept", rid]);
    const b = pcube(root, ["request", "show", rid, "--brief", "--json"]).json();
    expect(b.item.workstream.branch).toMatch(/^req\//);
    expect(pcube(root, ["request", "show", rid, "--brief"]).out).toContain(`branch ${b.item.workstream.branch}`);
    expect(pcube(root, ["show", "存在しない語句", "--brief"]).code).toBe(2);
  });
});

describe("置き換えられたタスク", () => {
  /** 初回のタスク化（T001〜T003）の後に再評価し、新しい案 D1 が T001・T002 を置き換えると書かれた状態を作る */
  async function reassessed() {
    const { root, rid } = await initialized();
    pcube(root, ["preflight", rid, "--engine", "mock"]);
    pcube(root, ["accept", rid]);
    pcube(root, ["move", "T002", "doing", "--req", rid]);
    const run = pcube(root, ["preflight", rid, "--engine", "mock", "--json"]).json();
    expect(run, JSON.stringify({ status: run.status, error: run.error, log: run.log?.slice(-3) })).toMatchObject({ status: "completed" });
    const dir = join(root, ".pcube", "requests", rid, "preflight", run.id);
    const d1 = join(dir, "drafts", "D1.md");
    writeFileSync(d1, readFileSync(d1, "utf8").replace("include: true", "relations:\n  - { type: supersedes, target: T001 }\n  - { type: supersedes, target: T002 }\ninclude: true"));
    const runJson = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    runJson.assessment.impacts = [{ target: `${rid}/T003`, type: "supersedes", reason: "評価での置き換え", confidence: 0.9 }];
    writeFileSync(join(dir, "run.json"), JSON.stringify(runJson));
    return { root, rid };
  }

  it("タスク化の前に候補を見せ、フラグが無ければ残して印を付け、着手すると警告する", async () => {
    const { root, rid } = await reassessed();
    expect(pcube(root, ["drafts", rid, "--json"]).json().supersedes.map((c: any) => [c.id, c.status])).toEqual([
      ["T001", "todo"],
      ["T002", "doing"],
      ["T003", "todo"],
    ]);
    // D2・D3 を外しても D1 の置き換えと評価の置き換えは残る
    const accepted = pcube(root, ["accept", rid, "--only", "D1"]);
    expect(accepted.code, accepted.err).toBe(0);
    expect(accepted.out).toContain("置き換えられるタスクを残しました");
    const ls = pcube(root, ["ls", "--req", rid, "--json"]).json();
    expect(ls.map((t: any) => [t.id, (t.superseded ?? []).map((m: any) => m.from)])).toEqual([
      ["T001", [`${rid}/T004`]],
      ["T002", [`${rid}/T004`]],
      ["T003", [rid]], // 評価にだけあった置き換えは要望単位
      ["T004", []],
    ]);
    expect(pcube(root, ["ls", "--req", rid]).out).toMatch(/T001 .*※置換 ← T004/);
    expect(pcube(root, ["ls", "--all"]).out).toContain("※置換");
    expect(pcube(root, ["show", "T003", "--req", rid]).out).toContain(`※ 置き換えられています: ${rid}（評価での置き換え）`);
    expect(pcube(root, ["show", "T001", "--req", rid, "--json"]).json().superseded).toEqual([{ from: `${rid}/T004` }]);

    // 着手は止めずに警告する。--json の stdout は JSON のまま、warnings で返す
    const moved = pcube(root, ["move", "T001", "doing", "--req", rid, "--json"]);
    expect(moved.code).toBe(0);
    expect(moved.err).toContain("警告: ");
    expect(moved.json()).toMatchObject({ status: "doing", warnings: [{ code: "superseded", target: `${rid}/T001`, from: [`${rid}/T004`] }] });
    // 作業中のままの再指定や、置き換えられていないタスクでは出さない
    expect(pcube(root, ["move", "T001", "doing", "--req", rid, "--json"]).json().warnings).toBeUndefined();
    expect(pcube(root, ["move", "T004", "doing", "--req", rid]).err).not.toContain("警告");
    expect(pcube(root, ["set", "T003", "status=doing", "--req", rid]).err).toContain("警告");
  });

  it("--archive-superseded で確定時点の候補をアーカイブする", async () => {
    const { root, rid } = await reassessed();
    const r = pcube(root, ["accept", rid, "--only", "d1", "--archive-superseded", "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ tasks: [{ id: "T004" }], archived: ["T001", "T002", "T003"], kept: [] });
    expect(pcube(root, ["ls", "--req", rid, "--json"]).json().map((t: any) => t.id)).toEqual(["T004"]);
    // 最大番号をアーカイブしても番号は再利用しない
    pcube(root, ["archive", "T004", "--req", rid]);
    expect(pcube(root, ["new", "次の作業", "--req", rid, "--json"]).json().id).toBe("T005");
  });
});

describe("要望の対応済", () => {
  it("全タスクを完了したら対応済にでき、未完了のタスクができたら進行中に戻す", async () => {
    const { root, rid } = await initialized();
    pcube(root, ["preflight", rid, "--engine", "mock"]);
    pcube(root, ["accept", rid]);
    const ng = pcube(root, ["request", "set", rid, "status=resolved"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("完了していないタスクがあります: T001(todo), T002(todo), T003(todo)");
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");

    for (const t of ["T001", "T002", "T003"]) pcube(root, ["move", t, "done", "--req", rid]);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active"); // 自動では対応済にしない
    const ok = pcube(root, ["request", "set", rid, "status=resolved", "--json"], { PCUBE_ACTOR: "ai:claude" });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.json()).toMatchObject({ status: "resolved", updatedBy: "ai:claude" });
    expect(pcube(root, ["request", "ls", "--status", "resolved", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(pcube(root, ["progress"]).out).toContain("resolved"); // 既定の一覧に残る（確認待ち）

    const back = pcube(root, ["move", "T002", "doing", "--req", rid, "--json"]);
    expect(back.err).toContain("進行中に戻しました");
    expect(back.json().reopened).toBe(rid);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
  });
});

describe("pcube milestone と要望の管理項目", () => {
  it("マイルストーンを作り、要望に期限・マイルストーン・タグを付け、進捗をマイルストーンごとにまとめる", async () => {
    const { root, rid } = await initialized();
    expect(pcube(root, ["milestone", "add", "v0.2", "--title", "要望単位の運用", "--due", "2026-11-30"]).code).toBe(0);
    expect(pcube(root, ["milestone", "add", "v0.2"]).err).toContain("既にあります");
    expect(pcube(root, ["request", "set", rid, "milestone=nope"]).err).toContain("マイルストーンがありません");
    expect(pcube(root, ["request", "set", rid, "milestone=v0.2", "due=2026-11-15", "tags=ui,feature"]).code).toBe(0);
    const other = pcube(root, ["request", "new", "別の要望", "--tag", "bug", "--json"]).json();
    expect(other.tags).toEqual(["bug"]);
    expect(pcube(root, ["request", "ls", "--milestone", "v0.2", "--json"]).json().map((r: any) => r.id)).toEqual([rid]);
    expect(pcube(root, ["request", "ls", "--tag", "bug", "--json"]).json().map((r: any) => r.id)).toEqual([other.id]);
    const text = pcube(root, ["progress"]).out;
    expect(text).toContain("■ 要望単位の運用（v0.2 · 2026-11-30）");
    expect(text).toContain("■ マイルストーンなし");
    expect(pcube(root, ["milestone", "rm", "v0.2"]).err).toContain("使っている要望があります");
    expect(pcube(root, ["milestone", "set", "v0.2", "--done"]).code).toBe(0);
    expect(pcube(root, ["milestone", "--json"]).json()).toEqual([{ id: "v0.2", title: "要望単位の運用", due: "2026-11-30", done: true }]);
  });
});

describe("pcube config", () => {
  it("設定を変え、project.yaml に書く", async () => {
    const { root } = await initialized();
    expect(pcube(root, ["config", "set", "description=経費精算", "docs=docs,README.md", "instructions=個人情報に注意"]).code).toBe(0);
    expect(pcube(root, ["config", "set", "branchPattern=feature"]).err).toContain("{id}");
    expect(pcube(root, ["config", "--json"]).json()).toMatchObject({
      description: "経費精算",
      docs: ["docs", "README.md"],
      preflight: { instructions: "個人情報に注意" },
    });
  });
});

describe("個人設定のプロジェクト（データはリポジトリの外）", () => {
  it("init で外のフォルダに作って登録し、以後はリポジトリの中・作業ツリー・プロジェクト名で決まる", async () => {
    const app = await repo();
    const pcubeData = join(tempDir("p3-assets-"), "pcube");
    const r = pcube(join(app, "docs"), ["init", "--yes", "--project", "pcube", "--dir", pcubeData]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(pcubeData, "project.yaml"))).toBe(true);
    expect(existsSync(join(app, ".pcube"))).toBe(false);
    expect(readFileSync(join(pcubeData, "project.yaml"), "utf8")).not.toContain("repo:"); // 手元の場所は共有するデータに書かない
    const cfg = readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8");
    expect(cfg).toContain(`dir: ${pcubeData}`);
    expect(cfg).toContain(`main: ${app}`);

    // 2つめのプロジェクト
    const other = await repo();
    const otherData = join(tempDir("p3-some-"), "other");
    expect(pcube(other, ["init", "--yes", "--project", "other", "--dir", otherData]).code).toBe(0);

    // リポジトリの中なら、そのプロジェクト
    expect(pcube(join(app, "docs"), ["whoami", "--json"]).json()).toMatchObject({ project: "pcube", dataDir: pcubeData, repo: app });
    expect(pcube(other, ["whoami", "--json"]).json()).toMatchObject({ project: "other", dataDir: otherData });
    // データのフォルダの中でも
    expect(pcube(pcubeData, ["whoami", "--json"]).json().project).toBe("pcube");
    // 関係ない場所では決まらず、選び方を案内する。--project で選べる
    const nowhere = tempDir();
    const ng = pcube(nowhere, ["ls"]);
    expect(ng.code).toBe(1);
    expect(ng.err).toContain("p3 --project <名前>");
    expect(ng.err).toContain(pcubeData);
    expect(pcube(nowhere, ["whoami", "--json", "--project", "other"]).json().project).toBe("other");
    expect(pcube(nowhere, ["whoami", "--project", "nope"]).err).toContain("登録されていません");

    // 要望を作り、要望の作業ツリーの中からでも決まる（作業ツリーはリポジトリの外に置いてもよい）
    const rid = pcube(app, ["request", "new", "通知", "--json"]).json().id as string;
    expect(existsSync(join(pcubeData, "requests", rid, "request.md"))).toBe(true);
    git(app, "add", "-A");
    git(app, "commit", "-qm", "x");
    const wt = join(tempDir("p3-wt-"), rid);
    git(app, "worktree", "add", "-q", wt, "-b", `req/${rid}`);
    expect(pcube(wt, ["whoami", "--json"]).json()).toMatchObject({ project: "pcube", request: rid });

    // 一覧（今いる場所のプロジェクトに *）・登録を外す
    expect(pcube(app, ["project"]).out).toMatch(/^\* pcube/m);
    expect(pcube(nowhere, ["project", "rm", "other"]).code).toBe(0);
    // 登録が1つだけなら、どこからでもそれ
    expect(pcube(nowhere, ["whoami", "--json"]).json().project).toBe("pcube");
  });

  it("既にあるデータのフォルダを指すと、作らずに参加だけする（別の人・別のマシンの想定）", async () => {
    const data = join(tempDir("p3-assets-"), "shared");
    const first = await repo();
    expect(pcube(first, ["init", "--yes", "--project", "shared", "--dir", data, "--description", "共有"]).code).toBe(0);
    const before = readFileSync(join(data, "project.yaml"), "utf8");

    // 別の人: 個人設定は空、リポジトリは別の場所に clone した
    CONFIG_HOME = tempDir("p3-config-");
    const clone = await repo();
    const r = pcube(clone, ["init", "--yes", "--project", "shared", "--dir", data]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("参加しました");
    expect(readFileSync(join(data, "project.yaml"), "utf8")).toBe(before);
    // 手元のリポジトリは個人設定のものを使う
    expect(pcube(clone, ["whoami", "--json"]).json()).toMatchObject({ project: "shared", repo: clone });

    // init せずに登録だけ（リポジトリを指定）
    CONFIG_HOME = tempDir("p3-config-");
    expect(pcube(tempDir(), ["project", "add", "shared", data, "--repo", clone]).code).toBe(0);
    expect(pcube(clone, ["whoami", "--json"]).json().project).toBe("shared");
    expect(pcube(tempDir(), ["project", "add", "x", tempDir()]).err).toContain("まだ p3 のプロジェクトではありません");
  });
});

describe("タグ（外部 ID・分類）", () => {
  it("--tag は値ごと（カンマで分けない）。request set --tag で置き換え、tags= はカンマで分ける。両方は使えない", async () => {
    const { root, rid } = await initialized();
    const made = pcube(root, ["request", "new", "外部 ID つき", "--tag", "jira:PROJ-123", "--tag", " group:顧客A ", "--tag", "a,b", "--tag", "jira:PROJ-123", "--tag", " ", "--json"]).json();
    expect(made.tags).toEqual(["jira:PROJ-123", "group:顧客A", "a,b"]);
    const set = pcube(root, ["request", "set", rid, "--tag", "release/2026Q4", "--tag", "顧客 A, 東京", "--json"]);
    expect(set.code, set.err).toBe(0);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["release/2026Q4", "顧客 A, 東京"]);
    expect(pcube(root, ["request", "set", rid, "tags=x, y"]).code).toBe(0);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual(["x", "y"]);
    const both = pcube(root, ["request", "set", rid, "tags=x", "--tag", "y"]);
    expect(both.code).not.toBe(0);
    expect(both.err).toContain("一緒に使えません");
    expect(pcube(root, ["request", "set", rid, "tags="]).code).toBe(0);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.tags).toEqual([]);
    // 繰り返した --tag はどれか（完全一致）
    expect(pcube(root, ["request", "ls", "--tag", "a,b", "--tag", "nothing", "--json"]).json().map((r: any) => r.id)).toEqual([made.id]);
    expect(pcube(root, ["request", "ls", "--tag", "JIRA:PROJ-123", "--json"]).json()).toEqual([]);
  });
});
