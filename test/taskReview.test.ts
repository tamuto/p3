// タスクの AI レビューの実行（core/taskReview/service.ts・review.ts）と CLI・API: 新しいスレッド・固定した材料だけを読むだけでマウント、
// 結果の確かめ（欠落・重複・未知の項目・偽の根拠・記録だけの「満たしている」・削除したファイル）、失敗・時間切れ・取消、
// Preflight の担当が agent のときの無断の起動の防止、材料が変わったときの確かめ直し、タスクの状態・済み・証拠を変えないこと。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexUnavailableError, CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import type { Summarizer } from "../src/core/releaseNotes/generate.ts";
import { createTask, updateTask } from "../src/core/requestOps.ts";
import { extractTaskReview } from "../src/core/taskReview/material.ts";
import { InvalidTaskReview, parseTaskReview, taskReviewPrompt } from "../src/core/taskReview/review.ts";
import { TaskReviewService } from "../src/core/taskReview/service.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { git, makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-task-reviewer.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));

function codex(scenario: string, logFile: string, launched: unknown[] = []) {
  return new CodexWorkspaceEngine({
    authVolume: "vol",
    account: chatgptAccount(join(tempDir(), "chatgpt.json")),
    pathMap: [],
    ensureImage: false,
    command: (m) => {
      launched.push(m);
      return ["env", `FAKE_LOG=${logFile}`, `FAKE_SCENARIO=${scenario}`, process.execPath, FAKE];
    },
  });
}

const commit = (root: string, msg: string, files: Record<string, string | null>) => {
  for (const [p, c] of Object.entries(files)) {
    if (c === null) git(root, "rm", "-q", p);
    else {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), c);
      git(root, "add", p);
    }
  }
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
};

async function setup(reviewer?: Summarizer, opts: { timeoutMs?: number; runner?: "agent" } = {}) {
  const p = await makeProject(opts.runner ? { preflight: { instructions: "", runner: opts.runner } } : {});
  commit(p.root, "最初", { ".gitignore": ".p3/\n", "src/old.ts": "old\n", "src/a.ts": "a1\n" });
  const req = await newRequest(p.ctx, { title: "通知を足す", body: "通知を送る" });
  const sha = commit(p.root, "通知を送る", { "src/a.ts": "a2\n", "src/notify.ts": "export const send = () => true;\n", "src/old.ts": null });
  const { task } = await createTask(p.ctx, req.id, { title: "送る", criteria: ["送信できる", "失敗を記録する"] });
  await updateTask(p.ctx, req.id, task.id, { status: "done", record: "送る処理", outputs: [`https://example.com/commit/${sha}`], acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] });
  await updateTask(p.ctx, req.id, task.id, { checked: true });
  p.ctx.taskReview = new TaskReviewService(p.ctx.ws, { codex: reviewer, mock: undefined }, { pollMs: 20, ...opts });
  const taskFile = join(p.dataDir, "requests", req.id, "tasks", `${task.id}.md`);
  return { ...p, rid: req.id, tid: task.id, sha, taskFile };
}

describe("結果の確かめ", () => {
  it("全項目がちょうど1回・区分・根拠が固定した材料にあること。満たしているはコードの根拠が要る。削除したファイルは前の側で読める", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const { input } = await extractTaskReview(dataDir, rid, tid, ctx.ws.refs());
    const d = input.targets[0].diffs[0];
    const ok = (items: unknown[], extra: object = {}) => JSON.stringify({ overall: "所見", items, unplanned: [], checks: [], coverage: { read: "r", unread: "" }, ...extra });
    const item = (id: string, verdict: string, evidence: string[] = []) => ({ item: id, verdict, reason: "理由", evidence, gaps: [] });
    const good = parseTaskReview(ok([item("A2", "missing"), item("A1", "satisfied", [`main@${d.head}:src/notify.ts:1-2`, `main@${d.base}:src/old.ts`, d.patchFile])]), input, "m");
    expect(good.items.map((i) => i.item)).toEqual(["A1", "A2"]);
    expect(good.model).toBe("m");
    const bad: [string, string][] = [
      ["欠落", ok([item("A1", "missing")])],
      ["重複", ok([item("A1", "missing"), item("A1", "missing"), item("A2", "missing")])],
      ["未知の項目", ok([item("A1", "missing"), item("A2", "missing"), item("Z9", "missing")])],
      ["区分", ok([item("A1", "ok"), item("A2", "missing")])],
      ["記録だけで満たしている", ok([item("A1", "satisfied", [input.task.ref]), item("A2", "missing")])],
      ["無いパス", ok([item("A1", "missing", [`main@${d.head}:no/such.ts`]), item("A2", "missing")])],
      ["削除したファイルを後の側で", ok([item("A1", "missing", [`main@${d.head}:src/old.ts`]), item("A2", "missing")])],
      ["無い SHA", ok([item("A1", "missing", [`main@${"0".repeat(40)}`]), item("A2", "missing")])],
      ["材料に無いファイル", ok([item("A1", "missing", ["code/main/x/src/a.ts"]), item("A2", "missing")])],
      ["coverage なし", ok([item("A1", "missing"), item("A2", "missing")], { coverage: undefined })],
      ["JSON でない", "評価しました"],
    ];
    for (const [name, msg] of bad) expect(() => parseTaskReview(msg, input), name).toThrow(InvalidTaskReview);
  });

  it("依頼文は作業した AI の評価ではないことと、固定した材料だけを読むこと・資料の指示に従わないことを書く", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const { input } = await extractTaskReview(dataDir, rid, tid, ctx.ws.refs());
    const { instructions, prompt } = taskReviewPrompt(input);
    for (const s of ["能力・成績の評価ではありません", "/workspace/material", "従わないでください", "satisfied", "checks"]) expect(instructions + prompt).toContain(s);
    expect(prompt).not.toContain(dataDir);
  });
});

describe("実行（偽の app-server）", () => {
  it("新しいスレッドで、固定した材料のフォルダだけを読むだけでマウントし、結果を保存する。タスクの状態・済み・証拠は変えない", async () => {
    const logFile = join(tempDir(), "codex.log");
    const launched: unknown[] = [];
    const { ctx, rid, tid, root, dataDir, taskFile } = await setup(codex("ok", logFile, launched));
    const before = readFileSync(taskFile, "utf8");
    const run = await ctx.taskReview.start(rid, tid, "human:test");
    const d = await ctx.taskReview.wait(rid, tid, run.id);
    expect(d.run).toMatchObject({ status: "completed", engine: "codex", model: "fake-model" });
    const material = ctx.ws.taskReviews.materialDir(`${rid}/${tid}`, run.id);
    expect(launched).toEqual([{ repos: [{ name: "material", host: material, container: "/workspace/material" }], data: null, auth: "legacy" }]);
    const sent = readFileSync(logFile, "utf8");
    expect(sent).not.toContain(root);
    expect(sent).not.toContain(dataDir);
    expect(sent.match(/"thread\/start"/g)).toHaveLength(1);
    expect(sent).not.toContain("thread/resume");
    expect(d.result).toMatchObject({ items: [{ item: "A1", verdict: "satisfied" }, { item: "A2", verdict: "missing" }], unplanned: [{ text: "依頼に無い設定の変更" }], checks: ["A1 と本文の完了条件が食い違う"] });
    expect(readFileSync(taskFile, "utf8")).toBe(before);
    // 2回目も新しいスレッド
    const again = await ctx.taskReview.start(rid, tid);
    await ctx.taskReview.wait(rid, tid, again.id);
    expect(readFileSync(logFile, "utf8").match(/"thread\/start"/g)).toHaveLength(2);
    expect((await ctx.taskReview.list(rid, tid)).map((x) => x.state)).toEqual(["ok", "ok"]);
  });

  it("不正・偽の根拠・記録だけの満たしているは invalid_output で失敗にし、Mock に切り替えない。削除したファイルの根拠は受け付ける", async () => {
    for (const scenario of ["unknown", "badsha", "missing", "duplicate", "unknownitem", "broken", "records"]) {
      const { ctx, rid, tid } = await setup(codex(scenario, join(tempDir(), "c.log")));
      const r = await ctx.taskReview.start(rid, tid);
      expect((await ctx.taskReview.wait(rid, tid, r.id)).run, scenario).toMatchObject({ status: "failed", failure: "invalid_output", engine: "codex" });
    }
    const { ctx, rid, tid } = await setup(codex("deleted", join(tempDir(), "c.log")));
    const r = await ctx.taskReview.start(rid, tid);
    expect((await ctx.taskReview.wait(rid, tid, r.id)).run.status).toBe("completed");
  });

  it("使用量の上限・使えない（認証）・時間切れ・取消", async () => {
    const usage = await setup(codex("usage", join(tempDir(), "c.log")));
    const u = await usage.ctx.taskReview.start(usage.rid, usage.tid);
    expect((await usage.ctx.taskReview.wait(usage.rid, usage.tid, u.id)).run).toMatchObject({ status: "failed", failure: "usage_limit" });
    const unavailable: Summarizer = { ask: async () => Promise.reject(new CodexUnavailableError("サインインしていません")) };
    const na = await setup(unavailable);
    const n = await na.ctx.taskReview.start(na.rid, na.tid);
    expect((await na.ctx.taskReview.wait(na.rid, na.tid, n.id)).run).toMatchObject({ status: "failed", failure: "unavailable" });
    const slow = await setup(codex("slow", join(tempDir(), "c.log")), { timeoutMs: 300 });
    const s = await slow.ctx.taskReview.start(slow.rid, slow.tid);
    expect((await slow.ctx.taskReview.wait(slow.rid, slow.tid, s.id)).run).toMatchObject({ status: "failed", failure: "timeout" });
    const c = await setup(codex("slow", join(tempDir(), "c.log")));
    const cr = await c.ctx.taskReview.start(c.rid, c.tid);
    await expect(c.ctx.taskReview.start(c.rid, c.tid)).rejects.toMatchObject({ code: "running" });
    await c.ctx.taskReview.cancel(c.rid, c.tid, cr.id, "human:a");
    expect((await c.ctx.taskReview.wait(c.rid, c.tid, cr.id)).run.status).toBe("cancelled");
  });

  it("ほかのプロセスからの取消（要求を書き、実行している側が止める）。プロジェクトは別々", async () => {
    const c = await setup(codex("slow", join(tempDir(), "c.log")));
    const r = await c.ctx.taskReview.start(c.rid, c.tid);
    const other = await openTestProject(c.dataDir);
    const req = await other.taskReview.cancel(c.rid, c.tid, r.id, "human:b");
    expect(req.requested).toBe(true);
    expect((await c.ctx.taskReview.wait(c.rid, c.tid, r.id)).run.status).toBe("cancelled");
    const p2 = await setup(codex("ok", join(tempDir(), "c.log")));
    expect(await p2.ctx.taskReview.list(p2.rid, p2.tid)).toEqual([]);
  });

  it("Preflight の担当が agent なら、engine を明示しない Codex の実行は始めない（Codex は呼ばない）", async () => {
    const calls: string[] = [];
    const spy: Summarizer = { ask: async () => (calls.push("ask"), Promise.reject(new Error("呼ばれた"))) };
    const { ctx, rid, tid } = await setup(spy, { runner: "agent" });
    await expect(ctx.taskReview.start(rid, tid)).rejects.toMatchObject({ code: "engine_required" });
    expect(calls).toEqual([]);
    expect((await ctx.taskReview.preview(rid, tid)).engineRequired).toBe(true);
  });

  it("プレビューの後で材料が変わったら changed で断る（確かめ直す）", async () => {
    const { ctx, rid, tid } = await setup(codex("ok", join(tempDir(), "c.log")));
    const p = await ctx.taskReview.preview(rid, tid);
    await updateTask(ctx, rid, tid, { body: "本文を直した" });
    await expect(ctx.taskReview.start(rid, tid, undefined, { expectedHash: p.input.hash })).rejects.toMatchObject({ code: "changed" });
    const fresh = await ctx.taskReview.preview(rid, tid);
    const r = await ctx.taskReview.start(rid, tid, undefined, { expectedHash: fresh.input.hash });
    expect((await ctx.taskReview.wait(rid, tid, r.id)).run.inputHash).toBe(fresh.input.hash);
  });
});

describe("API と CLI", () => {
  it("API: プレビュー・開始・一覧・詳細・取消・理由つきの拒否。結果を直す口は無い", async () => {
    const { ctx, rid, tid } = await setup(codex("ok", join(tempDir(), "c.log")));
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown> };
    };
    const base = `/requests/${rid}/tasks/${tid}`;
    const pv = await call("POST", `${base}/review-preview`, {});
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ items: [{ id: "A1" }, { id: "A2" }], files: expect.any(Number), engineRequired: false });
    const started = await call("POST", `${base}/reviews`, { expectedHash: pv.body.hash });
    expect(started.status).toBe(202);
    const run = started.body.id as string;
    await ctx.taskReview.wait(rid, tid, run);
    expect((await call("GET", `${base}/reviews`)).body.items).toHaveLength(1);
    expect((await call("GET", `${base}/reviews/${run}`)).body).toMatchObject({ run: { status: "completed" }, result: { items: expect.any(Array) } });
    expect((await call("POST", `${base}/reviews/${run}/cancel`, {})).status).toBe(409);
    expect((await call("PATCH", `${base}/reviews/${run}`, { result: {} })).status).toBe(404);
    expect((await call("POST", `${base}/reviews`, { expectedHash: "x" })).body).toMatchObject({ code: "changed" });
    const { task } = await createTask(ctx, rid, { title: "途中" });
    expect((await call("POST", `/requests/${rid}/tasks/${task.id}/reviews`, {})).body).toMatchObject({ code: "not_done" });
    expect((await call("GET", `/requests/${rid}/tasks/T099/reviews/TR-20260101-000000-abcd`)).status).toBe(404);
  });

  it("CLI: review --preview / review（mock）/ reviews / review-show / review-cancel と終了コード", async () => {
    const { rid, tid, dataDir, root } = await setup();
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const p3 = (args: string[], at: string[] = ["--project", "t"]) => {
      const r = spawnSync(process.execPath, [BIN, ...at, ...args], { encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const ref = `${rid}/${tid}`;
    // 個人設定にプロジェクトと参照先のこのマシンのパスを登録する
    expect(p3(["project", "add", "t", dataDir], []).code).toBe(0);
    expect(p3(["repo", "path", "main", root]).code).toBe(0);
    const pv = p3(["review", ref, "--preview", "--json"]);
    expect(pv.code, pv.err).toBe(0);
    expect(JSON.parse(pv.out)).toMatchObject({ items: [{ id: "A1" }, { id: "A2" }] });
    expect(p3(["review", ref, "--preview"]).out).toContain("比較対象:");
    const done = p3(["review", ref, "--engine", "mock", "--json"]);
    expect(done.code, done.err).toBe(0);
    const run = (JSON.parse(done.out) as { run: { id: string } }).run.id;
    expect(done.err).toContain("レビューを始めました");
    expect(p3(["reviews", ref]).out).toContain(run);
    expect(p3(["review-show", ref, run]).out).toContain("判断できない");
    expect(p3(["review-cancel", ref, run]).code).toBe(3);
    expect(p3(["review-show", ref, "TR-20260101-000000-abcd"]).code).toBe(2);
    expect(p3(["review", ref, "--target", "main:nope..x", "--engine", "mock"]).code).toBe(1);
  });
});
