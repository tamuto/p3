import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { absRef, normalizeTaskId, parseRef, relRef, REQUEST_ID, taskId } from "../src/shared/refs.ts";
import { ConflictError, NotFoundError } from "../src/server/store/collection.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/server/store/frontmatter.ts";
import { newRequestId, slugify } from "../src/server/store/fsutil.ts";
import { normalizeProject, normalizeTaskIn } from "../src/server/store/normalize.ts";
import { writeProjectFile } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { makeProject, newRequest, newTask, projectConfig, tempDir } from "./helpers.ts";

describe("参照", () => {
  it("要望 ID は 作成日-乱数5文字。時刻順に並ぶ", () => {
    const id = newRequestId(new Date(2026, 9, 9, 8, 0));
    expect(id).toMatch(REQUEST_ID);
    expect(id.startsWith("261009-")).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => newRequestId())).size).toBe(200);
  });

  it("タスク ID は要望の中の連番", () => {
    expect(taskId(3)).toBe("T003");
    expect(taskId(1200)).toBe("T1200");
    expect(normalizeTaskId("t3")).toBe("T003");
    expect(normalizeTaskId("12")).toBe("T012");
    expect(normalizeTaskId("x")).toBeUndefined();
  });

  it("相対参照は張った側の要望の中、絶対参照はそのまま。ファイルには短い形で書く", () => {
    const a = "261009-abcde";
    const b = "261001-zzzzz";
    expect(parseRef("T3", a)).toEqual({ request: a, task: "T003" });
    expect(parseRef("T3")).toBeUndefined();
    expect(absRef(`${b}/T1`, a)).toBe(`${b}/T001`);
    expect(absRef(b, a)).toBe(b);
    expect(relRef(`${a}/T2`, a)).toBe("T002");
    expect(relRef(`${b}/T2`, a)).toBe(`${b}/T002`);
    expect(parseRef("REQ-1/T1")).toBeUndefined();
  });
});

describe("frontmatter", () => {
  it("書いて読むと元に戻る（本文の前の空行は付かない）", () => {
    const text = stringifyFrontmatter({ title: "a", labels: ["x"], empty: [], none: undefined }, "本文\n\n- 箇条書き");
    expect(text).not.toContain("empty");
    expect(text).not.toContain("none");
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({ title: "a", labels: ["x"] });
    expect(body).toBe("本文\n\n- 箇条書き\n");
  });

  it("frontmatter が無ければ全体を本文とみなす", () => {
    expect(parseFrontmatter("ただの文章")).toEqual({ data: {}, body: "ただの文章" });
  });
});

describe("normalize", () => {
  it("要望とタスクの参照を場所から決め、YAML の日付型を戻し、不正な関係は捨てる", () => {
    const t = normalizeTaskIn("261009-abcde")(
      {
        title: "t",
        start: new Date("2026-10-01T00:00:00Z"), // 予定の日付は持たない（古いファイルにあっても読まない）
        startedAt: new Date("2026-10-01T09:00:00Z"),
        estimate: "1.5", // 見積りは持たない（古いファイルにあっても読まない）
        labels: "single",
        outputs: ["https://example.com/pull/1"],
        relations: [{ type: "depends_on", target: "T001" }, { type: "unknown", target: "T002" }, { type: "impacts" }, "garbage"],
      },
      "body",
      "T009",
    );
    expect(t).toMatchObject({ id: "T009", request: "261009-abcde", ref: "261009-abcde/T009", startedAt: "2026-10-01T09:00:00.000Z" });
    expect(t).not.toHaveProperty("start");
    expect(t).not.toHaveProperty("estimate");
    expect(t.labels).toEqual(["single"]);
    expect(t.outputs).toEqual(["https://example.com/pull/1"]);
    expect(t.relations).toEqual([{ type: "depends_on", target: "T001" }]);
    expect(t.status).toBe("todo");
  });

  it("プロジェクト設定の既定値を補う（列は 未着手 / 作業中 / 完了）", () => {
    const p = normalizeProject({});
    expect(p.name).toBe("pcube project");
    expect(p.statuses.map((s) => s.id)).toEqual(["todo", "doing", "done"]);
    expect(p.preflight.instructions).toBe("");
  });

  it("slugify は英数字だけを残し、日本語だけなら空", () => {
    expect(slugify("Add MCP Server!")).toBe("add-mcp-server");
    expect(slugify("通知機能")).toBe("");
  });
});

describe("要望とタスク", () => {
  it("要望ごとにフォルダを作り、タスクはその中に連番で置く", async () => {
    const { ctx, dataDir } = await makeProject();
    const a = await newRequest(ctx, { title: "A" });
    const b = await newRequest(ctx, { title: "B" });
    expect(a.id).toMatch(REQUEST_ID);
    expect(a.id).not.toBe(b.id);
    const a1 = await newTask(ctx, a.id, { title: "A-1" });
    const a2 = await newTask(ctx, a.id, { title: "A-2", areas: ["src/x"] });
    const b1 = await newTask(ctx, b.id, { title: "B-1" });
    expect([a1.id, a2.id, b1.id]).toEqual(["T001", "T002", "T001"]);
    expect([a1.ref, b1.ref]).toEqual([`${a.id}/T001`, `${b.id}/T001`]);
    expect(await readdir(join(dataDir, "requests", a.id))).toEqual(expect.arrayContaining(["request.md", "tasks"]));
    expect(await readdir(join(dataDir, "requests", a.id, "tasks"))).toEqual(["T001.md", "T002.md"]);
    const { data } = parseFrontmatter(await readFile(join(dataDir, "requests", a.id, "tasks", "T002.md"), "utf8"));
    expect(data).toMatchObject({ id: "T002", title: "A-2", areas: ["src/x"], rev: 1, updatedBy: "test" });
    // 要望・参照は場所から決まるのでファイルには書かない
    expect(data).not.toHaveProperty("request");
    expect(data).not.toHaveProperty("ref");
    expect(ctx.ws.allTasks().map((t) => t.ref)).toHaveLength(3);
    expect(ctx.ws.task(`${a.id}/T2`)?.title).toBe("A-2");
  });

  it("ステータスを変えた日時を記録する（作業中にした / 完了にした。戻したら消す）", async () => {
    const { ctx } = await makeProject();
    const r = await newRequest(ctx);
    const tasks = ctx.ws.tasksOf(r.id);
    const t = await newTask(ctx, r.id, { title: "A" });
    expect(t.startedAt).toBeUndefined();
    const doing = await tasks.update(t.id, { status: "doing" });
    expect(doing.startedAt).toBe(doing.updatedAt);
    const relabel = await tasks.update(t.id, { labels: ["x"] });
    expect(relabel.startedAt).toBe(doing.startedAt); // ステータスが変わらなければそのまま
    const done = await tasks.update(t.id, { status: "done" });
    expect(done).toMatchObject({ startedAt: doing.startedAt, doneAt: done.updatedAt });
    const checked = await tasks.update(t.id, { checkedAt: "2026-10-09T08:00:00.000Z" });
    expect(checked.checkedAt).toBe("2026-10-09T08:00:00.000Z");
    const back = await tasks.update(t.id, { status: "doing" });
    expect(back.doneAt).toBeUndefined();
    expect(back.checkedAt).toBeUndefined(); // 完了から戻したら人の「済み」も消える
    expect((await tasks.update(t.id, { status: "todo" })).startedAt).toBeUndefined();
    // いきなり完了で作っても両方付く。ファイルにも書かれる
    const d = await newTask(ctx, r.id, { title: "B", status: "done" });
    expect(d.startedAt && d.doneAt).toBeTruthy();
    expect(await readFile(tasks.path(d.id), "utf8")).toContain("doneAt:");
  });

  it("要望の期限・マイルストーン・タグを読み書きする", async () => {
    const { ctx } = await makeProject({ milestones: [{ id: "v1", title: "最初", due: "2026-11-30" }] });
    const r = await newRequest(ctx, { title: "A", due: "2026-11-01", milestone: "v1", tags: ["ui", "bug"] });
    await ctx.ws.load();
    expect(ctx.ws.requests.get(r.id)).toMatchObject({ due: "2026-11-01", milestone: "v1", tags: ["ui", "bug"] });
    expect(ctx.ws.project.milestones).toEqual([{ id: "v1", title: "最初", due: "2026-11-30", done: undefined }]);
  });

  it("別のプロセスが同じ番号のタスクを先に作っていたら次の番号にする", async () => {
    const { ctx, dataDir } = await makeProject();
    const r = await newRequest(ctx);
    await newTask(ctx, r.id, { title: "A" });
    await writeFile(join(dataDir, "requests", r.id, "tasks", "T002.md"), "---\ntitle: other\n---\n");
    expect((await newTask(ctx, r.id, { title: "C" })).id).toBe("T003");
  });

  it("rev が違えば更新を拒み、一致すれば rev を進める", async () => {
    const { ctx } = await makeProject();
    const r = await newRequest(ctx);
    const t = await newTask(ctx, r.id, { title: "A" });
    const tasks = ctx.ws.tasksOf(r.id);
    const u = await tasks.update(t.id, { status: "doing" }, { expectedRev: 1, actor: "ai:claude" });
    expect(u).toMatchObject({ rev: 2, updatedBy: "ai:claude", ref: t.ref });
    await expect(tasks.update(t.id, { status: "done" }, { expectedRev: 1 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("更新の直前にディスクを読み直すので、外部での編集を上書きしない", async () => {
    const { ctx } = await makeProject();
    const r = await newRequest(ctx);
    const t = await newTask(ctx, r.id, { title: "A" });
    const tasks = ctx.ws.tasksOf(r.id);
    const path = tasks.path(t.id);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("title: A", "title: 外部で変更").replace("rev: 1", "rev: 2"));
    await expect(tasks.update(t.id, { status: "doing" }, { expectedRev: 1 })).rejects.toBeInstanceOf(ConflictError);
    const u = await tasks.update(t.id, { status: "doing" });
    expect(u).toMatchObject({ title: "外部で変更", rev: 3 });
  });

  it("壊れたファイルがあっても他は読め、エラーとして場所を記録する", async () => {
    const { ctx, dataDir } = await makeProject();
    const r = await newRequest(ctx);
    const dir = join(dataDir, "requests", r.id, "tasks");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "T001.md"), "---\ntitle: ok\n---\n");
    await writeFile(join(dir, "T002.md"), "---\ntitle: [壊れた\n---\n");
    await writeFile(join(dir, "memo.md"), "タスク以外のファイルは無視する");
    const ws = new Workspace(dataDir);
    await ws.load();
    expect(ws.tasksOf(r.id).list().map((t) => t.id)).toEqual(["T001"]);
    expect(Object.keys(ws.errors())).toEqual([`requests/${r.id}/tasks/T002.md`]);
  });

  it("アーカイブは物理削除せず .archive/ に移す（タスクも要望も）", async () => {
    const { ctx, dataDir } = await makeProject();
    const r = await newRequest(ctx);
    const t = await newTask(ctx, r.id, { title: "A" });
    await ctx.ws.tasksOf(r.id).archive(t.id);
    expect(existsSync(join(dataDir, "requests", r.id, "tasks", ".archive", "T001.md"))).toBe(true);
    await expect(ctx.ws.tasksOf(r.id).archive(t.id)).rejects.toBeInstanceOf(NotFoundError);
    await ctx.ws.requests.archive(r.id);
    expect(existsSync(join(dataDir, "requests", ".archive", r.id, "request.md"))).toBe(true);
    expect(ctx.ws.requests.get(r.id)).toBeUndefined();
  });

  it("git pull などで要望のフォルダが増えても、読み直せば取り込める", async () => {
    const { ctx, dataDir } = await makeProject();
    const id = "261001-pulld";
    await mkdir(join(dataDir, "requests", id, "tasks"), { recursive: true });
    await writeFile(join(dataDir, "requests", id, "request.md"), "---\ntitle: 他の人の要望\nstatus: active\n---\n");
    await writeFile(join(dataDir, "requests", id, "tasks", "T001.md"), "---\ntitle: 他の人のタスク\n---\n");
    await ctx.ws.load();
    expect(ctx.ws.requests.get(id)?.title).toBe("他の人の要望");
    expect(ctx.ws.task(`${id}/T001`)?.title).toBe("他の人のタスク");
  });
});

describe("project.yaml", () => {
  it("人が書いたコメントを残したまま更新する", async () => {
    const dir = tempDir();
    const path = join(dir, "project.yaml");
    await writeFile(path, "# このプロジェクトの設定\nname: old # 名前\nrepo: ..\n");
    await writeProjectFile(path, projectConfig({ name: "new", docs: ["docs"], preflight: { instructions: "観点" } }));
    const text = await readFile(path, "utf8");
    expect(text).toContain("# このプロジェクトの設定");
    expect(text).toContain("name: new");
    expect(text).toContain("instructions: 観点");
    expect(normalizeProject((await import("yaml")).parse(text)).docs).toEqual(["docs"]);
  });

  it("saveProject は変更を書いて読み直し、変更を通知する", async () => {
    const { ctx } = await makeProject();
    const events: string[] = [];
    ctx.ws.on((e) => e.type === "changed" && events.push(e.kind));
    const p = await ctx.ws.saveProject({ docs: ["docs/design.md"] });
    expect(p.docs).toEqual(["docs/design.md"]);
    expect(events).toContain("project");
  });
});
