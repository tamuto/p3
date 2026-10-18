import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { PreflightPulse } from "../src/shared/types.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";

/**
 * 画面（serve）と外（CLI）が同じデータのフォルダを開く。画面の側は監視していないので、外の変更はキャッシュに入らない
 */
async function twoSides() {
  const { dataDir } = await makeRepo();
  const viewer = await openTestProject(dataDir);
  const api = apiRoutes(viewer);
  const req = await newRequest(viewer, { title: "CSV を書き出したい", body: "- 一覧から" });
  // 外の CLI（別の Workspace）。実行中を見られるように少し待つ mock
  const cli = await openTestProject(dataDir, { mock: new MockEngine({ delay: 0.1 }) });
  const pulse = async (q = ""): Promise<PreflightPulse> => {
    const r = await api.request(`/requests/${req.id}/preflight-status${q}`);
    expect(r.status).toBe(200);
    return (await r.json()) as PreflightPulse;
  };
  return { dataDir, viewer, api, cli, req, pulse, runDir: (run: string) => join(dataDir, "requests", req.id, "preflight", run) };
}

describe("最新の Preflight の今の状態（監視に頼らない軽い確かめ）", () => {
  it("外で始めた run を見つけ、実行中から完了へ、2回目以降の新しい run へと追う。キャッシュもファイルも変えない", async () => {
    const { viewer, cli, req, pulse } = await twoSides();
    expect(await pulse()).toEqual({ requestId: req.id, state: "ok", latest: null });

    const first = await cli.preflight.start(req.id, { engine: "mock" });
    const running = await pulse();
    expect(running.latest).toMatchObject({ id: first.id, state: "ready", status: "running" });
    await cli.preflight.wait(req.id, first.id);
    const done = await pulse();
    expect(done.latest).toMatchObject({ id: first.id, state: "ready", status: "completed" });
    expect(done.latest!.finishedAt).toBeTruthy();
    expect(done.latest!.version).not.toBe(running.latest!.version);
    // 画面の側のキャッシュは古いまま（監視していない）でも、最新が分かる
    expect(viewer.ws.requests.get(req.id)!.lastPreflight).toBeUndefined();

    // 2回目・3回目（要望のファイルは置き換えて保存される）
    for (let i = 0; i < 2; i++) {
      const prev = (await pulse()).latest!.id;
      const next = await cli.preflight.start(req.id, { engine: "mock" });
      await cli.preflight.wait(req.id, next.id);
      const p = await pulse(`?run=${prev}`);
      expect(p.latest).toMatchObject({ id: next.id, status: "completed" });
      // 見ている（前の）run の状態も添える
      expect(p.run).toMatchObject({ id: prev, state: "ready", status: "completed" });
    }

    // 確かめても、要望のファイル・rev・画面の側のキャッシュは変わらない
    const file = cli.ws.requests.path(req.id);
    const before = { text: await readFile(file, "utf8"), mtime: (await stat(file)).mtimeMs, cached: viewer.ws.requests.get(req.id) };
    await pulse();
    expect(await readFile(file, "utf8")).toBe(before.text);
    expect((await stat(file)).mtimeMs).toBe(before.mtime);
    expect(viewer.ws.requests.get(req.id)).toBe(before.cached);
  });

  it("失敗した run・保存の途中・壊れた run.json と直したあと・無い run を分ける", async () => {
    const { cli, req, pulse, runDir } = await twoSides();
    const { id } = await cli.preflight.start(req.id, { engine: "mock" });
    await cli.preflight.wait(req.id, id);
    const meta = JSON.parse(await readFile(join(runDir(id), "run.json"), "utf8"));
    await writeFile(join(runDir(id), "run.json"), JSON.stringify({ ...meta, status: "failed", error: "x" }));
    expect((await pulse()).latest).toMatchObject({ id, state: "ready", status: "failed" });

    await writeFile(join(runDir(id), "run.json"), "{ 壊れた");
    expect((await pulse()).latest).toEqual({ id, state: "broken" });
    await writeFile(join(runDir(id), "run.json"), JSON.stringify(meta));
    expect((await pulse()).latest).toMatchObject({ id, state: "ready", status: "completed" });

    // lastPreflight が指す run のフォルダはあるが run.json がまだ無い（保存の途中）
    const saving = "PF-20991231-235959-abcd";
    await mkdir(runDir(saving), { recursive: true });
    await cli.ws.requests.update(req.id, { lastPreflight: saving });
    expect((await pulse()).latest).toEqual({ id: saving, state: "pending" });
    // 指定した run が無い
    expect((await pulse("?run=PF-20000101-000000-0000")).run).toEqual({ id: "PF-20000101-000000-0000", state: "missing" });
  });

  it("要望が読めない・アーカイブした・消えたときを分け、ID の形が違えば 400", async () => {
    const { api, cli, req, pulse, dataDir } = await twoSides();
    const file = cli.ws.requests.path(req.id);
    const text = await readFile(file, "utf8");
    await writeFile(file, "---\n: [\n---\n");
    expect(await pulse()).toEqual({ requestId: req.id, state: "broken", latest: null });
    await writeFile(file, text);
    expect((await pulse()).state).toBe("ok");

    await cli.ws.requests.archive(req.id);
    expect(await pulse()).toEqual({ requestId: req.id, state: "gone", latest: null });
    await rm(join(dataDir, "requests", req.id), { recursive: true, force: true });
    expect((await pulse()).state).toBe("gone");

    expect((await api.request("/requests/not-an-id/preflight-status")).status).toBe(400);
    for (const run of ["../../etc", "PF-..%2F", "x"]) {
      expect((await api.request(`/requests/${req.id}/preflight-status?run=${run}`)).status, run).toBe(400);
    }
  });

  it("画面からの保存と並んでも、確かめたことでキャッシュを古い内容に戻さない", async () => {
    const { viewer, api, req, pulse } = await twoSides();
    const r = await api.request(`/requests/${req.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "画面で直した", rev: req.rev }),
    });
    expect(r.status).toBe(200);
    const saved = viewer.ws.requests.get(req.id)!;
    await Promise.all([pulse(), pulse(), viewer.ws.requests.update(req.id, { body: "続けて直した" })]);
    expect(viewer.ws.requests.get(req.id)).toMatchObject({ title: "画面で直した", body: "続けて直した", rev: saved.rev + 1 });
  });
});
