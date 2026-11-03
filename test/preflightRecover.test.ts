import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineOutcome, PreflightEngine } from "../src/core/preflight/engine.ts";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import { currentOwner, ownerState, type OwnerProbe } from "../src/core/preflight/owner.ts";
import { PreflightBusyError, PreflightService } from "../src/core/preflight/service.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import type { PreflightRun, RunOwner } from "../src/shared/types.ts";
import { makeRepo, newRequest, tempDir } from "./helpers.ts";

/**
 * 実行していたプロセスが終わった run の回復（service.ts の recover / busy、owner.ts）。
 * 確かめられるときだけ中断にし、生きている別のプロセス・別の環境・以前の run・手元のエージェントの run は変えない
 */

// 子プロセスと同じ識別子を使う（ホームの ~/.local/state を汚さない）
const STATE = tempDir("p3-state-");
beforeAll(() => {
  process.env.XDG_STATE_HOME = STATE;
});

const CHILD = fileURLToPath(new URL("./fixtures/preflightChild.ts", import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const me = (): RunOwner => ({ instance: "i", boot: "b", pidNs: "1", pid: 100, start: "5" });
const probe = (starts: Record<number, string | null | undefined>, self: RunOwner | null = me()): OwnerProbe => ({ self: () => self ?? undefined, startOf: (pid) => starts[pid] });

/** 開けるまで待つエンジン */
class Gate implements PreflightEngine {
  readonly name = "mock" as const;
  private open: (() => void)[] = [];
  async status() {
    return { name: "mock" as const, ok: true, detail: "" };
  }
  async run(job: Parameters<PreflightEngine["run"]>[0], log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    await new Promise<void>((r) => this.open.push(r));
    return new MockEngine({ delay: 0 }).run(job, log, signal);
  }
  release() {
    for (const r of this.open.splice(0)) r();
  }
}

async function project(engine: PreflightEngine = new MockEngine({ delay: 0 }), owner?: OwnerProbe) {
  const { dataDir } = await makeRepo();
  const ws = new Workspace(dataDir);
  await ws.load();
  const service = new PreflightService(ws, { mock: engine }, "mock", undefined, { probe: owner });
  return { dataDir, ws, service };
}

/** run.json を書き換える（別のプロセス・以前の版が残した状態を作る） */
function patchRun(dataDir: string, rid: string, runId: string, patch: Partial<PreflightRun>) {
  const file = join(dataDir, "requests", rid, "preflight", runId, "run.json");
  const run = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...run, ...patch }, null, 2));
}

describe("実行しているプロセスの判定（ownerState）", () => {
  it("確かめられるときだけ dead、生きていれば alive、それ以外は unknown（推測で死んだとしない）", () => {
    const own = { ...me(), pid: 200, start: "9" };
    expect(ownerState(undefined, probe({})).state).toBe("unknown"); // 以前の run
    expect(ownerState(own, probe({ 200: "9" }))).toEqual({ state: "alive" });
    expect(ownerState(own, probe({ 200: null }))).toMatchObject({ state: "dead", reason: expect.stringContaining("200") });
    expect(ownerState(own, probe({ 200: "10" }))).toMatchObject({ state: "dead", reason: expect.stringContaining("同じ番号の別のプロセス") }); // 番号の使い回し
    expect(ownerState({ ...own, boot: "old" }, probe({ 200: "9" }))).toMatchObject({ state: "dead", reason: expect.stringContaining("OS が起動し直し") });
    expect(ownerState({ ...own, instance: "other" }, probe({ 200: null }))).toMatchObject({ state: "unknown", reason: expect.stringContaining("別の環境") });
    expect(ownerState({ ...own, pidNs: "2" }, probe({ 200: null }))).toMatchObject({ state: "unknown", reason: expect.stringContaining("名前空間") });
    expect(ownerState(own, probe({ 200: undefined }))).toMatchObject({ state: "unknown" }); // 起動の時刻を確かめられない
    expect(ownerState({ ...own, start: undefined }, probe({ 200: "9" }))).toMatchObject({ state: "unknown" });
    expect(ownerState(own, probe({ 200: null }, null))).toMatchObject({ state: "unknown" }); // このマシンの識別子が無い
  });

  it("このプロセスの記録はパスやホスト名を含まず、Linux では起動・名前空間・起動の時刻を持つ", () => {
    const o = currentOwner()!;
    expect(o.instance).toMatch(/^[0-9a-f]{24}$/);
    expect(o.pid).toBe(process.pid);
    expect(JSON.stringify(o)).not.toContain(STATE);
    if (process.platform === "linux") {
      expect(o).toMatchObject({ boot: expect.any(String), pidNs: expect.stringMatching(/^\d+$/), start: expect.stringMatching(/^\d+$/) });
      expect(ownerState(o)).toEqual({ state: "alive" });
    }
  });
});

describe("落ちたプロセスが残した run の回復", () => {
  it.runIf(process.platform === "linux")("別のプロセスで始めた run は、動いている間は（35 分を過ぎても）始めず、強制終了の後に開き直すと中断にして始め直せる", async () => {
    const { dataDir } = await makeRepo();
    const ws = new Workspace(dataDir);
    await ws.load();
    const rid = (await ws.requests.create({ title: "評価", status: "draft", body: "- a\n" }, "test")).id;
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, dataDir, rid], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: STATE } });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    for (let i = 0; i < 300 && !out.includes("started"); i++) await sleep(50);
    const runId = out.match(/started (PF-\S+)/)?.[1];
    expect(runId, err).toBeTruthy();

    const service = new PreflightService(ws, { mock: new MockEngine({ delay: 0 }) }, "mock");
    await ws.requests.reload(rid);
    const disk = (await ws.preflight.get(rid, runId!))!;
    expect(disk.owner).toMatchObject({ pid: child.pid, instance: currentOwner()!.instance });
    expect(disk.before).toBe("draft");
    // 動いている: 回復しない。開始から 2 時間たったことにしても始めない
    patchRun(dataDir, rid, runId!, { startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    expect((await service.recover({ log: () => {} })).recovered).toEqual([]);
    await expect(service.start(rid)).rejects.toThrow(/別のプロセスで実行中/);

    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const logs: string[] = [];
    const { recovered } = await service.recover({ log: (m) => logs.push(m) });
    expect(recovered).toEqual([`${rid}/${runId}`]);
    expect(logs.join("\n")).toContain("中断にしました");
    const after = (await ws.preflight.get(rid, runId!))!;
    expect(after).toMatchObject({ status: "failed", interrupted: { reason: expect.stringContaining("終わっています") }, finishedAt: expect.any(String) });
    expect(after.error).toMatch(/^中断しました: /);
    expect(after.log.at(-1)?.text).toBe(after.error);
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)).toMatchObject({ status: "draft", lastPreflight: runId });
    // 読むだけの pulse にも出る
    expect((await service.pulse(rid, runId)).run).toMatchObject({ status: "failed" });
    // 二度目の回復は何もしない
    expect((await service.recover({ log: () => {} })).recovered).toEqual([]);
    // すぐ始め直せる
    const again = await service.start(rid);
    await service.wait(rid, again.id);
    expect((await ws.preflight.get(rid, again.id))?.status).toBe("completed");
  }, 30_000);

  it("CLI の開始（busy）でも同じ規則で回復し、確かめられない run（以前の run・別の環境・別の名前空間）は変えずに理由を出して断る", async () => {
    const own = { ...me(), pid: 300, start: "7" };
    const { dataDir, ws, service } = await project(new MockEngine({ delay: 0 }), probe({ 300: null }));
    const rid = (await newRequest({ ws } as never, { title: "評価", status: "draft", body: "- a\n" })).id;
    const first = await service.start(rid);
    await service.wait(rid, first.id);
    for (const [label, patch] of [
      ["以前の版", { owner: undefined }],
      ["別の環境", { owner: { ...own, instance: "other" } }],
      ["名前空間", { owner: { ...own, pidNs: "9" } }],
    ] as const) {
      patchRun(dataDir, rid, first.id, { status: "running", finishedAt: undefined, ...patch });
      const e = await service.start(rid).catch((x: Error) => x);
      expect(e, label).toBeInstanceOf(PreflightBusyError);
      expect((e as Error).message).toMatch(/実行中のまま残っています。動いていないと確かめられないので始めません/);
      expect((await ws.preflight.get(rid, first.id))?.status).toBe("running");
    }
    // 終わっていると確かめられる記録なら、開始のときに中断にして始める
    patchRun(dataDir, rid, first.id, { owner: own });
    const next = await service.start(rid);
    await service.wait(rid, next.id);
    expect((await ws.preflight.get(rid, first.id))?.status).toBe("failed");
    expect((await ws.preflight.get(rid, next.id))?.status).toBe("completed");
  });

  it("手元のエージェントの run（local）は、プロセスが終わっても評価を待ったまま", async () => {
    const { ws, service } = await project(new MockEngine({ delay: 0 }), probe({}));
    const rid = (await newRequest({ ws } as never, { title: "評価", status: "draft", body: "- a\n" })).id;
    const p = await service.prepare(rid);
    expect(p.run.owner).toBeUndefined();
    expect((await service.recover({ log: () => {} })).recovered).toEqual([]);
    expect((await ws.preflight.get(rid, p.run.id))?.status).toBe("running");
  });

  it("新しい run の後ろに残った古い run を回復しても、最新の run と要望の状態は変えない", async () => {
    const own = { ...me(), pid: 400, start: "1" };
    const { dataDir, ws, service } = await project(new MockEngine({ delay: 0 }), probe({ 400: null }));
    const rid = (await newRequest({ ws } as never, { title: "評価", status: "draft", body: "- a\n" })).id;
    const old = await service.start(rid);
    await service.wait(rid, old.id);
    const latest = await service.start(rid);
    await service.wait(rid, latest.id);
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)).toMatchObject({ status: "reviewed", lastPreflight: latest.id });
    patchRun(dataDir, rid, old.id, { status: "running", finishedAt: undefined, owner: own, before: "draft" });
    expect((await service.recover({ log: () => {} })).recovered).toEqual([`${rid}/${old.id}`]);
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)).toMatchObject({ status: "reviewed", lastPreflight: latest.id });
    expect((await ws.preflight.get(rid, latest.id))?.status).toBe("completed");
  });

  it("実行の終わりは、別のプロセスが先に終えた（中断にした）run を上書きせず、要望の状態も巻き戻さない", async () => {
    const gate = new Gate();
    const { dataDir, ws, service } = await project(gate, probe({}));
    const rid = (await newRequest({ ws } as never, { title: "評価", status: "draft", body: "- a\n" })).id;
    const run = await service.start(rid);
    // 別のプロセスが中断にした（T002 の明示の操作など）
    patchRun(dataDir, rid, run.id, { status: "failed", error: "中断しました: 人が止めた", finishedAt: new Date().toISOString() });
    await ws.requests.update(rid, { status: "draft" });
    gate.release();
    await service.wait(rid, run.id);
    expect((await ws.preflight.get(rid, run.id))).toMatchObject({ status: "failed", error: "中断しました: 人が止めた" });
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)?.status).toBe("draft");
    expect(service.running()).toBe(0);
  });

  it("壊れた run.json や読めない要望があっても、ほかの回復は続ける", async () => {
    const own = { ...me(), pid: 500, start: "1" };
    const { dataDir, ws, service } = await project(new MockEngine({ delay: 0 }), probe({ 500: null }));
    const a = (await newRequest({ ws } as never, { title: "A", status: "draft", body: "- a\n" })).id;
    const b = (await newRequest({ ws } as never, { title: "B", status: "draft", body: "- b\n" })).id;
    const ra = await service.start(a);
    await service.wait(a, ra.id);
    const rb = await service.start(b);
    await service.wait(b, rb.id);
    writeFileSync(join(dataDir, "requests", a, "preflight", ra.id, "run.json"), "{ 壊れた");
    patchRun(dataDir, b, rb.id, { status: "running", finishedAt: undefined, owner: own });
    const { recovered } = await service.recover({ log: () => {} });
    expect(recovered).toEqual([`${b}/${rb.id}`]);
  });
});
