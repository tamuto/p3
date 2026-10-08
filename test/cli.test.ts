import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, gitInit, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/pcube.mjs", import.meta.url));

/** CLI を別プロセスで動かす。マシンの .env にある Codex の設定などは効かないようにする */
function pcube(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PCUBE_CODEX_AUTH_VOLUME: "", PCUBE_CODEX_AUTH_FILE: "", PCUBE_DATA_DIR: "", PCUBE_ACTOR: "", PCUBE_REQUEST: "", ...env },
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
  const r = pcube(root, ["init", "--yes", "--description", "在庫管理"]);
  expect(r.code, r.err).toBe(0);
  const req = pcube(root, ["request", "new", "通知機能", "--body", "- 送信基盤\n- 設定画面\n- 再送", "--json"]).json();
  return { root, rid: req.id as string };
}

describe("pcube init", () => {
  it("リポジトリのルートに .pcube/requests/ を作り、リポジトリの中身から既定値を推測する", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const r = pcube(join(root, "src"), ["init", "--yes", "--agents"]);
    expect(r.code, r.err).toBe(0);
    const yaml = readFileSync(join(root, ".pcube", "project.yaml"), "utf8");
    expect(yaml).toContain(`name: ${root.split("/").at(-1)}`);
    expect(yaml).toContain("repo: ..");
    expect(yaml).toMatch(/docs:\n {2}- docs\n {2}- README.md\n {2}- AGENTS.md/);
    expect(yaml).toContain("id: doing");
    expect(existsSync(join(root, ".pcube", "requests"))).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("タスク管理（pcube）");
    expect(pcube(root, ["init", "--yes"]).code).toBe(1); // 2回目は拒む
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
    expect(pcube(root, ["new", "API の認証", "--area", "src/api", "--estimate", "2", ...r]).out).toContain(`${rid}/T001`);
    // 本文が - で始まっても受け取れる
    expect(pcube(root, ["new", "通知", "--body", "- 箇条書き", ...r]).code).toBe(0);
    expect(readFileSync(join(root, ".pcube", "requests", rid, "tasks", "T002.md"), "utf8")).toContain("- 箇条書き");

    expect(pcube(root, ["link", "T2", "depends_on", "T1", "--note", "認証が先", ...r]).code).toBe(0);
    const cycle = pcube(root, ["link", "1", "depends_on", "2", ...r]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("循環");

    expect(pcube(root, ["move", "T2", "doing", ...r]).code).toBe(0);
    expect(pcube(root, ["move", "2", "in_progress", ...r]).err).toContain("ステータスは");
    expect(pcube(root, ["set", "1", "progress=30", "due=2026-10-20", "labels=a,b", ...r]).code).toBe(0);
    expect(pcube(root, ["set", "1", "due=", ...r]).code).toBe(0);

    const ls = pcube(root, ["ls", "--status", "todo", "--json", ...r]).json();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ id: "T001", progress: 30, labels: ["a", "b"] });
    expect(ls[0].due).toBeUndefined();

    const show = pcube(root, ["show", "T1", "--json", ...r]).json();
    expect(show.graph.incoming).toEqual([expect.objectContaining({ from: `${rid}/T002`, type: "depends_on" })]);
    expect(show.graph.impactScope).toEqual([`${rid}/T002`]);
    expect(pcube(root, ["find", "通知", "--json", ...r]).json().candidates.map((c: any) => c.ref)).toContain(`${rid}/T002`);
    expect(pcube(root, ["impact", "1", "--json", ...r]).json()).toEqual([`${rid}/T002`]);

    expect(pcube(root, ["archive", "2", ...r]).code).toBe(0);
    expect(pcube(root, ["show", "T2", ...r]).code).toBe(1);
  });

  it("move --output で成果物（PR の URL など）を足す。全要望の一覧と進捗", async () => {
    const { root, rid } = await initialized();
    pcube(root, ["new", "A", "--req", rid]);
    pcube(root, ["new", "B", "--req", rid]);
    const done = pcube(root, ["move", "T1", "done", "--output", "https://example.com/pull/7", "--req", rid], { PCUBE_ACTOR: "ai:claude" });
    expect(done.code, done.err).toBe(0);
    const t = pcube(root, ["show", `${rid}/T1`, "--json"]).json().item;
    expect(t).toMatchObject({ status: "done", outputs: ["https://example.com/pull/7"], updatedBy: "ai:claude" });
    expect(pcube(root, ["ls", "--all", "--json"]).json()).toHaveLength(2);
    const progress = pcube(root, ["progress", "--json"]).json();
    expect(progress[0]).toMatchObject({ total: 2, done: 1, counts: { todo: 1, doing: 0, done: 1 } });
    expect(pcube(root, ["progress"]).out).toContain("1/2");
  });

  it("終了コード: 競合は 3、見つからないは 2、使い方の誤りは 1。要望が決まらなければ案内する", async () => {
    const { root, rid } = await initialized();
    const r = ["--req", rid];
    pcube(root, ["new", "A", ...r]);
    pcube(root, ["set", "1", "progress=10", ...r]);
    const conflict = pcube(root, ["move", "1", "done", "--rev", "1", ...r]);
    expect(conflict.code).toBe(3);
    expect(conflict.err).toContain("競合");
    expect(pcube(root, ["move", "1", "done", "--rev", "2", ...r]).code).toBe(0);
    expect(pcube(root, ["move", "99", "done", ...r]).code).toBe(2);
    expect(pcube(root, ["nope"]).code).toBe(1);
    expect(pcube(root, ["set", "1", "color=red", ...r]).err).toContain("変更できるキー");
    const noReq = pcube(root, ["new", "どこに？"]);
    expect(noReq.code).toBe(1);
    expect(noReq.err).toContain("要望を指定");
  });

  it(".pcube/ が無ければ init を案内する", async () => {
    const root = await repo();
    const r = pcube(root, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pcube init");
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
    expect(pcube(wt, ["whoami", "--json"], ai).json()).toEqual({ actor: "ai:claude", request: rid });
    expect(pcube(wt, ["move", "T1", "doing"], ai).code).toBe(0);
    const added = pcube(wt, ["new", "作業中に見つかった追加の作業", "--json"], ai).json();
    expect(added.ref).toBe(`${rid}/T004`);
    expect(readFileSync(join(root, ".pcube", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: doing");
    expect(existsSync(join(root, ".pcube", "requests", rid, "tasks", "T004.md"))).toBe(true);
    // 作業ツリーの .pcube/ はブランチ時点の写しのまま
    expect(readFileSync(join(wt, ".pcube", "requests", rid, "tasks", "T001.md"), "utf8")).toContain("status: todo");
    expect(existsSync(join(wt, ".pcube", "requests", rid, "tasks", "T004.md"))).toBe(false);
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
    expect(accepted.map((t: any) => [t.id, t.title])).toEqual([
      ["T001", "送信基盤"],
      ["T002", "設定画面"],
    ]);
    expect(accepted[1].relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
    expect(pcube(root, ["request", "show", rid, "--json"]).json().item.status).toBe("active");
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
