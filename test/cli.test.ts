import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { git, gitInit, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/pcube.mjs", import.meta.url));

/** CLI を別プロセスで動かす。マシンの .env にある Codex の設定は効かないようにする */
function pcube(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PCUBE_CODEX_AUTH_VOLUME: "", PCUBE_CODEX_AUTH_FILE: "", PCUBE_DATA_DIR: "", PCUBE_ACTOR: "", ...env },
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

async function initialized() {
  const root = await repo();
  const r = pcube(root, ["init", "--yes", "--description", "在庫管理", "--member", "tester:テスター:tester@example.com", "--member", "hanako:花子"]);
  expect(r.code, r.err).toBe(0);
  return root;
}

describe("pcube init", () => {
  it("リポジトリのルートに .pcube/ を作り、git とリポジトリの中身から既定値を推測する", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    const r = pcube(join(root, "src"), ["init", "--yes", "--agents"]);
    expect(r.code, r.err).toBe(0);
    const yaml = readFileSync(join(root, ".pcube", "project.yaml"), "utf8");
    expect(yaml).toContain(`name: ${root.split("/").at(-1)}`);
    expect(yaml).toContain("repo: ..");
    expect(yaml).toMatch(/docs:\n {2}- docs\n {2}- README.md\n {2}- AGENTS.md/);
    expect(yaml).toContain("email: tester@example.com"); // git の user.email から
    expect(existsSync(join(root, ".pcube", "tasks"))).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("タスク管理（pcube）");
    expect(pcube(root, ["init", "--yes"]).code).toBe(1); // 2回目は拒む
  });
});

describe("pcube のタスク操作", () => {
  it("作成・一覧・更新・移動・関係・アーカイブ", async () => {
    const root = await initialized();
    expect(pcube(root, ["new", "task", "API の認証", "--area", "src/api", "--estimate", "2", "--assignee", "tester"]).out).toContain("TASK-0001");
    // 本文が - で始まっても受け取れる
    expect(pcube(root, ["new", "task", "通知", "--body", "- 箇条書き"]).code).toBe(0);
    expect(readFileSync(join(root, ".pcube", "tasks", "TASK-0002.md"), "utf8")).toContain("- 箇条書き");

    expect(pcube(root, ["link", "2", "depends_on", "1", "--note", "認証が先"]).code).toBe(0);
    const cycle = pcube(root, ["link", "1", "depends_on", "2"]);
    expect(cycle.code).toBe(1);
    expect(cycle.err).toContain("循環");

    expect(pcube(root, ["move", "task-2", "in_progress"]).code).toBe(0);
    expect(pcube(root, ["move", "2", "doing"]).err).toContain("ステータスは");
    expect(pcube(root, ["set", "1", "progress=30", "due=2026-10-20", "labels=a,b"]).code).toBe(0);
    expect(pcube(root, ["set", "1", "due="]).code).toBe(0);

    const ls = pcube(root, ["ls", "--status", "backlog", "--json"]).json();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ id: "TASK-0001", progress: 30, labels: ["a", "b"], assignee: "tester" });
    expect(ls[0].due).toBeUndefined();

    const show = pcube(root, ["show", "1", "--json"]).json();
    expect(show.graph.incoming).toEqual([expect.objectContaining({ from: "TASK-0002", type: "depends_on" })]);
    expect(show.graph.impactScope).toEqual(["TASK-0002"]);
    expect(pcube(root, ["find", "通知", "--json"]).json().match).toBe("TASK-0002");
    expect(pcube(root, ["impact", "1", "--json"]).json()).toEqual(["TASK-0002"]);

    expect(pcube(root, ["archive", "2"]).code).toBe(0);
    expect(pcube(root, ["show", "2"]).code).toBe(1);
  });

  it("変更者: git の user.email が一致するメンバー、PCUBE_ACTOR で上書き。メンバー以外の担当は警告", async () => {
    const root = await initialized();
    expect(pcube(root, ["whoami"]).out).toContain("human:tester");
    pcube(root, ["new", "task", "A"]);
    expect(pcube(root, ["show", "1", "--json"]).json().item.updatedBy).toBe("human:tester");
    pcube(root, ["set", "1", "status=ready"], { PCUBE_ACTOR: "ai:claude" });
    expect(pcube(root, ["show", "1", "--json"]).json().item.updatedBy).toBe("ai:claude");
    expect(pcube(root, ["set", "1", "assignee=taro"]).err).toContain("メンバーにいません");
  });

  it("終了コード: 競合は 3、見つからないは 2、使い方の誤りは 1", async () => {
    const root = await initialized();
    pcube(root, ["new", "task", "A"]);
    pcube(root, ["set", "1", "progress=10"]);
    const conflict = pcube(root, ["move", "1", "done", "--rev", "1"]);
    expect(conflict.code).toBe(3);
    expect(conflict.err).toContain("競合");
    expect(pcube(root, ["move", "1", "done", "--rev", "2"]).code).toBe(0);
    expect(pcube(root, ["show", "99"]).code).toBe(1); // 語句として探して候補が無い
    expect(pcube(root, ["move", "99", "done"]).code).toBe(2);
    expect(pcube(root, ["nope"]).code).toBe(1);
    expect(pcube(root, ["set", "1", "color=red"]).err).toContain("変更できるキー");
  });

  it(".pcube/ が無ければ init を案内する", async () => {
    const root = await repo();
    const r = pcube(root, ["ls"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("pcube init");
  });
});

describe("pcube config / member", () => {
  it("設定とメンバーを変え、project.yaml に書く", async () => {
    const root = await initialized();
    expect(pcube(root, ["config", "set", "description=経費精算", "docs=docs,README.md", "instructions=個人情報に注意"]).code).toBe(0);
    expect(pcube(root, ["config", "set", "branchPattern=feature"]).err).toContain("{id}");
    const cfg = pcube(root, ["config", "--json"]).json();
    expect(cfg).toMatchObject({ description: "経費精算", docs: ["docs", "README.md"], preflight: { instructions: "個人情報に注意" } });

    expect(pcube(root, ["member", "add", "claude", "--name", "Claude", "--ai"]).code).toBe(0);
    expect(pcube(root, ["member", "rm", "hanako"]).code).toBe(0);
    expect(pcube(root, ["member", "--json"]).json().map((m: any) => [m.id, m.kind])).toEqual([
      ["tester", "human"],
      ["claude", "ai"],
    ]);
  });
});

describe("pcube preflight / drafts / accept", () => {
  it("mock エンジンで評価し、一部を除いてタスク化する", async () => {
    const root = await initialized();
    pcube(root, ["new", "request", "通知機能", "--body", "- 送信基盤\n- 設定画面\n- 再送"]);
    const run = pcube(root, ["preflight", "1", "--engine", "mock", "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(run.json()).toMatchObject({ status: "completed", engine: "mock" });
    expect(pcube(root, ["drafts", "1"]).out).toContain("T3");

    const accepted = pcube(root, ["accept", "1", "--skip", "t3", "--json"]).json();
    expect(accepted.map((t: any) => t.title)).toEqual(["送信基盤", "設定画面"]);
    expect(accepted[1].relations).toEqual([expect.objectContaining({ type: "depends_on", target: accepted[0].id })]);
    expect(pcube(root, ["ls", "requests", "--json"]).json()[0]).toMatchObject({ status: "accepted", workstream: { branch: "req/REQ-0001" } });
  });
});

describe("作業ツリー", () => {
  it("要望ごとの作業ツリーの中で実行しても、メインの .pcube/ に書く", async () => {
    const root = await initialized();
    pcube(root, ["new", "task", "A"]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "pcube");
    const wt = join(root, ".worktrees", "REQ-0001");
    git(root, "worktree", "add", "-q", wt, "-b", "req/REQ-0001");
    expect(pcube(wt, ["move", "1", "in_progress"]).code).toBe(0);
    expect(readFileSync(join(root, ".pcube", "tasks", "TASK-0001.md"), "utf8")).toContain("status: in_progress");
    expect(readFileSync(join(wt, ".pcube", "tasks", "TASK-0001.md"), "utf8")).toContain("status: backlog");
  });
});
