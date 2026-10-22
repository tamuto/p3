import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { PreflightEngine, PreflightJob } from "../src/core/preflight/engine.ts";
import { compareInput, normalizeInput, StaleInputError } from "../src/core/preflight/input.ts";
import { MockEngine } from "../src/core/preflight/mockEngine.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/core/store/frontmatter.ts";
import { makeRepo, newRequest, newTask, openTestProject } from "./helpers.ts";

/** 始めたら release() まで待つ mock（評価中の編集を作る）。渡された要望を残す */
class GatedEngine implements PreflightEngine {
  readonly name = "mock" as const;
  jobs: PreflightJob["request"][] = [];
  private inner = new MockEngine({ delay: 0 });
  private gate?: Promise<void>;
  release = () => {};
  hold() {
    this.gate = new Promise((r) => (this.release = r));
  }
  status = () => this.inner.status();
  async run(job: PreflightJob, log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal) {
    this.jobs.push(structuredClone(job.request));
    await this.gate;
    return this.inner.run(job, log, signal);
  }
}

async function setup(body = "- 送信基盤\n- 設定画面") {
  const repo = await makeRepo();
  const engine = new GatedEngine();
  const ctx = await openTestProject(repo.dataDir, { mock: engine });
  const req = await newRequest(ctx, { title: "通知", status: "draft", body });
  const preflight = async () => {
    const { id } = await ctx.preflight.start(req.id, { engine: "mock", actor: "human:a" });
    return (await ctx.preflight.wait(req.id, id))!;
  };
  const runDir = (runId: string) => ctx.ws.preflight.runDir(req.id, runId);
  const match = async (runId: string) => ctx.preflight.inputMatch(req.id, (await ctx.preflight.get(req.id, runId))!, { fresh: true });
  /** 監視していない外部の編集（ファイルを直接書き換える） */
  const editFile = (patch: { title?: string; body?: string }) => {
    const file = ctx.ws.requests.path(req.id);
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    writeFileSync(file, stringifyFrontmatter({ ...data, ...(patch.title ? { title: patch.title } : {}) }, patch.body ?? body));
  };
  return { ...repo, ctx, engine, req, preflight, runDir, match, editFile };
}

describe("評価対象の正規化と比較", () => {
  const same = (a: { title: string; body: string }, b: { title: string; body: string }) => compareInput(normalizeInput(a), b).status;

  it("改行の形・前後の空白だけの違いは同じ。行末の空白（Markdown の改行）や途中の空行は違いとして扱う", () => {
    expect(same({ title: "A", body: "x\ny\n" }, { title: " A ", body: "x\r\ny" })).toBe("same");
    expect(same({ title: "A", body: "\n\nx\n\n" }, { title: "A", body: "x" })).toBe("same");
    expect(same({ title: "A", body: "x  \ny" }, { title: "A", body: "x\ny" })).toBe("changed");
    expect(same({ title: "A", body: "x\n\ny" }, { title: "A", body: "x\ny" })).toBe("changed");
    expect(same({ title: "A", body: "" }, { title: "A", body: "  \n" })).toBe("same");
  });

  it("変わった項目を返し、読めない評価対象は unknown（一致とみなさない）", () => {
    expect(compareInput({ title: "A", body: "x" }, { title: "B", body: "y" })).toEqual({ status: "changed", changed: ["title", "body"] });
    expect(compareInput({ error: "ない" }, { title: "A", body: "x" })).toEqual({ status: "unknown", reason: "ない" });
  });
});

describe("Preflight の評価対象の固定", () => {
  it("始めたときのタイトル・本文を run.input と request.md に固定し、エンジンにも同じものを渡す", async () => {
    const { ctx, engine, req, preflight, runDir } = await setup("- 送信基盤  \n- 設定画面\n\n");
    const run = await preflight();
    // 子の要望の集合も固定する（子が無ければ空。親は子の要望のときだけ）
    expect(run.input).toEqual({ title: "通知", body: "- 送信基盤  \n- 設定画面", children: [] });
    expect(readFileSync(join(runDir(run.id), "request.md"), "utf8")).toBe(`# ${req.id} 通知\n\n- 送信基盤  \n- 設定画面`);
    expect(engine.jobs[0]).toMatchObject({ title: run.input!.title, body: run.input!.body });
    expect(ctx.ws.requests.require(req.id).status).toBe("reviewed");
  });

  it("評価中に本文を変えても、エンジンには開始時の本文を渡し、終わっても新しい本文を戻さない", async () => {
    const { ctx, engine, req, runDir, match } = await setup();
    engine.hold();
    const { id } = await ctx.preflight.start(req.id, { engine: "mock" });
    await ctx.ws.requests.update(req.id, { body: "- 全部やり直す" });
    engine.release();
    const run = (await ctx.preflight.wait(req.id, id))!;
    expect(run.status).toBe("completed");
    expect(engine.jobs[0].body).toBe("- 送信基盤\n- 設定画面");
    expect(run.input?.body).toBe("- 送信基盤\n- 設定画面");
    expect(readFileSync(join(runDir(id), "request.md"), "utf8")).toContain("- 送信基盤");
    expect(ctx.ws.requests.require(req.id).body.trim()).toBe("- 全部やり直す");
    expect(await match(id)).toEqual({ status: "changed", changed: ["body"] });
  });

  it("始めるときに監視していない外部の編集を読み直す", async () => {
    const { req, preflight, editFile, engine } = await setup();
    editFile({ body: "- 外で書いた" });
    const run = await preflight();
    expect(run.input?.body).toBe("- 外で書いた");
    expect(engine.jobs[0].body).toBe("- 外で書いた");
    expect(req.body).not.toBe("- 外で書いた");
  });
});

describe("評価対象と今の要望の比較", () => {
  it("タイトル・本文の変更で changed、同じ値の保存・元に戻すと same。タグ・期限・ステータスだけの変更は比べない", async () => {
    const { ctx, req, preflight, match } = await setup();
    const run = await preflight();
    expect(await match(run.id)).toEqual({ status: "same" });

    await ctx.ws.requests.update(req.id, { body: "- 送信基盤\n- 設定画面\n" }); // 同じ値（末尾の改行だけ）
    await ctx.ws.requests.update(req.id, { tags: ["jira:X-1"], due: "2026-12-01", status: "active" });
    expect(await match(run.id)).toEqual({ status: "same" });

    await ctx.ws.requests.update(req.id, { title: "通知（改）" });
    expect(await match(run.id)).toEqual({ status: "changed", changed: ["title"] });
    await ctx.ws.requests.update(req.id, { title: "通知", body: "" }); // 空の本文
    expect(await match(run.id)).toEqual({ status: "changed", changed: ["body"] });
    await ctx.ws.requests.update(req.id, { body: "- 送信基盤\n- 設定画面" });
    expect(await match(run.id)).toEqual({ status: "same" });
  });

  it("以前の run（input なし）は request.md で比べ、それも無ければ unknown", async () => {
    const { ctx, req, preflight, runDir, match } = await setup();
    const run = await preflight();
    const { input, ...old } = (await ctx.preflight.get(req.id, run.id))!;
    await ctx.ws.preflight.save(old);
    expect(await match(run.id)).toEqual({ status: "same" });
    await ctx.ws.requests.update(req.id, { body: "- 変えた" });
    expect(await match(run.id)).toEqual({ status: "changed", changed: ["body"] });
    rmSync(join(runDir(run.id), "request.md"));
    expect(await match(run.id)).toMatchObject({ status: "unknown", reason: expect.stringContaining("request.md") });
    writeFileSync(join(runDir(run.id), "request.md"), "壊れた形");
    expect(await match(run.id)).toMatchObject({ status: "unknown" });
  });

  it("古い rev での保存は競合になり、本文は変わらない", async () => {
    const { ctx, req } = await setup();
    const rev = ctx.ws.requests.require(req.id).rev;
    await ctx.ws.requests.update(req.id, { body: "- 先に保存" }, { expectedRev: rev });
    await expect(ctx.ws.requests.update(req.id, { body: "- 後から" }, { expectedRev: rev })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.requests.require(req.id).body.trim()).toBe("- 先に保存");
  });
});

describe("古い評価からのタスク化", () => {
  it("本文が変わった run からはタスク化せず、何も書かない。再評価した run からはタスク化できる", async () => {
    const { ctx, req, preflight } = await setup();
    const first = await preflight();
    await ctx.ws.requests.update(req.id, { body: "- 送信基盤\n- 再送" });
    const before = ctx.ws.requests.require(req.id);

    const err = await ctx.preflight.materialize(req.id, first.id).catch((e) => e);
    expect(err).toBeInstanceOf(StaleInputError);
    expect(err).toMatchObject({ code: "stale_input", match: { status: "changed", changed: ["body"] } });
    expect(err.message).toContain(`p3 preflight ${req.id}`);
    expect(ctx.ws.tasksOf(req.id).list()).toEqual([]);
    expect(ctx.ws.requests.require(req.id)).toMatchObject({ rev: before.rev, status: before.status });
    expect(ctx.ws.requests.require(req.id).workstreams).toEqual(before.workstreams);
    const after = (await ctx.preflight.get(req.id, first.id))!;
    expect(after.materialization).toBeUndefined();
    expect(after.materialized).toBeUndefined();
    expect((await ctx.preflight.previewMaterialize(req.id, first.id)).inputMatch.status).toBe("changed");

    // 過去の run（評価・案）は読める
    expect(after.drafts.length).toBeGreaterThan(0);
    const second = await preflight();
    expect(second.input?.body).toBe("- 送信基盤\n- 再送");
    const r = await ctx.preflight.materialize(req.id, second.id);
    expect(r.tasks.map((t) => t.title)).toEqual(["送信基盤", "再送"]);
    // 新しい run の後も、古い run は古いまま
    await expect(ctx.preflight.materialize(req.id, first.id)).rejects.toBeInstanceOf(StaleInputError);
  });

  it("監視していない外部の編集も、タスク化の直前に読み直して断る。元に戻せばタスク化できる", async () => {
    const { ctx, req, preflight, editFile } = await setup();
    const run = await preflight();
    editFile({ title: "外で変えたタイトル" });
    expect(ctx.ws.requests.require(req.id).title).toBe("通知"); // メモリ上はまだ古い
    await expect(ctx.preflight.materialize(req.id, run.id)).rejects.toMatchObject({ match: { status: "changed", changed: ["title"] } });
    editFile({ title: "通知" });
    await expect(ctx.preflight.materialize(req.id, run.id)).resolves.toMatchObject({ tasks: expect.any(Array) });
  });

  it("評価対象を確かめられない run からはタスク化しない", async () => {
    const { ctx, req, preflight, runDir } = await setup();
    const run = await preflight();
    const { input, ...old } = (await ctx.preflight.get(req.id, run.id))!;
    await ctx.ws.preflight.save(old);
    rmSync(join(runDir(run.id), "request.md"));
    await expect(ctx.preflight.materialize(req.id, run.id)).rejects.toMatchObject({ code: "stale_input", match: { status: "unknown" } });
    expect(ctx.ws.tasksOf(req.id).list()).toEqual([]);
  });

  it("途中で失敗したタスク化のやり直しも、本文が変わっていれば断り、戻せば作ったタスクを作り直さずに続ける", async () => {
    const { ctx, req, preflight } = await setup();
    const old = await newTask(ctx, req.id, { title: "古いタスク" });
    const run = await preflight();
    // D1 だけ作ったところで止まった状態
    const made = await newTask(ctx, req.id, { title: "送信基盤", body: `x\n\n> preflight: ${run.id} / D1` });
    const saved = (await ctx.preflight.get(req.id, run.id))!;
    saved.materialization = { created: { D1: made.id }, archive: [old.id], archived: [], done: false };
    await ctx.ws.preflight.save(saved);

    await ctx.ws.requests.update(req.id, { body: "- 別の話" });
    await expect(ctx.preflight.materialize(req.id, run.id)).rejects.toBeInstanceOf(StaleInputError);
    expect(ctx.ws.tasksOf(req.id).list().map((t) => t.id)).toEqual([old.id, made.id]);

    await ctx.ws.requests.update(req.id, { body: "- 送信基盤\n- 設定画面" });
    const r = await ctx.preflight.materialize(req.id, run.id);
    expect(r.tasks.map((t) => t.id)).toEqual([made.id, "T003"]);
    expect(r.archived).toEqual([old.id]);
  });
});

describe("再評価への引き継ぎ", () => {
  it("前回の評価のあとで変わった要望を、前回の時点の内容つきで渡す（変わっていなければ書かない）", async () => {
    const { ctx, req, preflight, runDir } = await setup();
    const first = await preflight();
    await ctx.ws.notes.add(req.id, "メモ");
    const second = await preflight();
    expect(readFileSync(join(runDir(second.id), "carryover.md"), "utf8")).not.toContain("変わった要望");

    await ctx.ws.requests.update(req.id, { body: "- まったく別の方針" });
    const third = await preflight();
    const text = readFileSync(join(runDir(third.id), "carryover.md"), "utf8");
    expect(text).toContain(`前回 ${second.id} の後で、要望の本文が書き換えられました`);
    expect(text).toContain("> - 送信基盤\n> - 設定画面");
    expect(text).not.toContain("前回の時点のタイトル");
    expect(third.log.some((l) => l.text.includes("要望の本文が変わりました"))).toBe(true);
    // 過去の run の記録は変わらない
    expect(readFileSync(join(runDir(first.id), "request.md"), "utf8")).toContain("- 送信基盤");
    expect(existsSync(join(runDir(first.id), "carryover.md"))).toBe(false);
  });
});

describe("API", () => {
  it("run に inputMatch を添え、古い評価からのタスク化は stale_input の 409（rev の競合は rev_conflict）", async () => {
    const { ctx, req, preflight } = await setup();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const run = await preflight();
    expect((await call("GET", `/requests/${req.id}/preflight/${run.id}`)).body.inputMatch).toEqual({ status: "same" });

    const rev = ctx.ws.requests.require(req.id).rev;
    expect((await call("PATCH", `/requests/${req.id}`, { body: "- 変えた", rev })).status).toBe(200);
    const stale = await call("POST", `/requests/${req.id}/preflight/${run.id}/materialize`, {});
    expect(stale).toMatchObject({ status: 409, body: { code: "stale_input", inputMatch: { status: "changed", changed: ["body"] } } });
    expect((await call("GET", `/requests/${req.id}/preflight`)).body[0].inputMatch.status).toBe("changed");
    expect((await call("GET", `/requests/${req.id}`)).body.runs[0].inputMatch.status).toBe("changed");
    expect((await call("GET", `/requests/${req.id}/preflight/${run.id}/materialize`)).body.inputMatch.status).toBe("changed");

    const conflict = await call("PATCH", `/requests/${req.id}`, { body: "- 古い rev", rev });
    expect(conflict).toMatchObject({ status: 409, body: { code: "rev_conflict" } });

    await call("PATCH", `/requests/${req.id}`, { body: "- 送信基盤\n- 設定画面" });
    expect((await call("POST", `/requests/${req.id}/preflight/${run.id}/materialize`, {})).status).toBe(201);
  });
});
