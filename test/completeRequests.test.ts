import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { completeMilestoneRequests, completionPlan, CompletionRejected } from "../src/core/releaseNotes/completeRequests.ts";
import { releaseNoteDetail, saveReleaseNote } from "../src/core/releaseNotes/service.ts";
import { archiveRequest } from "../src/core/requestOps.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

const MS = [
  { id: "v1", title: "最初のリリース" },
  { id: "v2", title: "次" },
];

async function setup() {
  const p = await makeProject({ milestones: MS });
  const add = async (title: string, status: string, tasks: { status: string; record?: string; checked?: boolean }[], milestone = "v1") => {
    await new Promise((r) => setTimeout(r, 3));
    const r = await newRequest(p.ctx, { title, status: status as never, milestone });
    for (const [i, t] of tasks.entries()) {
      await newTask(p.ctx, r.id, { title: `${title}-${i + 1}`, status: t.status as never, record: t.record, checkedAt: t.checked ? "2026-10-01T00:00:00.000Z" : undefined });
    }
    return r.id;
  };
  const events: ServerEvent[] = [];
  p.ctx.ws.on((e) => events.push(e));
  /** 要望の状態（ディスクから読み直す） */
  const status = async (id: string) => {
    await p.ctx.ws.requests.reload(id);
    return p.ctx.ws.requests.require(id).status;
  };
  /** タスクのファイル全部の中身（バイト単位で比べる） */
  const taskFiles = async () => {
    const out: Record<string, string> = {};
    for (const rid of await readdir(join(p.dataDir, "requests"))) {
      const dir = join(p.dataDir, "requests", rid, "tasks");
      for (const f of await readdir(dir).catch(() => [])) out[`${rid}/${f}`] = await readFile(join(dir, f), "utf8");
    }
    return out;
  };
  return { ...p, add, events, status, taskFiles };
}

const plan = async (ctx: Awaited<ReturnType<typeof setup>>["ctx"], mid = "v1") => completionPlan(ctx, mid);

describe("マイルストーンの要望を一括で完了済にする", () => {
  it("対応済だけを完了済にし、完了済・見送り・アーカイブ・ほかのマイルストーン・タスク・ノート・マイルストーンは変えない", async () => {
    const { ctx, add, status, taskFiles, events, dataDir } = await setup();
    const a = await add("検索", "resolved", [{ status: "done", record: "索引" }, { status: "done" }]); // 記録の欠けは条件にしない
    const b = await add("通知", "resolved", [{ status: "done", record: "送る", checked: true }]);
    const c = await add("一覧", "done", [{ status: "done", record: "並び" }]);
    const d = await add("取りやめ", "rejected", [{ status: "todo" }]);
    const other = await add("別", "resolved", [{ status: "done", record: "x" }], "v2");
    const gone = await add("古い", "active", [{ status: "todo" }]);
    await archiveRequest(ctx, gone);
    await saveReleaseNote(ctx, "v1", { body: "本文" });
    const note = await readFile(join(dataDir, "release-notes", "v1.md"), "utf8");
    const yaml = await readFile(join(dataDir, "project.yaml"), "utf8");
    const tasksBefore = await taskFiles();
    const revC = ctx.ws.requests.require(c).rev;

    const p = await plan(ctx);
    expect(p).toMatchObject({ ready: true, targets: [{ id: a }, { id: b }], alreadyDone: [c], skipped: [d], blockers: [] });
    // 詳細にも同じ判定が付く
    expect((await releaseNoteDetail(ctx, "v1")).completion).toEqual(p);

    events.length = 0;
    const r = await completeMilestoneRequests(ctx, "v1", p.basedOn, "human:test");
    expect(r).toEqual({ milestone: "v1", completed: [{ id: a, title: "検索" }, { id: b, title: "通知" }], notRun: [], alreadyDone: [c] });
    expect([await status(a), await status(b), await status(c), await status(d), await status(other)]).toEqual(["done", "done", "done", "rejected", "resolved"]);
    expect(ctx.ws.requests.require(a).updatedBy).toBe("human:test");
    // 完了済だったものは書き直さない
    expect(ctx.ws.requests.require(c).rev).toBe(revC);
    // タスク（状態・済み）・ノート・マイルストーンはバイト単位で同じ
    expect(await taskFiles()).toEqual(tasksBefore);
    expect(await readFile(join(dataDir, "release-notes", "v1.md"), "utf8")).toBe(note);
    expect(await readFile(join(dataDir, "project.yaml"), "utf8")).toBe(yaml);
    // 変更の通知（要望ごと）と、ノートの保存のあとで材料が変わったこと
    expect(events.filter((e) => e.type === "changed" && e.kind === "request").map((e) => (e as { request: string }).request)).toEqual([a, b]);
    expect((await releaseNoteDetail(ctx, "v1")).materialChanged).toBe(true);

    // もう一度判定すると対象は0件（実行しても何も変えない）
    const again = await plan(ctx);
    expect(again).toMatchObject({ ready: true, targets: [], alreadyDone: expect.arrayContaining([a, b, c]) });
    const revA = ctx.ws.requests.require(a).rev;
    expect(await completeMilestoneRequests(ctx, "v1", again.basedOn)).toMatchObject({ completed: [], notRun: [] });
    expect(ctx.ws.requests.require(a).rev).toBe(revA);
  });

  it("見送り以外に収録できない要望があればできず、何も書かない", async () => {
    const cases: [string, (s: Awaited<ReturnType<typeof setup>>) => Promise<string | void>, RegExp][] = [
      ["進行中（タスクは全部完了）", (s) => s.add("進行中", "active", [{ status: "done", record: "x" }]), /進行中（.*）: 未完了（active）/],
      ["対応済だが未完了のタスク", (s) => s.add("食い違い", "resolved", [{ status: "done", record: "x" }, { status: "doing" }]), /完了していないタスクがある: T002\(doing\)/],
      ["タスクが無い", (s) => s.add("空", "resolved", []), /タスクが無い/],
      [
        "読めないタスク",
        async (s) => {
          const id = await s.add("壊れ", "resolved", [{ status: "done", record: "x" }]);
          await writeFile(join(s.dataDir, "requests", id, "tasks", "T001.md"), "---\nid: [壊れ\n---\n");
          await s.ctx.ws.reloadAll();
        },
        /読めないタスクがある/,
      ],
      [
        "読めない要望（所属が分からない）",
        async (s) => {
          const id = await s.add("壊れた要望", "resolved", [{ status: "done", record: "x" }], "v2");
          await writeFile(join(s.dataDir, "requests", id, "request.md"), "---\nid: [壊れ\n---\n");
          await s.ctx.ws.reloadAll();
        },
        /読めない/,
      ],
    ];
    for (const [name, make, reason] of cases) {
      const s = await setup();
      const ok = await s.add("終わった", "resolved", [{ status: "done", record: "x" }]);
      await make(s);
      const p = await plan(s.ctx);
      expect(p.ready, name).toBe(false);
      expect(p.blockers.map((b) => b.reason).join("\n"), name).toMatch(reason);
      const err = await completeMilestoneRequests(s.ctx, "v1", p.basedOn).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(CompletionRejected);
      expect((err as CompletionRejected).code, name).toBe("blocked");
      expect(await s.status(ok), name).toBe("resolved");
    }
  });

  it("マイルストーンが project.yaml に無ければできない（ノートも無ければ見つからない）。要望が無ければ対象0件でできる", async () => {
    const { ctx, add } = await setup();
    expect(await plan(ctx, "v2")).toMatchObject({ ready: true, targets: [], alreadyDone: [], skipped: [], blockers: [] });
    await expect(completionPlan(ctx, "nope")).rejects.toThrow("マイルストーンがありません");
    // ノートだけが残ったマイルストーン
    await add("検索", "resolved", [{ status: "done", record: "x" }]);
    await saveReleaseNote(ctx, "v1", { body: "本文" });
    await ctx.ws.saveProject({ milestones: [{ id: "v2", title: "次" }] });
    const p = await plan(ctx, "v1");
    expect(p.ready).toBe(false);
    expect(p.blockers[0].reason).toContain("project.yaml にありません");
  });

  it("表示したあとで材料が変わったら何も書かない。所属を変えた・rev が違う・タスクが戻ったら、その要望で止めて結果を返し、やり直せる", async () => {
    const { ctx, add, status } = await setup();
    const a = await add("一", "resolved", [{ status: "done", record: "x" }]);
    const b = await add("二", "resolved", [{ status: "done", record: "x" }]);
    const c = await add("三", "resolved", [{ status: "done", record: "x" }]);

    // 古い hash: 何も書かない
    const old = await plan(ctx);
    await ctx.ws.requests.update(c, { title: "三（変えた）" });
    const stale = await completeMilestoneRequests(ctx, "v1", old.basedOn).catch((e: unknown) => e);
    expect((stale as CompletionRejected).code).toBe("material_changed");
    expect((stale as CompletionRejected).plan.basedOn).not.toBe(old.basedOn);
    expect([await status(a), await status(b), await status(c)]).toEqual(["resolved", "resolved", "resolved"]);

    // 判定のあと、書き始めてから2件目の rev が変わった（外の変更）: 1件目だけ完了済にして止まる。戻さない
    const p = await plan(ctx);
    const update = ctx.ws.requests.update.bind(ctx.ws.requests);
    const spy = vi.spyOn(ctx.ws.requests, "update").mockImplementation(async (id, patch, opts) => {
      if (id === b && opts?.expectedRev !== undefined) await update(b, { body: "外で直した" }); // 直前に外で書かれた
      return update(id, patch, opts);
    });
    const r = await completeMilestoneRequests(ctx, "v1", p.basedOn);
    spy.mockRestore();
    expect(r.completed.map((x) => x.id)).toEqual([a]);
    expect(r.failed).toMatchObject({ id: b, code: "conflict" });
    expect(r.notRun).toEqual([c]);
    expect([await status(a), await status(b), await status(c)]).toEqual(["done", "resolved", "resolved"]);
    expect(ctx.ws.requests.require(b).body.trim()).toBe("外で直した");

    // 途中の書き込みの失敗: その要望で止め、残りは書かない
    const p2 = await plan(ctx);
    const spy2 = vi.spyOn(ctx.ws.requests, "update").mockRejectedValueOnce(new Error("ディスクがいっぱい"));
    const r2 = await completeMilestoneRequests(ctx, "v1", p2.basedOn);
    spy2.mockRestore();
    expect(r2).toMatchObject({ completed: [], failed: { id: b, code: "error", reason: "ディスクがいっぱい" }, notRun: [c] });

    // 判定のあとにタスクを戻した（要望の rev は変わらない）: 書く直前に確かめて止める
    // （判定の hash を確かめた後、書く直前にタスクを読み直すところで外から戻される）
    const p3 = await plan(ctx);
    const col = ctx.ws.tasksOf(b);
    const load = col.load.bind(col);
    const spy3 = vi.spyOn(col, "load").mockImplementationOnce(async () => {
      await col.update("T001", { status: "doing" });
      return load();
    });
    const r3 = await completeMilestoneRequests(ctx, "v1", p3.basedOn);
    spy3.mockRestore();
    expect(r3).toMatchObject({ completed: [], failed: { id: b, code: "changed" }, notRun: [c] });
    expect(await status(b)).toBe("resolved");
    await ctx.ws.tasksOf(b).update("T001", { status: "done" });

    // 取り直してやり直すと残りを完了済にする（完了済にしたものは対象から外れ、書き直さない）
    const revA = ctx.ws.requests.require(a).rev;
    const p4 = await plan(ctx);
    expect(p4.targets.map((t) => t.id)).toEqual([b, c]);
    expect((await completeMilestoneRequests(ctx, "v1", p4.basedOn)).completed.map((x) => x.id)).toEqual([b, c]);
    expect([await status(a), await status(b), await status(c)]).toEqual(["done", "done", "done"]);
    expect(ctx.ws.requests.require(a).rev).toBe(revA);
  });
});

describe("API: POST /release-notes/:mid/complete-requests", () => {
  it("詳細の判定と同じ。できれば完了済にし、材料の変化・できないときは 409 で何も書かず、途中で止まれば 409 partial", async () => {
    const { ctx, add, status } = await setup();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-p3-actor": "human:web" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const a = await add("一", "resolved", [{ status: "done", record: "x" }]);
    const b = await add("二", "active", [{ status: "todo" }]);

    const d1 = (await call("GET", "/release-notes/v1")).body;
    expect(d1.completion).toMatchObject({ ready: false, targets: [{ id: a }] });
    expect(d1.completion.blockers.map((x: any) => x.target)).toEqual([b]);
    expect((await call("POST", "/release-notes/v1/complete-requests", {})).status).toBe(400);
    const blocked = await call("POST", "/release-notes/v1/complete-requests", { basedOn: d1.completion.basedOn });
    expect(blocked).toMatchObject({ status: 409, body: { code: "blocked", plan: { ready: false } } });
    expect(await status(a)).toBe("resolved");

    await ctx.ws.requests.update(b, { status: "rejected" });
    const stale = await call("POST", "/release-notes/v1/complete-requests", { basedOn: d1.completion.basedOn });
    expect(stale).toMatchObject({ status: 409, body: { code: "material_changed", plan: { ready: true } } });

    const d2 = (await call("GET", "/release-notes/v1")).body;
    const ok = await call("POST", "/release-notes/v1/complete-requests", { basedOn: d2.completion.basedOn });
    expect(ok).toMatchObject({ status: 200, body: { completed: [{ id: a }], notRun: [] } });
    expect(ctx.ws.requests.require(a).updatedBy).toBe("human:web");

    const c = await add("三", "resolved", [{ status: "done", record: "x" }]);
    const d3 = (await call("GET", "/release-notes/v1")).body;
    const spy = vi.spyOn(ctx.ws.requests, "update").mockRejectedValueOnce(new Error("書けません"));
    const partial = await call("POST", "/release-notes/v1/complete-requests", { basedOn: d3.completion.basedOn });
    spy.mockRestore();
    expect(partial).toMatchObject({ status: 409, body: { code: "partial", result: { completed: [], failed: { id: c, code: "error" }, notRun: [] } } });
    expect((await call("POST", "/release-notes/nope/complete-requests", { basedOn: "x" })).status).toBe(404);
  });
});
