import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

/**
 * 画面の「再読み込み」（POST /api/reload）。serve の監視（watch）は起動しない。
 * 外での変更は CLI と同じく、別の Workspace からファイルに直接書く（置き換えて保存する）。
 */
async function setup() {
  const p = await makeProject();
  const app = apiRoutes(p.ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const events: ServerEvent[] = [];
  p.ctx.ws.on((e) => events.push(e));
  const req = await newRequest(p.ctx, { title: "検索の改善", body: "本文" });
  await newTask(p.ctx, req.id, { title: "索引を作る" });
  /** 外（CLI）から書く */
  const cli = async () => {
    const ws = new Workspace(p.dataDir);
    await ws.load();
    return ws;
  };
  return { ...p, call, events, rid: req.id, cli };
}

/** 画面が見るもの（設定・一覧・詳細・タスク一覧・関係・類似検索）をまとめて取る */
async function snapshot(call: Awaited<ReturnType<typeof setup>>["call"], rid: string) {
  return {
    project: (await call("GET", "/project")).body,
    list: (await call("GET", "/requests")).body,
    detail: (await call("GET", `/requests/${rid}`)).body,
    tasks: (await call("GET", "/tasks")).body,
  };
}

describe("全件の読み直し（POST /api/reload）", () => {
  it("監視なしで、同じファイルを2回以上置き換えて保存しても、読み直すと設定・一覧・詳細・進捗・関係・類似検索が最新になる", async () => {
    const { call, rid, cli } = await setup();
    await snapshot(call, rid); // 索引を一度作っておく（古い索引が残らないことを見る）
    const ext = await cli();
    await ext.requests.update(rid, { title: "検索の改善 2" });
    await ext.requests.update(rid, { title: "検索の改善 3", status: "active" });
    await ext.tasksOf(rid).update("T001", { status: "doing" });
    await ext.tasksOf(rid).update("T001", { status: "done" });
    const t2 = await ext.tasksOf(rid).create({ title: "ベクトル埋め込みで再ランク", status: "todo" });
    await ext.tasksOf(rid).update(t2.id, { relations: [{ type: "depends_on", target: "T001" }] });
    await ext.saveProject({ description: "外で変えた説明" });
    await ext.saveProject({ description: "外で2回目に変えた説明" });

    // まだ読み直していない: 古いまま
    expect((await call("GET", `/requests/${rid}`)).body.request.title).toBe("検索の改善");

    const res = await call("POST", "/reload");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requests: 1, tasks: 2, errors: 0, loadedAt: expect.any(String) });

    const s = await snapshot(call, rid);
    expect(s.project.project.description).toBe("外で2回目に変えた説明");
    expect(s.list[0]).toMatchObject({ request: { title: "検索の改善 3" }, total: 2, done: 1 });
    expect(s.detail.request.rev).toBe(3);
    expect(s.detail.tasks.map((t: any) => [t.id, t.status])).toEqual([
      ["T001", "done"],
      ["T002", "todo"],
    ]);
    expect(s.tasks.map((t: any) => t.title)).toContain("ベクトル埋め込みで再ランク");
    expect(s.tasks.find((t: any) => t.id === "T002").relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
  });

  it("外での要望・タスクの追加・削除・アーカイブ、関係の追加・削除を取り込む", async () => {
    const { call, rid, cli, dataDir } = await setup();
    const ext = await cli();
    const other = await ext.requests.create({ title: "外で足した要望", status: "draft", body: "" });
    await ext.tasksOf(other.id).create({ title: "外のタスク", status: "todo" });
    await ext.tasksOf(rid).create({ title: "消すタスク", status: "todo" });
    await call("POST", "/reload");
    expect((await call("GET", "/requests")).body.map((p: any) => p.request.title).sort()).toEqual(["外で足した要望", "検索の改善"]);
    expect((await call("GET", `/requests/${rid}`)).body.tasks.map((t: any) => t.id)).toEqual(["T001", "T002"]);

    // 削除・アーカイブ・関係の削除
    const ext2 = await cli();
    await ext2.tasksOf(other.id).update("T001", { relations: [] });
    await ext2.tasksOf(rid).archive("T002");
    await rm(join(dataDir, "requests", other.id), { recursive: true });
    await call("POST", "/reload");
    expect((await call("GET", "/requests")).body.map((p: any) => p.request.id)).toEqual([rid]);
    expect((await call("GET", `/requests/${other.id}`)).status).toBe(404);
    expect((await call("GET", `/requests/${rid}`)).body.tasks.map((t: any) => t.id)).toEqual(["T001"]);
  });

  it("壊れた Markdown は errors に出して正常なものは返し、直すと消える。project.yaml が読めなければ 503 で何も変えない", async () => {
    const { call, rid, cli, dataDir } = await setup();
    const ext = await cli();
    await ext.tasksOf(rid).create({ title: "正常なタスク", status: "todo" });
    const t1 = join(dataDir, "requests", rid, "tasks", "T001.md");
    const good = await readFile(t1, "utf8");
    await writeFile(t1, "---\ntitle: [壊れた\n---\n");
    expect((await call("POST", "/reload")).body.errors).toBe(1);
    expect((await call("GET", "/project")).body.errors).toHaveProperty([`requests/${rid}/tasks/T001.md`]);
    expect((await call("GET", `/requests/${rid}`)).body.tasks.map((t: any) => t.id)).toEqual(["T002"]);
    await writeFile(t1, good);
    expect((await call("POST", "/reload")).body.errors).toBe(0);
    expect((await call("GET", `/requests/${rid}`)).body.tasks.map((t: any) => t.id)).toEqual(["T001", "T002"]);

    // project.yaml が壊れている・無い: 失敗にし、表示中の状態はそのまま
    const yaml = join(dataDir, "project.yaml");
    const original = await readFile(yaml, "utf8");
    await ext.requests.update(rid, { title: "読み直せなかった変更" });
    await writeFile(yaml, "name: [壊れた\n");
    const broken = await call("POST", "/reload");
    expect(broken.status).toBe(503);
    expect(broken.body.error).toContain("project.yaml を読めません");
    await rm(yaml);
    expect((await call("POST", "/reload")).status).toBe(503);
    expect((await call("GET", "/project")).body.project.name).toBe("test");
    expect((await call("GET", `/requests/${rid}`)).body.request.title).toBe("検索の改善");
    await writeFile(yaml, original);
    expect((await call("POST", "/reload")).status).toBe(200);
    expect((await call("GET", `/requests/${rid}`)).body.request.title).toBe("読み直せなかった変更");
  });

  it("読み直しだけでは本文・status・rev もファイルも変わらない", async () => {
    const { call, rid, dataDir } = await setup();
    const files = [join(dataDir, "project.yaml"), join(dataDir, "requests", rid, "request.md"), join(dataDir, "requests", rid, "tasks", "T001.md")];
    const before = await Promise.all(files.map((f) => readFile(f, "utf8")));
    await call("POST", "/reload");
    // ディスクから読んだ状態（作った直後のメモリ上の値とは本文の末尾の改行が違うので、読み直した後どうしで比べる）
    const detail = (await call("GET", `/requests/${rid}`)).body;
    await call("POST", "/reload");
    await call("POST", "/reload");
    expect(await Promise.all(files.map((f) => readFile(f, "utf8")))).toEqual(before);
    const after = (await call("GET", `/requests/${rid}`)).body;
    expect([after.request.body, after.request.status, after.request.rev, after.tasks[0].rev]).toEqual([
      detail.request.body,
      detail.request.status,
      detail.request.rev,
      detail.tasks[0].rev,
    ]);
  });

  it("画面からの更新と Preflight の進行・終了は監視なしでも通知され、読み直しの後も古い rev の保存は競合になる", async () => {
    const { call, rid, events, ctx, cli } = await setup();
    await call("PATCH", `/requests/${rid}`, { title: "画面で変えた", rev: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: "changed", kind: "request", request: rid }));
    const started = await call("POST", `/requests/${rid}/preflight`, { engine: "mock" });
    await ctx.preflight.wait(rid, started.body.id);
    expect(events).toContainEqual({ type: "preflight-status", runId: started.body.id, status: "completed" });
    await call("POST", "/reload");
    expect(events.at(-1)).toEqual({ type: "changed", kind: "reload" });

    // 外で更新された後に、画面が持っている古い rev で保存すると競合（読み直しでも書き込みの安全性は変わらない）
    const shown = (await call("GET", `/requests/${rid}`)).body.request.rev;
    await (await cli()).requests.update(rid, { title: "外で変えた" });
    await call("POST", "/reload");
    const stale = await call("PATCH", `/requests/${rid}`, { title: "古い画面から", rev: shown });
    expect(stale.status).toBe(409);
    expect(stale.body.current.title).toBe("外で変えた");
  });
});

describe("読み直しと他の操作が重なるとき", () => {
  /** タスクのコレクションの読み込みを、gate を開けるまで止める（要望の読み込みは済んでいる時点） */
  function holdTaskLoad(ws: Workspace, rid: string) {
    const col = ws.tasksOf(rid);
    const orig = col.prepareLoad.bind(col);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let reached!: () => void;
    const waiting = new Promise<void>((r) => (reached = r));
    col.prepareLoad = async () => {
      const p = await orig();
      reached();
      await gate;
      return p;
    };
    return { waiting, open, restore: () => (col.prepareLoad = orig) };
  }

  it("読み込みの途中は前の状態をまるごと返し（要望だけ新しいことはない）、終えてからまとめて入れ替わる", async () => {
    const { call, rid, cli, ctx } = await setup();
    const ext = await cli();
    await ext.requests.update(rid, { title: "新しいタイトル" });
    await ext.tasksOf(rid).create({ title: "新しいタスク", status: "todo" });
    const hold = holdTaskLoad(ctx.ws, rid);
    const reloading = call("POST", "/reload");
    await hold.waiting;
    const mid = (await call("GET", `/requests/${rid}`)).body;
    expect([mid.request.title, mid.tasks.length]).toEqual(["検索の改善", 1]);
    hold.open();
    expect((await reloading).status).toBe(200);
    const done = (await call("GET", `/requests/${rid}`)).body;
    expect([done.request.title, done.tasks.length]).toEqual(["新しいタイトル", 2]);
    hold.restore();
  });

  it("読み込みの間の画面からの更新・作成・アーカイブ、タスク化、監視の取り込みは、読み込んだ古い内容で戻さない", async () => {
    const { call, rid, cli, ctx, dataDir } = await setup();
    await newTask(ctx, rid, { title: "アーカイブするタスク" });
    const started = await call("POST", `/requests/${rid}/preflight`, { engine: "mock" });
    await ctx.preflight.wait(rid, started.body.id);
    const hold = holdTaskLoad(ctx.ws, rid);
    const reloading = ctx.ws.reloadAll();
    await hold.waiting; // ここまでに要望とタスクはディスクから読んである

    expect((await call("PATCH", `/requests/${rid}/tasks/T001`, { status: "doing", rev: 1 })).status).toBe(200);
    expect((await call("DELETE", `/requests/${rid}/tasks/T002`)).status).toBe(200);
    // タスク化してからタイトルを変える（評価のあとで変えたタイトルの run からはタスク化しないので、この順）
    const materialized = await call("POST", `/requests/${rid}/preflight/${started.body.id}/materialize`, {});
    expect(materialized.status).toBe(201);
    expect((await call("PATCH", `/requests/${rid}`, { title: "読み込み中に変えた" })).status).toBe(200);
    // 監視が拾った外の変更（1件の読み直し）
    const ext = await cli();
    await ext.tasksOf(rid).update("T001", { title: "外で変えた題名" });
    await (ctx.ws as unknown as { onFileChanged(rel: string): Promise<void> }).onFileChanged(`requests/${rid}/tasks/T001.md`);

    hold.open();
    await reloading;
    hold.restore();
    const after = (await call("GET", `/requests/${rid}`)).body;
    expect(after.request.title).toBe("読み込み中に変えた");
    const ids = after.tasks.map((t: any) => t.id);
    expect(ids).not.toContain("T002");
    expect(ids).toEqual(expect.arrayContaining(materialized.body.tasks.map((t: any) => t.id)));
    expect(after.tasks.find((t: any) => t.id === "T001")).toMatchObject({ status: "doing", title: "外で変えた題名" });
    // もう一度読み直してもディスクと同じ
    await ctx.ws.reloadAll();
    expect((await call("GET", `/requests/${rid}`)).body.tasks.map((t: any) => t.id)).toEqual(ids);
    expect(await readFile(join(dataDir, "requests", rid, "tasks", ".archive", "T002.md"), "utf8")).toContain("アーカイブするタスク");
  });

  it("同時には走らせない: 読み込み中の呼び出しはまとめて、終わってからもう1回だけ読む（その間の外の変更も入る）", async () => {
    const { rid, cli, ctx } = await setup();
    let loads = 0;
    const orig = ctx.ws.requests.prepareLoad.bind(ctx.ws.requests);
    ctx.ws.requests.prepareLoad = async () => {
      loads++;
      return orig();
    };
    const hold = holdTaskLoad(ctx.ws, rid);
    const first = ctx.ws.reloadAll();
    await hold.waiting;
    await (await cli()).requests.update(rid, { title: "1回目の読み込みの後に変えた" });
    const second = ctx.ws.reloadAll();
    const third = ctx.ws.reloadAll();
    expect(third).toBe(second);
    expect(loads).toBe(1);
    hold.restore();
    hold.open();
    await first;
    await second;
    expect(loads).toBe(2);
    expect(ctx.ws.requests.get(rid)?.title).toBe("1回目の読み込みの後に変えた");
    // 終わった後の呼び出しは新しく1回
    await ctx.ws.reloadAll();
    expect(loads).toBe(3);
  });

  it("失敗した読み込みの後も、次の呼び出しで読み直せる", async () => {
    const { ctx, dataDir } = await setup();
    const yaml = join(dataDir, "project.yaml");
    const original = await readFile(yaml, "utf8");
    await writeFile(yaml, "name: [壊れた\n");
    await expect(ctx.ws.reloadAll()).rejects.toThrow("project.yaml を読めません");
    await writeFile(yaml, original.replace("name: test", "name: 直した"));
    await expect(ctx.ws.reloadAll()).resolves.toMatchObject({ requests: 1 });
    expect(ctx.ws.project.name).toBe("直した");
  });
});
