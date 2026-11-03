import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineOutcome, PreflightEngine } from "../src/core/preflight/engine.ts";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import type { OwnerProbe } from "../src/core/preflight/owner.ts";
import { CancelRefusedError, PreflightService } from "../src/core/preflight/service.ts";
import { NotFoundError } from "../src/core/store/collection.ts";
import { CANCEL_REQUEST_FILE } from "../src/core/store/preflightStore.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { PreflightRun, RunOwner } from "../src/shared/types.ts";
import { gitInit, makeRepo, tempDir } from "./helpers.ts";

/**
 * run の中断（service.ts の cancelRun、p3 preflight --cancel --run [--acknowledge-stopped]、POST .../cancel）。
 * 最新でなくても中断でき、動いている別のプロセスには頼み、確かめられない run は人が確かめたときだけ中断にする
 */

const STATE = tempDir("p3-state-");
beforeAll(() => {
  process.env.XDG_STATE_HOME = STATE;
});
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const me = (): RunOwner => ({ instance: "i", boot: "b", pidNs: "1", pid: 100, start: "5" });
const probe = (starts: Record<number, string | null | undefined>): OwnerProbe => ({ self: me, startOf: (pid) => starts[pid] });

class Gate implements PreflightEngine {
  readonly name = "mock" as const;
  async status() {
    return { name: "mock" as const, ok: true, detail: "" };
  }
  async run(job: Parameters<PreflightEngine["run"]>[0], log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    await new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    return new MockEngine({ delay: 0 }).run(job, log, signal);
  }
}

async function project(engine: PreflightEngine = new MockEngine({ delay: 0 }), owner?: OwnerProbe) {
  const { dataDir } = await makeRepo();
  const ws = new Workspace(dataDir);
  await ws.load();
  const service = new PreflightService(ws, { mock: engine }, "mock", undefined, { probe: owner });
  const rid = (await ws.requests.create({ title: "評価", status: "draft", body: "- a\n" }, "test")).id;
  return { dataDir, ws, service, rid };
}

function patchRun(dataDir: string, rid: string, runId: string, patch: Partial<PreflightRun>) {
  const file = join(dataDir, "requests", rid, "preflight", runId, "run.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }, null, 2));
}

describe("run の中断（cancelRun）", () => {
  it("この serve で実行中の run は止める。完了した run は断り、終わった run は already", async () => {
    const { ws, service, rid } = await project(new Gate(), probe({}));
    const run = await service.start(rid);
    const r = await service.cancelRun(rid, run.id, { waitMs: 2000 });
    expect(r).toMatchObject({ state: "cancelled", run: { status: "failed", error: "中止しました" } });
    expect((await service.cancelRun(rid, run.id)).state).toBe("already");
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)?.status).toBe("draft");

    const done = await project();
    const ok = await done.service.start(done.rid);
    await done.service.wait(done.rid, ok.id);
    await expect(done.service.cancelRun(done.rid, ok.id)).rejects.toMatchObject({ code: "completed" });
    expect((await done.ws.preflight.get(done.rid, ok.id))?.status).toBe("completed");
  });

  it("無い run・形の違う ID・別の要望の run は、成功にせず見つからないとする", async () => {
    const { ws, service, rid } = await project();
    const other = (await ws.requests.create({ title: "別", status: "draft", body: "- b\n" }, "test")).id;
    const run = await service.start(other);
    await service.wait(other, run.id);
    for (const id of ["PF-nope", "../x", run.id]) await expect(service.cancelRun(rid, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.cancelRun("261103-zzzzz", run.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("動いているか確かめられない古い run: 頼むだけでは中断にせず、人が確かめたときだけ中断にする。最新の run と要望の状態は変えない", async () => {
    const { dataDir, ws, service, rid } = await project(new MockEngine({ delay: 0 }), probe({}));
    const old = await service.start(rid);
    await service.wait(rid, old.id);
    const latest = await service.start(rid);
    await service.wait(rid, latest.id);
    patchRun(dataDir, rid, old.id, { status: "running", finishedAt: undefined, owner: { ...me(), instance: "other" } });

    const asked = await service.cancelRun(rid, old.id, { actor: "human:a", waitMs: 50 });
    expect(asked).toMatchObject({ state: "requested", acknowledgeable: true, run: { status: "running", cancelRequested: { by: "human:a" } } });
    expect(asked.message).toContain("--acknowledge-stopped");
    expect(existsSync(join(dataDir, "requests", rid, "preflight", old.id, CANCEL_REQUEST_FILE))).toBe(true);
    expect((await service.withInputMatch(rid, (await ws.preflight.get(rid, old.id))!)).liveness).toMatchObject({ state: "unknown" });

    const acked = await service.cancelRun(rid, old.id, { acknowledgeStopped: true, actor: "human:a" });
    expect(acked).toMatchObject({ state: "cancelled", run: { status: "failed", interrupted: { acknowledgedBy: "human:a" } } });
    expect(acked.run.error).toContain("止まっていることを人が確かめました");
    // 中断した run には依頼を出さない（running でなければ読まない）
    expect(acked.run.cancelRequested).toBeUndefined();
    // 二度目は already
    expect((await service.cancelRun(rid, old.id, { acknowledgeStopped: true })).state).toBe("already");
    await ws.requests.reload(rid);
    expect(ws.requests.get(rid)).toMatchObject({ status: "reviewed", lastPreflight: latest.id });
    expect((await ws.preflight.get(rid, latest.id))?.status).toBe("completed");
  });

  it("動いている run に「止まっていることを確かめた」は使えない。終わったと確かめられる run はその場で中断にする", async () => {
    const gate = new Gate();
    const { service, rid } = await project(gate, probe({ 700: "1", 800: null }));
    const mine = await service.start(rid);
    await expect(service.cancelRun(rid, mine.id, { acknowledgeStopped: true })).rejects.toBeInstanceOf(CancelRefusedError);
    await service.cancelRun(rid, mine.id, { waitMs: 2000 });

    const b = await project(new MockEngine({ delay: 0 }), probe({ 700: "1", 800: null }));
    const r1 = await b.service.start(b.rid);
    await b.service.wait(b.rid, r1.id);
    patchRun(b.dataDir, b.rid, r1.id, { status: "running", finishedAt: undefined, owner: { ...me(), pid: 700, start: "1" } });
    await expect(b.service.cancelRun(b.rid, r1.id, { acknowledgeStopped: true })).rejects.toMatchObject({ code: "alive" });
    expect((await b.service.cancelRun(b.rid, r1.id, { waitMs: 50 })).state).toBe("requested");
    patchRun(b.dataDir, b.rid, r1.id, { owner: { ...me(), pid: 800, start: "1" } });
    expect(await b.service.cancelRun(b.rid, r1.id)).toMatchObject({ state: "cancelled", run: { status: "failed", interrupted: { reason: expect.stringContaining("800") } } });
  });

  it("API: 状態を返し、無い run は 404、完了した run は 409", async () => {
    const { ws, service, rid } = await project(new MockEngine({ delay: 0 }), probe({}));
    const ctx = { ws, preflight: service } as never;
    const app = apiRoutes(ctx);
    const call = async (path: string, body: unknown = {}) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-p3-actor": "human:web" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const run = await service.start(rid);
    await service.wait(rid, run.id);
    expect((await call(`/requests/${rid}/preflight/PF-none/cancel`)).status).toBe(404);
    expect(await call(`/requests/${rid}/preflight/${run.id}/cancel`)).toMatchObject({ status: 409, body: { code: "completed" } });
  });
});

describe("CLI（別のプロセス）からの中断", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  const CHILD = fileURLToPath(new URL("./fixtures/preflightChild.ts", import.meta.url));

  it.runIf(process.platform === "linux")("動いている別のプロセスの run に中断を頼み、止まったら cancelled。止まらない（応答しない）間は requested のまま", async () => {
    const root = tempDir("p3-cancel-");
    gitInit(root);
    const configHome = tempDir("p3-config-");
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: STATE, P3_ACTOR: "human:cli" };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
    };
    expect(p3(["init", "--yes", "--project", "c", "--dir", ".p3", "--repo-name", "main"]).code).toBe(0);
    const rid = p3(["request", "new", "評価", "--body", "- a", "--json"]).json().id as string;
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, join(root, ".p3"), rid], { stdio: ["ignore", "pipe", "pipe"], env });
    children.push(child);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    for (let i = 0; i < 300 && !out.includes("started"); i++) await sleep(50);
    const runId = out.match(/started (PF-\S+)/)![1];

    // 応答しない（止めている）間は requested のまま。成功にしない
    child.kill("SIGSTOP");
    const asked = p3(["preflight", rid, "--cancel", "--run", runId, "--json"]);
    expect(asked.code, asked.err).toBe(0);
    expect(asked.json()).toMatchObject({ state: "requested", status: "running", cancelRequested: { by: "human:cli" } });
    expect(asked.json().acknowledgeable).toBeUndefined();
    // 動いているので「止まっていることを確かめた」は使えない
    const ack = p3(["preflight", rid, "--cancel", "--run", runId, "--acknowledge-stopped", "--json"]);
    expect(ack.code).not.toBe(0);
    expect(ack.err).toContain("別のプロセスで動いています");
    expect(p3(["drafts", rid, "--json"]).json()).toMatchObject({ status: "running", next: { acknowledge: expect.stringContaining("--acknowledge-stopped") } });

    // 動き出すと依頼を見て止める
    child.kill("SIGCONT");
    for (let i = 0; i < 200 && !out.includes("finished"); i++) await sleep(50);
    expect(out).toContain("finished failed");
    const again = p3(["preflight", rid, "--cancel", "--run", runId, "--json"]).json();
    expect(again).toMatchObject({ state: "already", status: "failed", error: "中止しました" });
    const shown = p3(["drafts", rid]).out;
    expect(shown).toContain("始め直す: p3 preflight");
    // 使い方の誤り
    expect(p3(["preflight", rid, "--acknowledge-stopped"]).err).toContain("--cancel --run");
  }, 40_000);

  it("CLI の --cancel でも、終わったと確かめられる run をその場で中断にし、drafts に理由と次のコマンドを出す", async () => {
    const root = tempDir("p3-cancel-");
    gitInit(root);
    const configHome = tempDir("p3-config-");
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: STATE };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
    };
    expect(p3(["init", "--yes", "--project", "c", "--dir", ".p3", "--repo-name", "main"]).code).toBe(0);
    const rid = p3(["request", "new", "評価", "--body", "- a", "--json"]).json().id as string;
    expect(p3(["preflight", rid, "--engine", "mock", "--json"]).code).toBe(0);
    const runId = p3(["drafts", rid, "--json"]).json().id as string;
    // 終わった CLI のプロセスが残したことにする（記録はその CLI の pid。もう終わっている）
    patchRun(join(root, ".p3"), rid, runId, { status: "running", finishedAt: undefined });
    const r = p3(["preflight", rid, "--cancel", "--run", runId, "--json"]);
    expect(r.code, r.err).toBe(0);
    expect(r.json()).toMatchObject({ state: "cancelled", status: "failed", interrupted: { reason: expect.any(String) } });
    const shown = p3(["drafts", rid]).out;
    expect(shown).toMatch(/中断: .*実行していたプロセスが終わっていた/);
    expect(shown).toContain(`始め直す: p3 preflight ${rid}`);
  });
});
