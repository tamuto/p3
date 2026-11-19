import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { confirmRetrospectiveTarget, retrospectiveView } from "../packages/tasks/src/features/retro/core/retrospective.ts";
import { createRequest, updateRequest } from "../packages/tasks/src/core/requestOps.ts";
import { RetrospectiveError } from "../packages/tasks/src/features/retro/shared/retrospective.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, newTask, openTestProject, tempDir } from "./helpers.ts";

/**
 * 振り返りの対象の確定（shared/retrospective.ts・core/retrospective.ts）: 候補（タスク化・分割の採用・旧記録）と根拠、最新の実行・採用で
 * 対象が変わらないこと、確定できない run、確定の記録の保存と訂正、版の競合、CLI・API を確かめる
 */

async function setup(body = "- 案 A\n- 案 B") {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "請求", status: "active", body });
  const runDir = (rid: string, run: string) => p.ctx.ws.preflight.runDir(rid, run);
  /** run.json を直接直す（リスクを足す・途中の採用にするなど） */
  const patchRun = async (rid: string, run: string, fn: (j: Record<string, unknown>) => void) => {
    const file = join(runDir(rid, run), "run.json");
    const j = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    fn(j);
    await writeFile(file, JSON.stringify(j, null, 2));
  };
  const run = async (rid = req.id, risks = ["性能が落ちる", "既存の CSV が壊れる"]) => {
    const { id } = await p.ctx.preflight.start(rid, { engine: "mock" });
    await p.ctx.preflight.wait(rid, id);
    await patchRun(rid, id, (j) => ((j.assessment as { risks: string[] }).risks = risks));
    return id;
  };
  return { ...p, rid: req.id, run, patchRun };
}

describe("候補と根拠", () => {
  it("タスク化を終えた run を、作ったタスクの根拠と一緒に新しい順で出す。採用の前・評価の途中の run は候補にしない", async () => {
    const { ctx, rid, run } = await setup();
    const r1 = await run();
    expect((await retrospectiveView(ctx, rid)).candidates).toEqual([]);
    expect((await retrospectiveView(ctx, rid)).none).toMatch(/採用を終えた Preflight がありません/);
    await ctx.preflight.materialize(rid, r1, "human:a");
    const r2 = await run();
    await ctx.preflight.materialize(rid, r2, "human:a");
    await ctx.ws.tasksOf(rid).archive("T001");
    const v = await retrospectiveView(ctx, rid);
    expect(v.candidates.map((c) => [c.run, c.kind, c.latest, c.risks])).toEqual([
      [r2, "tasks", true, 2],
      [r1, "tasks", false, 2],
    ]);
    expect(v.candidates[1].basis).toEqual([
      { key: "D1", target: "T001", state: "archived" },
      { key: "D2", target: "T002", state: "present" },
    ]);
  });

  it("分割の採用は子の splitFrom と照らして「分割の採用」として出し、materialization の無い以前の run は旧記録と明記する", async () => {
    const { ctx, run, patchRun } = await setup();
    const parent = await createRequest(ctx, { title: "大きい要望", body: Array.from({ length: 6 }, (_, i) => `- 項目${i + 1}`).join("\n") });
    const r = await run(parent.id);
    const adopted = await ctx.preflight.adopt(parent.id, r, "human:a");
    const v = await retrospectiveView(ctx, parent.id);
    expect(v.candidates[0]).toMatchObject({ run: r, kind: "split", basis: adopted.created.map((c) => ({ key: c.key, target: c.id, state: "present" })) });
    // 旧記録
    const old = await newRequest(ctx, { title: "古い要望", status: "active", body: "- x\n- y" });
    const r0 = await run(old.id);
    await ctx.preflight.materialize(old.id, r0);
    await patchRun(old.id, r0, (j) => {
      j.materialized = Object.values((j.materialization as { created: Record<string, string> }).created);
      delete j.materialization;
    });
    expect((await retrospectiveView(ctx, old.id)).candidates[0]).toMatchObject({ kind: "legacy", basis: [{ target: "T001", state: "present" }, { target: "T002", state: "present" }] });
  });
});

describe("確定", () => {
  it("マイルストーンの無い要望でも1つの対象を確定でき、評価の版・リスクの原文・確定者と日時が読み直しても残る。最新の実行・採用では変わらない", async () => {
    const { ctx, rid, run, dataDir } = await setup();
    const r1 = await run();
    await ctx.preflight.materialize(rid, r1);
    const v = await confirmRetrospectiveTarget(ctx, rid, { run: r1 }, { expectedVersion: 0, actor: "human:a" });
    expect(v.target).toMatchObject({ id: "V1", run: r1, kind: "tasks", by: "human:a", risks: [{ index: 0, text: "性能が落ちる" }, { index: 1, text: "既存の CSV が壊れる" }] });
    expect(v.target?.assessmentVersion).toMatch(/^[0-9a-f]{16}$/);
    const r2 = await run(rid, ["別のリスク"]);
    await ctx.preflight.materialize(rid, r2);
    const fresh = await openTestProject(dataDir);
    const again = await retrospectiveView(fresh, rid);
    expect(again.target).toEqual(v.target);
    expect(again.candidates.find((c) => c.run === r1)?.latest).toBe(false);
    expect(again.candidates.find((c) => c.run === r2)?.latest).toBe(true);
  });

  it("途中の採用・未完了の評価・別の要望の run・見送りの要望・評価の欠けた run は確定できず、何も書かない", async () => {
    const { ctx, rid, run, patchRun, dataDir } = await setup();
    const r1 = await run();
    await ctx.preflight.materialize(rid, r1);
    const other = await newRequest(ctx, { title: "別", status: "active", body: "- p\n- q" });
    const ro = await run(other.id);
    await ctx.preflight.materialize(other.id, ro);
    const file = join(dataDir, "requests", rid, "retrospective.json");
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: ro })).rejects.toThrow(/候補ではありません/);
    await patchRun(rid, r1, (j) => ((j.materialization as { done: boolean }).done = false));
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r1 })).rejects.toThrow(RetrospectiveError);
    await patchRun(rid, r1, (j) => {
      (j.materialization as { done: boolean }).done = true;
      j.status = "failed";
    });
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r1 })).rejects.toThrow(/候補ではありません/);
    await patchRun(rid, r1, (j) => {
      j.status = "completed";
      delete j.assessment;
    });
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r1 })).rejects.toThrow(/候補ではありません/);
    await updateRequest(ctx, other.id, { status: "rejected" });
    await expect(confirmRetrospectiveTarget(ctx, other.id, { run: ro })).rejects.toThrow(/見送り/);
    await expect(readFile(file, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("訂正は理由が要り、前の対象と理由が残る。読んだ版が違えば何も書かず、同時の保存は片方だけ通る", async () => {
    const { ctx, rid, run } = await setup();
    const r1 = await run();
    await ctx.preflight.materialize(rid, r1);
    const r2 = await run();
    await ctx.preflight.materialize(rid, r2);
    await confirmRetrospectiveTarget(ctx, rid, { run: r1 }, { actor: "human:a" });
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r1 })).rejects.toThrow(/既に振り返りの対象/);
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r2 })).rejects.toThrow(/理由/);
    await expect(confirmRetrospectiveTarget(ctx, rid, { run: r2, reason: "x" }, { expectedVersion: 0 })).rejects.toThrow(/他で変わりました/);
    const v = await confirmRetrospectiveTarget(ctx, rid, { run: r2, reason: "D1 の追加範囲で採用し直した" }, { expectedVersion: 1, actor: "human:b" });
    expect(v.targets.map((t) => [t.id, t.run, t.replaces, t.reason])).toEqual([
      ["V1", r1, undefined, undefined],
      ["V2", r2, "V1", "D1 の追加範囲で採用し直した"],
    ]);
    const results = await Promise.allSettled([
      confirmRetrospectiveTarget(ctx, rid, { run: r1, reason: "a" }, { expectedVersion: 2 }),
      confirmRetrospectiveTarget(ctx, rid, { run: r1, reason: "b" }, { expectedVersion: 2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await retrospectiveView(ctx, rid)).version).toBe(3);
  });

  it("壊れた記録は空にせず読めないと知らせ、直接作ったタスクだけの要望は候補なし", async () => {
    const { ctx, rid, dataDir } = await setup();
    await newTask(ctx, rid, { title: "直接" });
    expect((await retrospectiveView(ctx, rid)).none).toMatch(/直接作ったタスクだけ/);
    await writeFile(join(dataDir, "requests", rid, "retrospective.json"), "{ broken");
    await expect(retrospectiveView(ctx, rid)).rejects.toThrow(/JSON として読めません/);
  });
});

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI と API", () => {
  it("p3 retro・retro confirm と API で候補・対象を同じ内容で読み、候補でない run と版の競合は書かない", async () => {
    const { ctx, rid, run, dataDir } = await setup();
    const r1 = await run();
    await ctx.preflight.materialize(rid, r1);
    const shown = p3(dataDir, ["retro", rid]);
    expect(shown.out).toContain("未確定");
    expect(shown.out).toContain(`${r1}  タスク化  最新`);
    expect(p3(dataDir, ["retro", rid, "confirm", "PF-nothing"]).code).toBe(1);
    const ok = p3(dataDir, ["retro", rid, "confirm", r1, "--json"]);
    expect(ok.code, ok.err).toBe(0);
    expect(JSON.parse(ok.out).target).toMatchObject({ run: r1, by: "human:test" });
    expect(p3(dataDir, ["retro", rid]).out).toContain("2. [未確認] 既存の CSV が壊れる");
    const conflict = p3(dataDir, ["retro", rid, "confirm", r1, "--reason", "x", "--rev", "0"]);
    expect(conflict.code).toBe(3);
    const app = apiRoutes(ctx);
    const send = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const v = (await (await send("GET", `/requests/${rid}/retrospective`)).json()) as { version: number; target: { run: string } };
    expect(v).toMatchObject({ version: 1, target: { run: r1 } });
    expect((await send("POST", `/requests/${rid}/retrospective/target`, { run: "PF-x", reason: "r" })).status).toBe(400);
    expect((await send("POST", `/requests/${rid}/retrospective/target`, { run: r1, reason: "r", version: 0 })).status).toBe(409);
  });
});
