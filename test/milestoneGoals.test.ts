// マイルストーンの目的と予定機能: 旧形式の読み込み、目的だけ・予定機能だけの保存、追加・変更・削除と安定した ID、上限と不正な値、
// 無関係な保存で落ちないこと、版の照合（API・CLI）、別プロセスの同時保存で片方が競合として断られることを確かめる。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { MILESTONE_GOAL_LIMITS, milestoneGoalProblems, nextGoalId } from "../src/shared/milestoneGoals.ts";
import { MilestonesConflictError, ProjectInputError } from "../src/core/store/workspace.ts";
import { gitInit, makeProject, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
let CONFIG_HOME = "";
beforeEach(() => {
  CONFIG_HOME = tempDir("p3-config-");
});

function cliEnv() {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  return { ...base, XDG_CONFIG_HOME: CONFIG_HOME };
}
function p3(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", input, env: cliEnv() });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}
/** 別プロセスで動かし、終わりを待つ（同時に走らせる） */
function p3Async(cwd: string, args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { cwd, env: cliEnv() });
    let err = "";
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("close", (code) => resolve({ code, err }));
  });
}

async function cliProject() {
  const root = tempDir("p3-goals-");
  gitInit(root);
  await mkdir(join(root, "docs"));
  writeFileSync(join(root, "README.md"), "# app\n");
  const r = p3(root, ["init", "--yes", "--description", "在庫管理", "--dir", ".p3", "--repo-name", "app"]);
  expect(r.code, r.err).toBe(0);
  return root;
}

describe("目的・予定機能の規則", () => {
  it("ID は今ある最大の番号の次。空・重複・件数・文字数を断る", () => {
    expect(nextGoalId([])).toBe("G1");
    expect(nextGoalId([{ id: "G3", text: "a" }, { id: "G1", text: "b" }, { id: "x", text: "c" }])).toBe("G4");
    expect(milestoneGoalProblems({ id: "v1", goals: [{ id: "G1", text: " " }] })[0]).toContain("空です");
    expect(milestoneGoalProblems({ id: "v1", goals: [{ id: "G1", text: "a" }, { id: "G1", text: "b" }] })[0]).toContain("重複");
    expect(milestoneGoalProblems({ id: "v1", goals: [{ id: "../x", text: "a" }] })[0]).toContain("id が使えません");
    expect(milestoneGoalProblems({ id: "v1", purpose: "あ".repeat(MILESTONE_GOAL_LIMITS.purpose + 1) })[0]).toContain("目的は");
    const many = Array.from({ length: MILESTONE_GOAL_LIMITS.goals + 1 }, (_, i) => ({ id: `G${i + 1}`, text: "a" }));
    expect(milestoneGoalProblems({ id: "v1", goals: many })[0]).toContain("件まで");
    expect(milestoneGoalProblems({ id: "v1", goals: [{ id: "G1", text: "a".repeat(MILESTONE_GOAL_LIMITS.goalText + 1) }] })[0]).toContain("文字まで");
    expect(milestoneGoalProblems({ id: "v1", purpose: "目的", goals: [{ id: "G1", text: "a" }] })).toEqual([]);
  });
});

describe("保存と読み込み（Workspace）", () => {
  it("目的・予定機能の無い旧形式は空として読み、目的だけ・予定機能だけでも保存でき、無関係な保存で落ちない", async () => {
    const { ctx, dataDir } = await makeProject({ milestones: [{ id: "v1", title: "最初" }] });
    expect(ctx.ws.project.milestones[0]).toEqual({ id: "v1", title: "最初", due: undefined, done: undefined });
    await ctx.ws.updateMilestones((ms) => ms.map((m) => ({ ...m, purpose: "在庫の確認を\n速くする\n" })));
    expect(ctx.ws.project.milestones[0].purpose).toBe("在庫の確認を\n速くする");
    expect(ctx.ws.project.milestones[0].goals).toBeUndefined();
    await ctx.ws.saveProject({ milestones: [{ id: "v2", title: "次", goals: [{ id: "G1", text: " 通知 " }] }, ...ctx.ws.project.milestones] });
    expect(ctx.ws.project.milestones[0]).toMatchObject({ id: "v2", goals: [{ id: "G1", text: "通知" }] });
    expect(ctx.ws.project.milestones[0].purpose).toBeUndefined();
    // 名前・期限だけの更新（目的・予定機能のキーが無い）と設定の保存では落ちない
    await ctx.ws.saveProject({ milestones: [{ id: "v2", title: "次の名前", due: "2026-12-01" }, { id: "v1", title: "最初", done: true }] });
    await ctx.ws.saveProject({ name: "改名", preflight: { instructions: "観点" } });
    expect(ctx.ws.project.milestones).toEqual([
      { id: "v2", title: "次の名前", due: "2026-12-01", done: undefined, goals: [{ id: "G1", text: "通知" }] },
      { id: "v1", title: "最初", due: undefined, done: true, purpose: "在庫の確認を\n速くする" },
    ]);
    const yaml = readFileSync(join(dataDir, "project.yaml"), "utf8");
    expect(yaml).toContain("purpose: |-");
    // 空で消す
    await ctx.ws.saveProject({ milestones: ctx.ws.project.milestones.map((m) => ({ ...m, purpose: "", goals: [] })) });
    expect(ctx.ws.project.milestones.every((m) => m.purpose === undefined && m.goals === undefined)).toBe(true);
    expect(readFileSync(join(dataDir, "project.yaml"), "utf8")).not.toContain("purpose");
  });

  it("手で書いた予定機能は id と text のある項目だけを読み、重複した id は最初を残す", async () => {
    const { ctx, dataDir } = await makeProject();
    writeFileSync(
      join(dataDir, "project.yaml"),
      "name: t\nmilestones:\n  - id: v1\n    title: a\n    goals:\n      - id: G1\n        text: 一つ目\n      - id: G1\n        text: 重複\n      - text: id なし\n      - id: G2\n",
    );
    await ctx.ws.reloadAll();
    expect(ctx.ws.project.milestones[0].goals).toEqual([{ id: "G1", text: "一つ目" }]);
  });

  it("不正な値は ProjectInputError で何も書かない。版が違えば MilestonesConflictError で何も書かない", async () => {
    const { ctx, dataDir } = await makeProject({ milestones: [{ id: "v1", title: "最初" }] });
    const before = readFileSync(join(dataDir, "project.yaml"), "utf8");
    await expect(ctx.ws.saveProject({ milestones: [{ id: "v1", title: "最初", goals: [{ id: "G1", text: "" }] }] })).rejects.toBeInstanceOf(ProjectInputError);
    const v = ctx.ws.milestonesVersion;
    await ctx.ws.saveProject({ name: "名前だけ" }, { milestonesVersion: v });
    // 設定の項目の変更は版を変えない
    expect(ctx.ws.milestonesVersion).toBe(v);
    await ctx.ws.updateMilestones((ms) => ms.map((m) => ({ ...m, purpose: "目的" })));
    const now = readFileSync(join(dataDir, "project.yaml"), "utf8");
    expect(now).not.toBe(before);
    await expect(ctx.ws.saveProject({ milestones: [] }, { milestonesVersion: v })).rejects.toBeInstanceOf(MilestonesConflictError);
    expect(readFileSync(join(dataDir, "project.yaml"), "utf8")).toBe(now);
  });
});

describe("API", () => {
  async function setup() {
    const p = await makeProject({ milestones: [{ id: "v1", title: "最初" }] });
    const app = apiRoutes(p.ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    return { ...p, call };
  }

  it("GET で版を返し、版を付けた保存は照合する。古い版は 409 milestones_conflict で何も書かない", async () => {
    const { call } = await setup();
    const got = await call("GET", "/project");
    const v = got.body.milestonesVersion as string;
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    const ok = await call("PUT", "/project", { milestones: [{ id: "v1", title: "最初", purpose: "目的", goals: [{ id: "G1", text: "通知" }] }], milestonesVersion: v });
    expect(ok.status).toBe(200);
    expect(ok.body.milestones[0]).toMatchObject({ purpose: "目的", goals: [{ id: "G1", text: "通知" }] });
    const stale = await call("PUT", "/project", { milestones: [], milestonesVersion: v });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("milestones_conflict");
    expect((await call("GET", "/project")).body.project.milestones[0].purpose).toBe("目的");
  });

  it("版なしの古い形の保存（目的・予定機能のキーなし）は今の値を残す。null で消す。不正な値は 400", async () => {
    const { call } = await setup();
    await call("PUT", "/project", { milestones: [{ id: "v1", title: "最初", purpose: "目的", goals: [{ id: "G1", text: "通知" }] }] });
    const old = await call("PUT", "/project", { milestones: [{ id: "v1", title: "改名", done: true }] });
    expect(old.body.milestones[0]).toMatchObject({ title: "改名", done: true, purpose: "目的", goals: [{ id: "G1", text: "通知" }] });
    const cleared = await call("PUT", "/project", { milestones: [{ id: "v1", title: "改名", purpose: null, goals: null }] });
    expect(cleared.body.milestones[0].purpose).toBeUndefined();
    expect(cleared.body.milestones[0].goals).toBeUndefined();
    const bad = await call("PUT", "/project", { milestones: [{ id: "v1", title: "改名", goals: [{ id: "G1", text: "a" }, { id: "G1", text: "b" }] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("重複");
  });
});

describe("CLI", () => {
  it("目的の設定（--body・--file・標準入力）と解除、予定機能の追加・更新・削除。ID は振り直さない", async () => {
    const root = await cliProject();
    expect(p3(root, ["milestone", "add", "v1", "--title", "最初"]).code).toBe(0);
    writeFileSync(join(root, "purpose.md"), "在庫の確認を速くする\n店舗の負担を減らす\n");
    expect(p3(root, ["milestone", "purpose", "v1", "--file", "purpose.md"]).code).toBe(0);
    expect(p3(root, ["milestone", "show", "v1", "--json"]).json().purpose).toBe("在庫の確認を速くする\n店舗の負担を減らす");
    expect(p3(root, ["milestone", "purpose", "v1", "--body", "-"], "標準入力の目的\n").code).toBe(0);
    expect(p3(root, ["milestone", "purpose", "v1"]).code).toBe(1);
    const a = p3(root, ["milestone", "goal", "add", "v1", "在庫の一覧", "--json"]).json();
    expect(a.added).toBe("G1");
    expect(p3(root, ["milestone", "goal", "add", "v1", "通知"]).code).toBe(0);
    expect(p3(root, ["milestone", "goal", "add", "v1", "CSV 出力"]).code).toBe(0);
    expect(p3(root, ["milestone", "goal", "rm", "v1", "G2"]).code).toBe(0);
    expect(p3(root, ["milestone", "goal", "set", "v1", "G3", "CSV と Excel の出力"]).code).toBe(0);
    expect(p3(root, ["milestone", "goal", "set", "v1", "G9", "x"]).err).toContain("予定機能がありません");
    expect(p3(root, ["milestone", "goal", "add", "v1", " "]).err).toContain("空です");
    // 名前の変更でも目的・予定機能は残る
    expect(p3(root, ["milestone", "set", "v1", "--title", "最初のリリース", "--done"]).code).toBe(0);
    const shown = p3(root, ["milestone", "show", "v1", "--json"]).json();
    expect(shown).toMatchObject({
      title: "最初のリリース",
      done: true,
      purpose: "標準入力の目的",
      goals: [
        { id: "G1", text: "在庫の一覧" },
        { id: "G3", text: "CSV と Excel の出力" },
      ],
    });
    expect(p3(root, ["milestone", "show", "v1"]).out).toContain("G3  CSV と Excel の出力");
    expect(p3(root, ["milestone", "goal", "add", "v1", "次", "--json"]).json().added).toBe("G4");
    expect(p3(root, ["milestone", "purpose", "v1", "--off"]).code).toBe(0);
    expect(p3(root, ["milestone", "show", "v1", "--json"]).json().purpose).toBeUndefined();
    expect(p3(root, ["milestone", "show", "nope"]).code).toBe(1);
  });

  it("--version が古ければ競合（終了コード 3）で何も書かない", async () => {
    const root = await cliProject();
    p3(root, ["milestone", "add", "v1"]);
    const v = p3(root, ["milestone", "show", "v1", "--json"]).json().milestonesVersion as string;
    expect(p3(root, ["milestone", "goal", "add", "v1", "一つ目", "--version", v]).code).toBe(0);
    const r = p3(root, ["milestone", "goal", "add", "v1", "二つ目", "--version", v]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("競合");
    expect(p3(root, ["milestone", "show", "v1", "--json"]).json().goals).toEqual([{ id: "G1", text: "一つ目" }]);
  });

  it("別プロセスの同時の保存は1つずつ行い、どの追加も落ちない。同じ版から同時に保存すると片方だけが通る", async () => {
    const root = await cliProject();
    p3(root, ["milestone", "add", "v1"]);
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => p3Async(root, ["milestone", "goal", "add", "v1", `機能 ${i}`])));
    for (const r of rs) expect(r.code, r.err).toBe(0);
    const goals = p3(root, ["milestone", "show", "v1", "--json"]).json().goals as { id: string; text: string }[];
    expect(goals.map((g) => g.id).sort()).toEqual(["G1", "G2", "G3", "G4", "G5"]);
    expect(new Set(goals.map((g) => g.text)).size).toBe(5);

    const v = p3(root, ["milestone", "show", "v1", "--json"]).json().milestonesVersion as string;
    const both = await Promise.all([
      p3Async(root, ["milestone", "purpose", "v1", "--body", "A の目的", "--version", v]),
      p3Async(root, ["milestone", "purpose", "v1", "--body", "B の目的", "--version", v]),
    ]);
    expect(both.map((r) => r.code).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 3]);
  });
});
