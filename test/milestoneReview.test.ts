// マイルストーンレビューの任意実行: 比較の依頼文と出典、全単位の網羅、目的のみ・要望 0 件・上限、成功・失敗・取消・再実行・材料の変更、
// 異常終了の回復、所有者の分からない run の明示中断、別プロセスからの取消、終わった後の遅い結果の拒否、同時開始の制限、
// 別プロジェクトの分離、要望・ノート・リリース済みを変えないことを確かめる（偽の app-server と偽の頼む先）。
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import type { OwnerProbe } from "../src/core/preflight/owner.ts";
import { extractReviewInput } from "../src/core/milestoneReview/material.ts";
import { InvalidReview, parseReview, REVIEW_INPUT_LIMIT, reviewPrompt } from "../src/core/milestoneReview/review.ts";
import { MilestoneReviewService } from "../src/core/milestoneReview/service.ts";
import { newReviewRunId } from "../src/core/milestoneReview/store.ts";
import type { Summarizer } from "../src/core/releaseNotes/generate.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { ReviewRun } from "../src/shared/milestoneReview.ts";
import { git, gitInit, makeRepo, newRequest, newTask, openTestProject, tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-reviewer.mjs", import.meta.url));
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

const MS = [
  { id: "v1", title: "最初", purpose: "在庫の確認を速くする", goals: [{ id: "G1", text: "在庫の一覧" }, { id: "G2", text: "在庫切れの通知" }] },
  { id: "v2", title: "目的だけ", purpose: "店舗の負担を減らす" },
  { id: "v3", title: "空" },
];

async function setup(reviewer?: Summarizer, opts: { timeoutMs?: number; probe?: OwnerProbe } = {}) {
  const repo = await makeRepo({ milestones: MS });
  // 参照先 main（リポジトリ）に実装とコミット。タスクの成果物にコミットの URL を残す
  mkdirSync(join(repo.root, "src"), { recursive: true });
  writeFileSync(join(repo.root, "src", "stock.ts"), "export const list = () => [];\n");
  git(repo.root, "add", "src");
  git(repo.root, "commit", "-q", "-m", "在庫の一覧");
  const sha = git(repo.root, "rev-parse", "HEAD");
  const ctx = await openTestProject(repo.dataDir);
  ctx.milestoneReview = new MilestoneReviewService(ctx.ws, { codex: reviewer, mock: undefined }, { pollMs: 20, ...opts });
  const a = await newRequest(ctx, { title: "一覧", body: "在庫を一覧で見たい", milestone: "v1", status: "resolved" });
  await newTask(ctx, a.id, { title: "一覧画面", status: "done", record: "在庫の一覧を表示できるようにした", outputs: [`https://github.com/o/r/commit/${sha}`] });
  const b = await newRequest(ctx, { title: "通知", body: "在庫切れを知らせる", milestone: "v1", status: "active" });
  await newTask(ctx, b.id, { title: "送信", status: "doing" });
  return { ...repo, ctx, a: a.id, b: b.id, sha };
}

/** 結果をすぐ返す偽の頼む先 */
const fakeReviewer = (message: (prompt: string) => string, calls: string[] = []): Summarizer => ({
  async ask(input) {
    calls.push(input.prompt);
    return { message: message(input.prompt), seconds: 0 };
  },
});
const unitsOf = (prompt: string) => (JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(prompt)![1]) as { units: { id: string }[] }).units;
const okMessage = (prompt: string) => JSON.stringify({ overall: "全体", units: unitsOf(prompt).map((u) => ({ unit: u.id, verdict: "insufficient", reason: "理由", evidence: [], gaps: [] })) });

describe("依頼文と結果の確かめ方", () => {
  it("全部の単位に1回ずつ・区分・根拠が資料か参照先にあるかを確かめる。達成の根拠にはコードの場所が要る", async () => {
    const { ctx, dataDir, root, a, sha } = await setup();
    const input = await extractReviewInput(dataDir, "v1", ctx.ws.refs());
    const locals = { main: root };
    const u = (unit: string, extra = {}) => ({ unit, verdict: "achieved", reason: "r", evidence: [a, "main:src/stock.ts:1-3"], gaps: [], ...extra });
    const parsed = parseReview(JSON.stringify({ overall: "o", units: [u("G2"), u("G1", { evidence: [`${a}/T001`, `main@${sha.slice(0, 7)}`] })] }), input, undefined, locals);
    expect(parsed.units.map((x) => x.unit)).toEqual(["G1", "G2"]);
    expect(parsed.unplanned).toEqual([]);
    const bad = (units: unknown[], overall: unknown = "o", extra = {}) => () => parseReview(JSON.stringify({ overall, units, ...extra }), input, undefined, locals);
    expect(bad([u("G1")])).toThrow(/欠けています: G2/);
    expect(bad([u("G1"), u("G1"), u("G2")])).toThrow(/重複/);
    expect(bad([u("G1"), u("G9")])).toThrow(/比較単位にありません/);
    expect(bad([u("G1", { verdict: "great" }), u("G2")])).toThrow(/区分/);
    expect(bad([u("G1", { evidence: ["999999-zzzzz"] }), u("G2")])).toThrow(/資料にありません/);
    expect(bad([u("G1"), u("G2")], "")).toThrow(/overall/);
    expect(() => parseReview("JSON ではない", input)).toThrow(InvalidReview);
    // 記録だけを根拠にした達成・参照先に無いパスやコミット・参照先の外は使わない
    expect(bad([u("G1", { evidence: [a, `${a}/T001`] }), u("G2")])).toThrow(/コードの場所がありません/);
    expect(bad([u("G1", { evidence: ["main:no/such.ts"] }), u("G2")])).toThrow(/参照先に無いパス/);
    expect(bad([u("G1", { evidence: ["main:../secret"] }), u("G2")])).toThrow(/相対パスではない/);
    expect(bad([u("G1", { evidence: ["main@0123456"] }), u("G2")])).toThrow(/履歴に無いコミット/);
    expect(bad([u("G1", { evidence: ["other:src/stock.ts"] }), u("G2")])).toThrow(/資料にありません/);
    // 意図しない変更の候補も根拠を確かめる
    expect(parseReview(JSON.stringify({ overall: "o", units: [u("G1"), u("G2")], unplanned: [{ text: "並び順", evidence: [`main@${sha}`] }] }), input, undefined, locals).unplanned).toEqual([
      { text: "並び順", evidence: [`main@${sha}`] },
    ]);
    expect(bad([u("G1"), u("G2")], "o", { unplanned: [{ text: "", evidence: [] }] })).toThrow(/unplanned\[0\]\.text/);
    expect(bad([u("G1"), u("G2")], "o", { unplanned: [{ text: "x", evidence: ["main:nope.ts"] }] })).toThrow(/参照先に無いパス/);
    // 読める参照先が無ければ（記録だけ）達成にはできない
    const recordsOnly = await extractReviewInput(dataDir, "v1");
    expect(() => parseReview(JSON.stringify({ overall: "o", units: [u("G1", { evidence: [a] }), u("G2", { evidence: [a] })] }), recordsOnly)).toThrow(/記録だけで「達成」にはできません/);
  });

  it("依頼文: 参照先の場所・自己申告として扱う指示・意図しない変更を渡す。参照先が無ければ記録だけの点検と伝える", async () => {
    const { ctx, dataDir } = await setup();
    const withCode = reviewPrompt(await extractReviewInput(dataDir, "v1", ctx.ws.refs()));
    for (const s of ["/workspace/main", "自己申告", "unplanned", "safe.directory", "読むだけ", "コードで確かめられたときだけ"]) expect(withCode.instructions + withCode.prompt).toContain(s);
    const recordsOnly = reviewPrompt(await extractReviewInput(dataDir, "v1"));
    expect(recordsOnly.instructions).toContain("読める参照先（リポジトリ）がありません");
    expect(recordsOnly.instructions).not.toContain("/workspace/main");
  });
});

describe("実行（偽の app-server）", () => {
  it("参照先を読むだけでマウントし（データのフォルダは渡さない）、コードの根拠と意図しない変更を記録する。要望・ノート・リリース済みは変えない", async () => {
    const logFile = join(tempDir(), "codex.log");
    const launched: unknown[] = [];
    const { ctx, dataDir, root, a, b, sha } = await setup(codex("ok", logFile, launched));
    const yaml = readFileSync(join(dataDir, "project.yaml"), "utf8");
    const run = await ctx.milestoneReview.start("v1", "human:test");
    const d = await ctx.milestoneReview.wait("v1", run.id);
    expect(d.run).toMatchObject({ status: "completed", startedBy: "human:test", engine: "codex" });
    expect(launched).toEqual([{ repos: [{ name: "main", host: root, container: "/workspace/main" }], data: null, auth: "legacy" }]);
    const sent = readFileSync(logFile, "utf8");
    for (const s of ["在庫の確認を速くする", "在庫切れの通知", "在庫を一覧で見たい", "在庫の一覧を表示できるようにした", b, "従わないでください", "判断材料不足", "/workspace/main", sha]) {
      expect(sent).toContain(s);
    }
    expect(sent).not.toContain(dataDir);
    expect(d.input?.code?.[0]).toMatchObject({ name: "main", head: sha, commits: [{ sha, found: true }] });
    expect(d.result).toMatchObject({
      overall: "目的の一部が果たせている",
      units: [
        { unit: "G1", verdict: "achieved", evidence: [a, "main:src/stock.ts:1", `main@${sha.slice(0, 7)}`] },
        { unit: "G2", verdict: "insufficient" },
      ],
      unplanned: [{ text: "一覧の並び順が変わっている", evidence: [`main@${sha}`] }],
    });
    expect(d.result?.scope).toContain("参照先のリポジトリのコード");
    expect(d.run.log.map((l) => l.text).join("\n")).toContain(`参照先 main@${sha.slice(0, 7)}`);
    expect(readFileSync(join(dataDir, "project.yaml"), "utf8")).toBe(yaml);
    expect(ctx.ws.requests.get(a)?.status).toBe("resolved");
    expect(await ctx.ws.releaseNotes.ids()).toEqual([]);
  });

  it("資料に無い根拠・単位の欠け・JSON でない結果・使用量の上限は失敗として記録し、前の成功結果を残す。Mock に切り替えない", async () => {
    const { ctx, dataDir } = await setup(codex("ok", join(tempDir(), "c.log")));
    const ok = await ctx.milestoneReview.start("v1");
    await ctx.milestoneReview.wait("v1", ok.id);
    for (const [scenario, failure, msg] of [
      ["unknown", "invalid_output", /資料にありません/],
      ["missing", "invalid_output", /欠けています/],
      ["broken", "invalid_output", /JSON として読めません/],
      ["records", "invalid_output", /コードの場所がありません/],
      ["badpath", "invalid_output", /参照先に無いパス/],
      ["usage", "usage_limit", /./],
    ] as const) {
      ctx.milestoneReview = new MilestoneReviewService(ctx.ws, { codex: codex(scenario, join(tempDir(), "c.log")) }, { pollMs: 20 });
      const r = await ctx.milestoneReview.start("v1");
      const d = await ctx.milestoneReview.wait("v1", r.id);
      expect(d.run, scenario).toMatchObject({ status: "failed", failure, engine: "codex" });
      expect(d.run.error).toMatch(msg);
      expect(d.result).toBeUndefined();
    }
    const list = await ctx.milestoneReview.list("v1");
    expect(list.map((x) => (x.state === "ok" ? x.run.status : "broken"))).toEqual(["failed", "failed", "failed", "failed", "failed", "failed", "completed"]);
    expect((await ctx.milestoneReview.get("v1", ok.id)).result?.overall).toBe("目的の一部が果たせている");
    expect(dataDir).toBeTruthy();
  });

  it("取消は止めて cancelled にする。同じマイルストーンの実行中は始められず、別のマイルストーンは独立。もう一度実行できる", async () => {
    const { ctx } = await setup(codex("slow", join(tempDir(), "c.log")));
    const r = await ctx.milestoneReview.start("v1");
    await expect(ctx.milestoneReview.start("v1")).rejects.toMatchObject({ code: "running" });
    const v2 = await ctx.milestoneReview.start("v2");
    expect(v2.status).toBe("running");
    expect(ctx.milestoneReview.running()).toBe(2);
    await ctx.milestoneReview.cancel("v1", r.id, "human:test");
    expect((await ctx.milestoneReview.wait("v1", r.id)).run).toMatchObject({ status: "cancelled", cancelRequested: { by: "human:test" } });
    await ctx.milestoneReview.settle({ cancel: true });
    expect(ctx.milestoneReview.running()).toBe(0);
    ctx.milestoneReview = new MilestoneReviewService(ctx.ws, { codex: codex("ok", join(tempDir(), "c.log")) }, { pollMs: 20 });
    const again = await ctx.milestoneReview.start("v1");
    expect((await ctx.milestoneReview.wait("v1", again.id)).run.status).toBe("completed");
  });

  it("中断した後に届いた結果は取り込まない", async () => {
    const { ctx, dataDir } = await setup(codex("late", join(tempDir(), "c.log")));
    const r = await ctx.milestoneReview.start("v1");
    // 別の環境の人の明示中断と同じく、記録の上で先に終わりにする
    await ctx.ws.milestoneReviews.withLock("v1", () => ctx.ws.milestoneReviews.finish("v1", r.id, { status: "cancelled", abandoned: { at: new Date().toISOString() } }));
    const d = await ctx.milestoneReview.wait("v1", r.id);
    expect(d.run.status).toBe("cancelled");
    expect(d.result).toBeUndefined();
    expect(dataDir).toBeTruthy();
  });

  it("時間切れは timeout で失敗にする", async () => {
    const { ctx } = await setup(codex("slow", join(tempDir(), "c.log")), { timeoutMs: 200 });
    const r = await ctx.milestoneReview.start("v1");
    expect((await ctx.milestoneReview.wait("v1", r.id)).run).toMatchObject({ status: "failed", failure: "timeout" });
  });
});

describe("始める前の判定", () => {
  it("目的だけなら目的を比較単位にし、目的も予定機能も無ければ設定を案内して断る。要望 0 件も記録できる。入力の上限を超えたら断る", async () => {
    const calls: string[] = [];
    const { ctx, a } = await setup(fakeReviewer(okMessage, calls));
    const r = await ctx.milestoneReview.start("v2");
    const d = await ctx.milestoneReview.wait("v2", r.id);
    expect(d.result?.units.map((u) => u.unit)).toEqual(["purpose"]);
    expect(d.input?.warnings.map((w) => w.code)).toEqual(["no_requests", "quality_unset"]);
    await expect(ctx.milestoneReview.start("v3")).rejects.toThrow(/目的も予定機能もありません.*milestone purpose/);
    await expect(ctx.milestoneReview.start("nope")).rejects.toMatchObject({ code: "unknown_milestone" });
    await ctx.ws.requests.update(a, { body: "あ".repeat(REVIEW_INPUT_LIMIT + 1) }, {});
    await expect(ctx.milestoneReview.start("v1")).rejects.toMatchObject({ code: "too_large" });
    expect(calls).toHaveLength(1);
  });

  it("材料が変わったかは今の材料の hash と run の inputHash で分かる（過去の記録は変えない）", async () => {
    const { ctx, dataDir, a } = await setup(fakeReviewer(okMessage));
    const r = await ctx.milestoneReview.start("v1");
    const d = await ctx.milestoneReview.wait("v1", r.id);
    expect((await extractReviewInput(dataDir, "v1", ctx.ws.refs())).hash).toBe(d.run.inputHash);
    await ctx.ws.requests.update(a, { status: "done" }, {});
    expect((await extractReviewInput(dataDir, "v1", ctx.ws.refs())).hash).not.toBe(d.run.inputHash);
    expect((await ctx.milestoneReview.get("v1", r.id)).input?.requests[0].status).toBe("resolved");
  });
});

describe("所有者と回復", () => {
  const probe = (state: "dead" | "unknown" | "alive"): OwnerProbe => ({
    self: () => ({ instance: "me", pid: 1, start: "1" }),
    startOf: () => (state === "dead" ? null : state === "alive" ? "1" : undefined),
  });
  async function orphan(ctx: Awaited<ReturnType<typeof setup>>["ctx"], dataDir: string, owner: ReviewRun["owner"]) {
    const input = await extractReviewInput(dataDir, "v1");
    const run: ReviewRun = { id: newReviewRunId(), milestone: "v1", status: "running", engine: "codex", startedAt: new Date().toISOString(), owner, inputHash: input.hash, log: [] };
    await ctx.ws.milestoneReviews.create(input, run);
    return run;
  }

  it("死んだと確かめられた所有者の run だけ crashed にし、次の実行を始められる", async () => {
    const { ctx, dataDir } = await setup(fakeReviewer(okMessage), { probe: probe("dead") });
    const run = await orphan(ctx, dataDir, { instance: "me", pid: 99999, start: "5" });
    const next = await ctx.milestoneReview.start("v1");
    expect((await ctx.milestoneReview.get("v1", run.id)).run).toMatchObject({ status: "failed", failure: "crashed" });
    expect((await ctx.milestoneReview.wait("v1", next.id)).run.status).toBe("completed");
  });

  it("所有者が分からない run は自動で終わりにせず、人の明示中断（acknowledgeStopped）で終わりにできる。動いている所有者なら断る", async () => {
    const { ctx, dataDir } = await setup(fakeReviewer(okMessage), { probe: probe("unknown") });
    const run = await orphan(ctx, dataDir, { instance: "other", pid: 5 });
    await expect(ctx.milestoneReview.start("v1")).rejects.toThrow(/--acknowledge-stopped/);
    expect((await ctx.milestoneReview.get("v1", run.id)).owner).toMatchObject({ state: "unknown" });
    // 取消は要求として残るだけ（所有者が見つけて止める）
    expect((await ctx.milestoneReview.cancel("v1", run.id, "human:a")).requested).toBe(true);
    expect((await ctx.milestoneReview.get("v1", run.id)).run).toMatchObject({ status: "running", cancelRequested: { by: "human:a" } });
    const fin = await ctx.milestoneReview.cancel("v1", run.id, "human:a", { acknowledgeStopped: true });
    expect(fin.run).toMatchObject({ status: "cancelled", abandoned: { by: "human:a" } });
    expect(fin.run.error).toContain("止めたとは限りません");

    const alive = new MilestoneReviewService(ctx.ws, {}, { probe: probe("alive") });
    const run2 = await orphan(ctx, dataDir, { instance: "me", pid: 1, start: "1" });
    await expect(alive.cancel("v1", run2.id, "human:a", { acknowledgeStopped: true })).rejects.toMatchObject({ code: "owner_alive" });
  });

  it("別のプロセス（別のサービス）からの取消の要求を、実行しているほうが見つけて止める", async () => {
    const { ctx } = await setup(codex("slow", join(tempDir(), "c.log")));
    const r = await ctx.milestoneReview.start("v1");
    const other = new MilestoneReviewService(ctx.ws, {}, { probe: probe("alive") });
    expect((await other.cancel("v1", r.id, "human:b")).requested).toBe(true);
    expect((await ctx.milestoneReview.wait("v1", r.id)).run.status).toBe("cancelled");
  });
});

describe("API と CLI", () => {
  it("API で開始・一覧・取得・取消・材料のプレビュー。別のプロジェクトの同じ ID は分かれる", async () => {
    const one = await setup(fakeReviewer(okMessage));
    const two = await setup(fakeReviewer(okMessage));
    const call = async (ctx: typeof one.ctx, method: string, path: string, body?: unknown) => {
      const res = await apiRoutes(ctx).request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const pv = await call(one.ctx, "GET", "/milestones/v1/review-preview");
    expect(pv.body).toMatchObject({ units: [{ id: "G1" }, { id: "G2" }], requests: 2 });
    expect((await call(one.ctx, "GET", "/milestones/v3/review-preview")).body.units).toEqual([]);
    const started = await call(one.ctx, "POST", "/milestones/v1/reviews", {});
    expect(started.status).toBe(202);
    await one.ctx.milestoneReview.wait("v1", started.body.id);
    expect((await call(one.ctx, "GET", "/milestones/v1/reviews")).body.items).toHaveLength(1);
    expect((await call(two.ctx, "GET", "/milestones/v1/reviews")).body.items).toHaveLength(0);
    const got = await call(one.ctx, "GET", `/milestones/v1/reviews/${started.body.id}`);
    expect(got.body.result.units).toHaveLength(2);
    expect((await call(one.ctx, "POST", `/milestones/v1/reviews/${started.body.id}/cancel`, {})).status).toBe(409);
    expect((await call(one.ctx, "POST", "/milestones/v3/reviews", {})).body.code).toBe("no_goals");
    expect((await call(one.ctx, "GET", "/milestones/v1/reviews/MR-20260101-000000-abcd")).status).toBe(404);
    expect((await call(one.ctx, "GET", "/milestones/v1/reviews/MR-1")).status).toBe(400);
  });

  let CONFIG_HOME = "";
  beforeEach(() => {
    CONFIG_HOME = tempDir("p3-config-");
  });
  const p3Async = (cwd: string, args: string[]) =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
      const c = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...base, XDG_CONFIG_HOME: CONFIG_HOME } });
      let err = "";
      c.stderr.on("data", (d: Buffer) => (err += d.toString()));
      c.on("close", (code) => resolve({ code, err }));
    });
  const p3 = (cwd: string, args: string[]) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...base, XDG_CONFIG_HOME: CONFIG_HOME } });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };

  it("CLI: review（完了待ち）・reviews・review-show・review-cancel と終了コード", async () => {
    const root = tempDir("p3-review-");
    gitInit(root);
    writeFileSync(join(root, "README.md"), "# app\n");
    expect(p3(root, ["init", "--yes", "--dir", ".p3", "--repo-name", "app"]).code).toBe(0);
    p3(root, ["milestone", "add", "v1"]);
    const empty = p3(root, ["milestone", "review", "v1", "--engine", "mock"]);
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("目的も予定機能もありません");
    p3(root, ["milestone", "goal", "add", "v1", "在庫の一覧"]);
    const r = p3(root, ["milestone", "review", "v1", "--engine", "mock", "--json"]);
    expect(r.code, r.err).toBe(0);
    const rec = r.json();
    expect(rec.run.status).toBe("completed");
    expect(rec.result.units[0]).toMatchObject({ unit: "G1", verdict: "insufficient" });
    const text = p3(root, ["milestone", "review-show", "v1", rec.run.id]).out;
    expect(text).toContain("判断材料不足");
    expect(text).toContain("参照先 app:");
    expect(text).toContain("参照先のリポジトリのコード");
    expect(p3(root, ["milestone", "reviews", "v1", "--json"]).json()).toHaveLength(1);
    expect(p3(root, ["milestone", "reviews", "v1"]).out).toContain(rec.run.id);
    expect(p3(root, ["milestone", "review-show", "v1", "MR-20260101-000000-abcd"]).code).toBe(2);
    expect(p3(root, ["milestone", "review-cancel", "v1", rec.run.id]).code).toBe(3);
    // 履歴のあるマイルストーンは消せない
    expect(p3(root, ["milestone", "rm", "v1"]).err).toContain("レビューの履歴");
    // 別プロセスの同時の開始は1つだけ通り、もう一方は実行中として終了コード 3
    const both = await Promise.all([0, 1].map(() => p3Async(root, ["milestone", "review", "v1", "--engine", "mock"])));
    expect(both.map((r) => r.code).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 3]);
    expect(both.find((r) => r.code === 3)?.err).toContain("実行中");
  });
});

