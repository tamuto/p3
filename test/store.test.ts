import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../src/server/store/collection.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../src/server/store/frontmatter.ts";
import { slugify } from "../src/server/store/fsutil.ts";
import { normalizeProject, normalizeTask } from "../src/server/store/normalize.ts";
import { writeProjectFile } from "../src/server/store/projectFile.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { makeProject, newTask, projectConfig, tempDir } from "./helpers.ts";

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
  it("YAML の日付型を YYYY-MM-DD に戻し、不正な関係は捨てる", () => {
    const t = normalizeTask(
      {
        title: "t",
        start: new Date("2026-10-01T00:00:00Z"),
        due: "2026-10-05",
        estimate: "1.5",
        labels: "single",
        relations: [
          { type: "depends_on", target: "TASK-0001" },
          { type: "unknown", target: "TASK-0002" },
          { type: "impacts" },
          "garbage",
        ],
      },
      "body",
      "TASK-0009",
    );
    expect(t.start).toBe("2026-10-01");
    expect(t.due).toBe("2026-10-05");
    expect(t.estimate).toBe(1.5);
    expect(t.labels).toEqual(["single"]);
    expect(t.relations).toEqual([{ type: "depends_on", target: "TASK-0001" }]);
    expect(t.status).toBe("backlog");
  });

  it("プロジェクト設定の既定値を補い、メンバーの kind を正規化する", () => {
    const p = normalizeProject({ members: [{ id: "a" }, { id: "b", kind: "ai", name: "B" }, { name: "no id" }] });
    expect(p.name).toBe("pcube project");
    expect(p.statuses.map((s) => s.id)).toContain("done");
    expect(p.members).toEqual([
      { id: "a", name: "a", email: undefined, role: undefined, kind: "human" },
      { id: "b", name: "B", email: undefined, role: undefined, kind: "ai" },
    ]);
    expect(p.preflight.instructions).toBe("");
  });

  it("slugify は英数字だけを残し、日本語だけなら空", () => {
    expect(slugify("Add MCP Server!")).toBe("add-mcp-server");
    expect(slugify("通知機能")).toBe("");
  });
});

describe("MarkdownCollection", () => {
  it("連番で採番し、1タスク1ファイルで書く", async () => {
    const { ctx, dataDir } = await makeProject();
    const a = await newTask(ctx, { title: "A" });
    const b = await newTask(ctx, { title: "B", areas: ["src/x"] });
    expect([a.id, b.id]).toEqual(["TASK-0001", "TASK-0002"]);
    expect(await readdir(join(dataDir, "tasks"))).toEqual(["TASK-0001.md", "TASK-0002.md"]);
    const { data } = parseFrontmatter(await readFile(join(dataDir, "tasks", "TASK-0002.md"), "utf8"));
    expect(data).toMatchObject({ id: "TASK-0002", title: "B", areas: ["src/x"], rev: 1, updatedBy: "test" });
  });

  it("別プロセスが同じ番号のファイルを先に作っていたら次の番号にする", async () => {
    const { ctx, dataDir } = await makeProject();
    await newTask(ctx, { title: "A" });
    // 他のプロセスが TASK-0002 を作った（このプロセスのキャッシュはまだ知らない）
    await writeFile(join(dataDir, "tasks", "TASK-0002.md"), "---\ntitle: other\n---\n");
    const c = await newTask(ctx, { title: "C" });
    expect(c.id).toBe("TASK-0003");
  });

  it("rev が違えば更新を拒み、一致すれば rev を進める", async () => {
    const { ctx } = await makeProject();
    const t = await newTask(ctx, { title: "A" });
    const u = await ctx.ws.tasks.update(t.id, { status: "ready" }, { expectedRev: 1, actor: "human:a" });
    expect(u.rev).toBe(2);
    expect(u.updatedBy).toBe("human:a");
    await expect(ctx.ws.tasks.update(t.id, { status: "done" }, { expectedRev: 1 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("更新の直前にディスクを読み直すので、外部での編集を上書きしない", async () => {
    const { ctx, dataDir } = await makeProject();
    const t = await newTask(ctx, { title: "A" });
    const path = join(dataDir, "tasks", `${t.id}.md`);
    const text = await readFile(path, "utf8");
    // エディタや AI がファイルを直接書き換えた（rev も進めた）
    await writeFile(path, text.replace("title: A", "title: 外部で変更").replace("rev: 1", "rev: 2"));
    await expect(ctx.ws.tasks.update(t.id, { status: "ready" }, { expectedRev: 1 })).rejects.toBeInstanceOf(ConflictError);
    const u = await ctx.ws.tasks.update(t.id, { status: "ready" });
    expect(u.title).toBe("外部で変更");
    expect(u.rev).toBe(3);
  });

  it("壊れたファイルがあっても他は読め、エラーとして記録する", async () => {
    const { dataDir } = await makeProject();
    await writeFile(join(dataDir, "tasks", "TASK-0001.md"), "---\ntitle: ok\n---\n");
    await writeFile(join(dataDir, "tasks", "TASK-0002.md"), "---\ntitle: [壊れた\n---\n");
    const ws = new Workspace(dataDir);
    await ws.load();
    expect(ws.tasks.list().map((t) => t.id)).toEqual(["TASK-0001"]);
    expect([...ws.tasks.errors.keys()]).toEqual(["TASK-0002"]);
  });

  it("アーカイブは物理削除せず .archive/ に移す", async () => {
    const { ctx, dataDir } = await makeProject();
    const t = await newTask(ctx, { title: "A" });
    await ctx.ws.tasks.archive(t.id);
    expect(ctx.ws.tasks.get(t.id)).toBeUndefined();
    expect(existsSync(join(dataDir, "tasks", ".archive", `${t.id}.md`))).toBe(true);
    await expect(ctx.ws.tasks.archive(t.id)).rejects.toBeInstanceOf(NotFoundError);
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
    const p = await ctx.ws.saveProject({ members: [{ id: "a", name: "A", kind: "ai" }] });
    expect(p.members[0].kind).toBe("ai");
    expect(ctx.ws.member("ai:a")?.name).toBe("A");
    expect(ctx.ws.member("a")?.name).toBe("A");
    expect(events).toContain("project");
  });
});
