import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import { DOCKER_LIMITS } from "../src/core/preflight/docker.ts";
import { makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * 評価のコンテナ（261103-gtfcg/T003）: docker run に名前とラベルを付けて起こし、正常に終わっても、中止・時間切れで終わっても、
 * そのコンテナだけを消す。中止を頼んでも app-server が答えなければ打ち切る
 */

const FAKE = fileURLToPath(new URL("./fixtures/fake-docker-appserver.mjs", import.meta.url));
const grace = DOCKER_LIMITS.abortGraceMs;
afterEach(() => {
  DOCKER_LIMITS.abortGraceMs = grace;
});

function fakeDocker(mode: "ok" | "stuck") {
  const dir = tempDir("p3-dockerc-");
  const docker = join(dir, "docker");
  const containers = join(dir, "containers.json");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(containers, JSON.stringify(["someone-else"]));
  writeFileSync(docker, `#!/bin/sh\nFAKE_CONTAINERS='${containers}' FAKE_CALLS='${calls}' FAKE_MODE='${mode}' exec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(docker, 0o755);
  return {
    docker,
    containers: () => JSON.parse(readFileSync(containers, "utf8")) as string[],
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []),
  };
}

async function start(d: ReturnType<typeof fakeDocker>) {
  const repo = await makeRepo();
  const codex = new CodexWorkspaceEngine({
    authVolume: "vol",
    account: chatgptAccount(join(tempDir(), "none.json")),
    pathMap: [],
    ensureImage: false,
    command: () => [d.docker, "run", "-i", "--rm", "img"],
  });
  const ctx = await openTestProject(repo.dataDir, { codex });
  const req = await newRequest(ctx, { title: "x", status: "draft" });
  const run = await ctx.preflight.start(req.id);
  return { ctx, rid: req.id, id: run.id };
}

describe("評価のコンテナの名前と後片付け", () => {
  it("名前とラベルを付けて起こし、終わったら（--rm で消えていれば）何も言わない。ほかのコンテナには触れない", async () => {
    const d = fakeDocker("ok");
    const { ctx, rid, id } = await start(d);
    const run = (await ctx.preflight.wait(rid, id))!;
    const runCall = d.calls().find((a) => a[0] === "run")!;
    const name = runCall[runCall.indexOf("--name") + 1];
    expect(name).toMatch(/^p3-preflight-[0-9a-f]{6}$/);
    expect(runCall).toEqual(expect.arrayContaining(["--label", "infodb.p3=preflight"]));
    expect(d.calls().filter((a) => a[0] === "rm")).toEqual([["rm", "-f", name]]);
    expect(d.containers()).toEqual(["someone-else"]);
    expect(run.log.map((l) => l.text).join("\n")).not.toContain("コンテナ p3-");
  });

  it("中止を頼んでも app-server が答えなければ打ち切り、残ったそのコンテナだけを消す", async () => {
    DOCKER_LIMITS.abortGraceMs = 200;
    const d = fakeDocker("stuck");
    const { ctx, rid, id } = await start(d);
    for (let i = 0; i < 200 && !(await ctx.ws.preflight.get(rid, id).then(() => d.calls().some((a) => a[0] === "run"))); i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300)); // ターンを始めるまで
    const t0 = Date.now();
    const r = await ctx.preflight.cancelRun(rid, id, { waitMs: 15_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r).toMatchObject({ state: "cancelled", run: { status: "failed", error: "中止しました" } });
    const name = d.calls().find((a) => a[0] === "run")!.at(d.calls().find((a) => a[0] === "run")!.indexOf("--name") + 1)!;
    const log = r.run.log.map((l) => l.text).join("\n");
    expect(log).toContain("app-server が 0.2 秒で止まらないので打ち切ります");
    expect(log).toContain(`コンテナ ${name} が残っていたので消しました`);
    expect(d.containers()).toEqual(["someone-else"]);
  }, 30_000);
});
