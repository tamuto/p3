import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTask } from "../packages/tasks/src/core/requestOps.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * p3 move / p3 set の --json: 状態は変えたが手戻りの履歴を残せなかったとき（履歴が壊れている）、標準エラーの知らせに加えて、
 * JSON のトップレベルに API のタスクの PATCH と同じ項目名・文で reworkSkipped を返すこと。知らせが無ければ省くこと。以前の版の完了の記録は
 * 読まずに残すこと、
 * 標準出力は単独で JSON として読め、ほかの項目と標準エラーの知らせは今までどおりであることを確かめる
 */

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const LEGACY_COMPLETION = "completionRecords:\n  - id: broken\n    trigger: what";
const BROKEN_REWORK = "reworkHistory:\n  - id: X\n    cause: what";

/** 壊れた記録を持つタスクを用意する（status と壊れた記録を frontmatter に書く） */
async function setup(status: string, broken: string) {
  const p = await makeProject();
  const r = await newRequest(p.ctx, { title: "請求", body: "月末締め" });
  const { task } = await createTask(p.ctx, r.id, { title: "作業" });
  const file = join(p.dataDir, "requests", r.id, "tasks", `${task.id}.md`);
  await writeFile(file, (await readFile(file, "utf8")).replace("status: todo", `status: ${status}\n${broken}`));
  return { ...p, rid: r.id, tid: task.id, file };
}

/** 同じ壊れた記録のタスクに API の PATCH を当てた結果 */
async function apiPatch(status: string, broken: string, body: Record<string, unknown>) {
  const s = await setup(status, broken);
  const app = apiRoutes(await openTestProject(s.dataDir));
  const res = await app.request(`/requests/${s.rid}/tasks/${s.tid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("move / set の --json に記録を残せなかった知らせ", () => {
  it("以前の版の完了の記録（壊れていても）があるタスクを move・set で完了にすると、状態を変え、記録は読まずに残し、知らせも出さない", async () => {
    for (const args of [["move", "T001", "done"], ["set", "T001", "status=done"]]) {
      const { dataDir, rid, file } = await setup("doing", LEGACY_COMPLETION);
      const r = p3(dataDir, [...args, "--req", rid, "--json"]);
      expect(r.code, r.err).toBe(0);
      const json = JSON.parse(r.out) as Record<string, unknown>;
      expect(json).toMatchObject({ ref: `${rid}/T001`, status: "done" });
      expect(["completionSkipped" in json, "completionRecords" in json, "reworkSkipped" in json]).toEqual([false, false, false]);
      expect(await readFile(file, "utf8")).toContain("trigger: what");
    }
  });

  it("手戻りの履歴が壊れた完了タスクを move・set で再開すると、状態を変え、壊れた値を残し、reworkSkipped を API と同じ文で返す", async () => {
    const api = await apiPatch("done", BROKEN_REWORK, { status: "doing" });
    expect(api.reworkSkipped).toMatch(/手戻りの履歴が読めない/);
    for (const args of [["move", "T001", "doing"], ["set", "T001", "status=doing"]]) {
      const { dataDir, rid, file } = await setup("done", BROKEN_REWORK);
      const r = p3(dataDir, [...args, "--req", rid, "--json"]);
      expect(r.code, r.err).toBe(0);
      const json = JSON.parse(r.out) as Record<string, unknown>;
      expect(json).toMatchObject({ status: "doing", reworkSkipped: api.reworkSkipped });
      expect(r.err).toContain(api.reworkSkipped as string);
      expect(await readFile(file, "utf8")).toContain("cause: what");
    }
  });

  it("記録を残せた更新では両方の項目を省き、ほかの項目（警告など）と標準エラーの知らせは今までどおり", async () => {
    const p = await makeProject();
    const r = await newRequest(p.ctx, { title: "請求" });
    await createTask(p.ctx, r.id, { title: "作業", criteria: ["CSV で書き出せる"] });
    const moved = p3(p.dataDir, ["move", "T001", "done", "--req", r.id, "--json"]);
    expect(moved.code, moved.err).toBe(0);
    const json = JSON.parse(moved.out) as Record<string, unknown>;
    expect(json).toMatchObject({ status: "done" });
    expect("reworkSkipped" in json).toBe(false);
    // 受け入れ基準の不足の知らせは標準エラーのまま（JSON には混ぜない）
    expect(moved.err).toContain("受け入れ基準の不足");
    const set = p3(p.dataDir, ["set", "T001", "status=doing", "--req", r.id, "--json"]);
    const back = JSON.parse(set.out) as Record<string, unknown>;
    expect(back).toMatchObject({ status: "doing", reworkHistory: [expect.objectContaining({ cause: "reopen" })] });
    expect("reworkSkipped" in back).toBe(false);
  });
});
