import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { progress } from "../src/core/ops.ts";
import { materialOf } from "../src/core/releaseNotes/material.ts";
import { reviewInputOf } from "../src/core/milestoneReview/material.ts";
import { checkStatusChange } from "../src/core/requestStatus.ts";
import { ArchivedTaskReadError, getArchivedTask, listArchivedTasks } from "../src/core/store/archivedTasks.ts";
import { NotFoundError } from "../src/core/store/collection.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, newTask, tempDir } from "./helpers.ts";

/**
 * アーカイブしたタスクは専用の道（listArchivedTasks / getArchivedTask・API の archived-tasks・CLI の --archived）だけで読める。
 * 通常の一覧・進捗・対応済の判定・レビューとリリースノートの材料には入らない
 */

const MS = [{ id: "v1", title: "最初" }];

/** 完了 T001 を残し、未着手 T002 と記録つき完了 T003 をアーカイブした要望 */
async function setup() {
  const p = await makeProject({ milestones: MS });
  const req = await newRequest(p.ctx, { title: "要望", status: "active", milestone: "v1" });
  const tasks = p.ctx.ws.tasksOf(req.id);
  await newTask(p.ctx, req.id, { title: "残す完了", status: "done", record: "残した記録" });
  await newTask(p.ctx, req.id, { title: "捨てた未着手", body: "ARCHIVED-BODY-2" });
  await newTask(p.ctx, req.id, { title: "捨てた完了", status: "done", body: "ARCHIVED-BODY-3", record: "ARCHIVED-RECORD-3", outputs: ["ARCHIVED-OUTPUT-3"], relations: [{ type: "depends_on", target: "T001" }] });
  await tasks.archive("T002");
  await tasks.archive("T003");
  const archiveDir = join(p.dataDir, "requests", req.id, "tasks", ".archive");
  return { ...p, rid: req.id, tasks, archiveDir };
}

/** フォルダの中のファイルの名前・中身・更新日時 */
async function snapshot(dir: string) {
  const out: Record<string, [string, number]> = {};
  for (const f of await readdir(dir)) out[f] = [await readFile(join(dir, f), "utf8"), (await stat(join(dir, f))).mtimeMs];
  return out;
}

describe("アーカイブしたタスクの読み取り（core）", () => {
  it("一覧は ID の数値順で、本文・記録・成果物・日時・保存された関係を読める。archived: true が付く", async () => {
    const { ctx, rid, archiveDir } = await setup();
    await writeFile(join(archiveDir, "T010.md"), "---\nid: T010\ntitle: 十\nstatus: todo\nrev: 1\ncreatedAt: x\nupdatedAt: x\n---\n");
    const list = await listArchivedTasks(ctx.ws, rid);
    expect(list.request).toBe(rid);
    expect(list.tasks.map((t) => t.id)).toEqual(["T002", "T003", "T010"]);
    expect(list.errors).toEqual([]);
    const t3 = await getArchivedTask(ctx.ws, rid, "T003");
    expect(t3).toMatchObject({ archived: true, ref: `${rid}/T003`, request: rid, status: "done", record: "ARCHIVED-RECORD-3", outputs: ["ARCHIVED-OUTPUT-3"] });
    expect(t3.body).toContain("ARCHIVED-BODY-3");
    expect(t3.doneAt).toBeTruthy();
    expect(t3.relations).toEqual([expect.objectContaining({ type: "depends_on", target: "T001" })]);
  });

  it("フォルダが無ければ空。壊れたファイルは一覧の errors に出し、詳細は読めない（無いとは区別する）", async () => {
    const { ctx, rid, archiveDir } = await setup();
    const other = await newRequest(ctx, { title: "アーカイブなし" });
    expect(await listArchivedTasks(ctx.ws, other.id)).toEqual({ request: other.id, tasks: [], errors: [] });
    await writeFile(join(archiveDir, "T004.md"), "---\n: [broken\n---\n");
    await mkdir(join(archiveDir, "T005.md")); // ファイルでない
    await writeFile(join(archiveDir, "notes.md"), "ID の形でないものは無視する");
    const list = await listArchivedTasks(ctx.ws, rid);
    expect(list.tasks.map((t) => t.id)).toEqual(["T002", "T003"]);
    expect(list.errors.map((e) => e.id)).toEqual(["T004", "T005"]);
    await expect(getArchivedTask(ctx.ws, rid, "T004")).rejects.toBeInstanceOf(ArchivedTaskReadError);
    await expect(getArchivedTask(ctx.ws, rid, "T009")).rejects.toBeInstanceOf(NotFoundError);
    // 通常の完了の判定は壊れたアーカイブに左右されない
    await expect(checkStatusChange(ctx.ws, rid, "resolved")).resolves.toBeUndefined();
  });

  it("アーカイブのフォルダを読めなければ ArchivedTaskReadError", async () => {
    const { ctx } = await setup();
    const r = await newRequest(ctx, { title: "壊れたアーカイブ" });
    await mkdir(join(ctx.ws.requestsDir, r.id, "tasks"), { recursive: true });
    await writeFile(join(ctx.ws.requestsDir, r.id, "tasks", ".archive"), "フォルダでない");
    await expect(listArchivedTasks(ctx.ws, r.id)).rejects.toBeInstanceOf(ArchivedTaskReadError);
  });

  it("ID の形を確かめ、ほかの要望・データのフォルダの外は読まない", async () => {
    const { ctx, rid } = await setup();
    const other = await newRequest(ctx, { title: "別" });
    await expect(getArchivedTask(ctx.ws, other.id, "T003")).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of ["..", "../x", "260101-zzzzz"]) await expect(listArchivedTasks(ctx.ws, bad)).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of ["..", "../T001", "T1", "x"]) await expect(getArchivedTask(ctx.ws, rid, bad)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("通常に同じ ID があっても、明示した道どおりに読む。読んでもファイル・rev・採番は変わらない", async () => {
    const { ctx, rid, archiveDir, dataDir } = await setup();
    // 直接編集で通常にも T002 ができた（採番では起きないが、手で置いた）
    const live = join(dataDir, "requests", rid, "tasks", "T002.md");
    await writeFile(live, "---\nid: T002\ntitle: 通常の T002\nstatus: todo\nrev: 7\ncreatedAt: x\nupdatedAt: x\n---\n");
    await ctx.ws.tasksOf(rid).reload("T002");
    const before = await snapshot(archiveDir);
    expect((await getArchivedTask(ctx.ws, rid, "T002")).title).toBe("捨てた未着手");
    await listArchivedTasks(ctx.ws, rid);
    expect(ctx.ws.tasksOf(rid).get("T002")?.title).toBe("通常の T002");
    expect(ctx.ws.tasksOf(rid).get("T002")?.rev).toBe(7);
    expect(await snapshot(archiveDir)).toEqual(before);
    // アーカイブの ID は使わない（新しいタスクは T004）
    expect((await newTask(ctx, rid, { title: "新" })).id).toBe("T004");
  });
});

describe("アーカイブは通常の一覧・集計・材料に入らない", () => {
  it("対応済にでき、進捗は残した完了だけ。レビューとリリースノートの材料にアーカイブの本文・記録・成果物が入らない", async () => {
    const { ctx, rid } = await setup();
    await listArchivedTasks(ctx.ws, rid); // 専用の道で読んだ後も
    expect(ctx.ws.tasksOf(rid).list().map((t) => t.id)).toEqual(["T001"]);
    await expect(checkStatusChange(ctx.ws, rid, "resolved")).resolves.toBeUndefined();
    await ctx.ws.requests.update(rid, { status: "resolved" });
    const p = progress(ctx).find((x) => x.request.id === rid)!;
    expect([p.done, p.total]).toEqual([1, 1]);
    for (const material of [materialOf(ctx.ws, "v1"), reviewInputOf(ctx.ws, "v1")]) {
      const text = JSON.stringify(material);
      expect(text).toContain("残した記録");
      for (const s of ["ARCHIVED-BODY", "ARCHIVED-RECORD", "ARCHIVED-OUTPUT", "捨てた"]) expect(text).not.toContain(s);
    }
  });

  it("全部アーカイブして子が無ければ、タスクなしとして対応済にできない", async () => {
    const { ctx, rid, tasks } = await setup();
    await tasks.archive("T001");
    expect((await listArchivedTasks(ctx.ws, rid)).tasks).toHaveLength(3);
    await expect(checkStatusChange(ctx.ws, rid, "resolved")).rejects.toThrow("タスクがありません");
  });
});

describe("API の archived-tasks", () => {
  const get = async (app: ReturnType<typeof apiRoutes>, path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("一覧と詳細を返し、通常の tasks はアーカイブを探さない", async () => {
    const { ctx, rid, archiveDir } = await setup();
    const app = apiRoutes(ctx);
    await writeFile(join(archiveDir, "T004.md"), "---\n: [broken\n---\n");
    const list = await get(app, `/requests/${rid}/archived-tasks`);
    expect(list.status).toBe(200);
    expect((list.body.tasks as { id: string; archived: boolean }[]).map((t) => [t.id, t.archived])).toEqual([["T002", true], ["T003", true]]);
    expect((list.body.errors as { id: string }[]).map((e) => e.id)).toEqual(["T004"]);
    const one = await get(app, `/requests/${rid}/archived-tasks/3`);
    expect(one.status).toBe(200);
    expect(one.body.task).toMatchObject({ id: "T003", archived: true, record: "ARCHIVED-RECORD-3" });
    expect((await get(app, `/requests/${rid}/archived-tasks/T004`)).body.code).toBe("archive_unreadable");
    expect((await app.request(`/requests/${rid}/archived-tasks/T004`)).status).toBe(500);
    expect((await app.request(`/requests/${rid}/archived-tasks/T009`)).status).toBe(404);
    expect((await app.request(`/requests/260101-zzzzz/archived-tasks`)).status).toBe(404);
    // 通常の道
    expect((await app.request(`/requests/${rid}/tasks/T003`)).status).toBe(404);
    expect(((await get(app, `/requests/${rid}/tasks`)).body as unknown as { id: string }[]).map((t) => t.id)).toEqual(["T001"]);
    expect((await app.request(`/requests/${rid}/tasks/T003`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) })).status).toBe(404);
  });
});

describe("CLI の --archived", () => {
  const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
  const p3 = (dataDir: string, args: string[]) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-") };
    const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("ls / show に --archived を付けたときだけアーカイブを読む", async () => {
    const { rid, dataDir } = await setup();
    const ls = p3(dataDir, ["ls", "--req", rid, "--archived", "--json"]);
    expect(ls.code).toBe(0);
    expect((JSON.parse(ls.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual(["T002", "T003"]);
    expect(p3(dataDir, ["ls", "--req", rid, "--archived"]).out).toContain("捨てた完了");
    expect((JSON.parse(p3(dataDir, ["ls", "--req", rid, "--json"]).out) as { id: string }[]).map((t) => t.id)).toEqual(["T001"]);

    const show = p3(dataDir, ["show", `${rid}/T3`, "--archived", "--json"]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out).item).toMatchObject({ id: "T003", archived: true, record: "ARCHIVED-RECORD-3" });
    const text = p3(dataDir, ["show", "T003", "--req", rid, "--archived"]).out;
    expect(text).toContain("アーカイブ・閲覧専用");
    expect(text).toContain("ARCHIVED-RECORD-3");

    expect(p3(dataDir, ["show", `${rid}/T003`, "--json"]).code).toBe(2); // 通常の show は探さない
    expect(p3(dataDir, ["show", `${rid}/T009`, "--archived"]).code).toBe(2);
    expect(p3(dataDir, ["ls", "--archived", "--all"]).code).toBe(1);
  });
});
