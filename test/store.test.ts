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
import { RELATION_TYPES, relationRole, relationTypes } from "../src/shared/types.ts";
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
        status: "review", // 3つ以外のステータス（以前は列を設定できた）は未着手として読む
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

  it("プロジェクト設定の既定値を補う", () => {
    const p = normalizeProject({ statuses: [{ id: "hold", label: "保留" }] });
    expect(p.name).toBe("p3 project");
    expect(p).not.toHaveProperty("statuses"); // 列は 未着手 / 作業中 / 完了 で固定
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

  it("アーカイブ済みのタスクの ID は採番で使わない（最大番号・全部・読み直し後・壊れたファイル・T1000 以降）", async () => {
    const { ctx, dataDir } = await makeProject();
    const r = await newRequest(ctx);
    const tasks = ctx.ws.tasksOf(r.id);
    await newTask(ctx, r.id, { title: "A" });
    const b = await newTask(ctx, r.id, { title: "B" });
    await tasks.archive(b.id); // 最大番号をアーカイブ
    expect((await newTask(ctx, r.id, { title: "C" })).id).toBe("T003");
    // 全部アーカイブしても続きの番号
    for (const t of tasks.list()) await tasks.archive(t.id);
    expect(tasks.list()).toEqual([]);
    expect((await newTask(ctx, r.id, { title: "D" })).id).toBe("T004");

    // 読み直した後も同じ。アーカイブの中の壊れたファイルも名前が有効なら予約、無効な名前は無視、読み込みの対象にはしない
    const archive = join(dataDir, "requests", r.id, "tasks", ".archive");
    await writeFile(join(archive, "T009.md"), "---\n: broken\n---\n");
    await writeFile(join(archive, "memo.md"), "x");
    await writeFile(join(archive, "T99999.md.bak"), "x");
    const ws = new Workspace(dataDir);
    await ws.load();
    expect(ws.tasksOf(r.id).list().map((t) => t.id)).toEqual(["T004"]);
    expect((await ws.tasksOf(r.id).create({ title: "E" })).id).toBe("T010");

    // T1000 以降も数として比べる
    await writeFile(join(archive, "T1000.md"), "x");
    expect((await ws.tasksOf(r.id).create({ title: "F" })).id).toBe("T1001");

    // 同時に作っても重ならない（排他作成で次の番号へ）
    const other = new Workspace(dataDir);
    await other.load();
    const made = await Promise.all([ws, other, ws, other].map((w, i) => w.tasksOf(r.id).create({ title: `G${i}` })));
    expect(new Set(made.map((t) => t.id)).size).toBe(4);
    expect(made.map((t) => t.id).every((id) => Number(id.slice(1)) > 1001)).toBe(true);
  });

  it("アーカイブに同じ ID があれば上書きせず、元のファイルを残す", async () => {
    const { ctx, dataDir } = await makeProject();
    const r = await newRequest(ctx);
    const t = await newTask(ctx, r.id, { title: "A" });
    const archive = join(dataDir, "requests", r.id, "tasks", ".archive");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "T001.md"), "前からあるアーカイブ");
    await expect(ctx.ws.tasksOf(r.id).archive(t.id)).rejects.toThrow("上書きしません");
    expect(await readFile(join(archive, "T001.md"), "utf8")).toBe("前からあるアーカイブ");
    expect(existsSync(join(dataDir, "requests", r.id, "tasks", "T001.md"))).toBe(true);
    expect(ctx.ws.tasksOf(r.id).get("T001")?.title).toBe("A");
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
    await writeFile(path, "# このプロジェクトの設定\nname: old # 名前\nrepo: ..\ndocs:\n  - README.md\nstatuses:\n  - id: todo\n    label: 未着手\n");
    await writeProjectFile(path, projectConfig({ name: "new", preflight: { instructions: "観点" } }));
    const text = await readFile(path, "utf8");
    expect(text).toContain("# このプロジェクトの設定");
    expect(text).toContain("name: new");
    expect(text).toContain("instructions: 観点");
    expect(text).not.toContain("statuses"); // 列の設定は無くなったので消す
    expect(text).not.toContain("docs:"); // 以前のプロジェクトの docs は消す（主なフォルダの入口で示す）
    expect(text.indexOf("name:")).toBeLessThan(text.indexOf("preflight:")); // 後から足した項目も決まった順
    expect(text).toContain("repo: .."); // 知らない項目は設定の保存では消さない
    expect(normalizeProject((await import("yaml")).parse(text)).preflight.instructions).toBe("観点");
  });

  it("saveProject は変更を書いて読み直し、変更を通知する", async () => {
    const { ctx } = await makeProject();
    const events: string[] = [];
    ctx.ws.on((e) => e.type === "changed" && events.push(e.kind));
    const p = await ctx.ws.saveProject({ description: "変えた" });
    expect(p.description).toBe("変えた");
    expect(events).toContain("project");
  });
});


describe("関係の表示（相手の役割）", () => {
  it("A → B と張ったとき、A には B の役割、B には A の役割を出す。種類の識別子は変えない", () => {
    // [種類, A から見た B, B から見た A]
    const table: [string, string, string][] = [
      ["depends_on", "依存先", "依存元"], // T002 は T001 に依存 → T002「依存先 T001」/ T001「依存元 T002」
      ["part_of", "親", "子"], // T003 は要望 R の一部 → T003「親 R」/ R「子 T003」
      ["derived_from", "派生元", "派生先"],
      ["impacts", "影響先", "影響元"],
      ["relates_to", "関連", "関連"],
      ["duplicates", "重複", "重複"],
      ["supersedes", "旧案", "新案"], // T005 が T001 を置き換え → T005「旧案 T001」/ T001「新案 T005」
    ];
    expect(relationTypes).toEqual(table.map(([t]) => t));
    for (const [t, out, inn] of table) {
      expect(relationRole(t, "out")).toBe(out);
      expect(relationRole(t, "in")).toBe(inn);
      expect(RELATION_TYPES[t as keyof typeof RELATION_TYPES].verb).toBeTruthy();
    }
    expect(relationRole("unknown", "out")).toBe("unknown");
    expect(RELATION_TYPES.depends_on.schedule).toBe(true);
  });
});
