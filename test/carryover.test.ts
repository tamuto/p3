import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreflightEngine } from "../src/server/preflight/engine.ts";
import { MockEngine } from "../src/server/preflight/mockEngine.ts";
import { makeRepo, newRequest, openTestProject } from "./helpers.ts";

/** 必ず失敗するエンジン（直近の run が失敗した状態を作る） */
const failing: PreflightEngine = {
  name: "codex",
  status: async () => ({ name: "codex", ok: true, detail: "" }),
  run: async () => {
    throw new Error("落ちた");
  },
};

async function setup() {
  const repo = await makeRepo();
  const ctx = await openTestProject(repo.dataDir, { mock: new MockEngine({ delay: 0 }), codex: failing });
  const req = await newRequest(ctx, { title: "x", status: "draft", body: "- 作る" });
  const preflight = async (engine: PreflightEngine["name"] = "mock") => {
    const { id } = await ctx.preflight.start(req.id, { engine, actor: "human:a" });
    return (await ctx.preflight.wait(req.id, id))!;
  };
  const carryover = (runId: string) => readFileSync(join(ctx.ws.preflight.runDir(req.id, runId), "carryover.md"), "utf8");
  return { ...repo, ctx, req, preflight, carryover };
}

describe("Preflight へのメモ", () => {
  it("1件1ファイルで書き足し、書いた人と日時を残す。古い順に読む", async () => {
    const { ctx, req, dataDir } = await setup();
    const a = await ctx.ws.notes.add(req.id, "  対象は CLI だけ  ", "human:a");
    const b = await ctx.ws.notes.add(req.id, "Web は不要", "ai:claude");
    expect(a).toMatchObject({ body: "対象は CLI だけ", createdBy: "human:a" });
    expect(a.id).toMatch(/^N-\d{8}-\d{6}-[0-9a-f]{4}$/);
    const text = readFileSync(join(dataDir, "requests", req.id, "notes", `${a.id}.md`), "utf8");
    expect(text).toContain("createdBy: human:a");
    const { notes, invalid } = await ctx.ws.notes.list(req.id);
    expect(notes.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(invalid).toEqual([]);
    await expect(ctx.ws.notes.add(req.id, "  \n ")).rejects.toThrow("空");
  });

  it("読めないメモは理由を返し、Preflight のログにも残す", async () => {
    const { ctx, req, dataDir, preflight } = await setup();
    const dir = join(dataDir, "requests", req.id, "notes");
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "memo.md"), "手で置いたファイル");
    writeFileSync(join(dir, "N-20261009-120000-abcd.md"), "---\ncreatedAt: 2026-10-09T12:00:00Z\n---\n");
    const { notes, invalid } = await ctx.ws.notes.list(req.id);
    expect(notes).toEqual([]);
    expect(invalid.map((i) => i.file).sort()).toEqual(["notes/N-20261009-120000-abcd.md", "notes/memo.md"]);
    const run = await preflight();
    expect(run.log.filter((l) => l.kind === "error").map((l) => l.text)).toEqual([
      expect.stringContaining("読めないメモ"),
      expect.stringContaining("読めないメモ"),
    ]);
  });
});

describe("前回の結果とメモの引き継ぎ", () => {
  it("最初の run は前回なし。メモがあれば全部渡し、carryover.md に固定する", async () => {
    const { ctx, req, preflight, carryover } = await setup();
    const first = await preflight();
    expect(first).toMatchObject({ status: "completed", startedBy: "human:a" });
    expect(first.previous).toBeUndefined();
    expect(first.notes).toBeUndefined();

    const n = await ctx.ws.notes.add(req.id, "CLI だけでよい", "human:a");
    const second = await preflight();
    expect(second.previous).toBe(first.id);
    expect(second.notes).toEqual([n.id]);
    expect(carryover(second.id)).toContain(`## 前回の評価（${first.id}）`);
    expect(carryover(second.id)).toContain("CLI だけでよい");
  });

  it("渡し済みのメモは次から除き、実行の後に足したメモは次回に渡す", async () => {
    const { ctx, req, preflight } = await setup();
    const n1 = await ctx.ws.notes.add(req.id, "一つ目");
    const r1 = await preflight();
    const r2 = await preflight();
    expect(r1.notes).toEqual([n1.id]);
    expect(r2.notes).toBeUndefined(); // 渡し済み
    const n2 = await ctx.ws.notes.add(req.id, "二つ目");
    const r3 = await preflight();
    expect(r3).toMatchObject({ previous: r2.id, notes: [n2.id] });
  });

  it("前回のタスク案は人の編集と採否を含めて渡し、後から直しても固定した内容は変わらない", async () => {
    const { ctx, req, preflight, carryover } = await setup();
    const r1 = await preflight();
    await ctx.preflight.updateDraft(req.id, r1.id, "D1", { title: "人が直した題", include: false });
    const r2 = await preflight();
    expect(carryover(r2.id)).toContain("### D1 人が直した題（不採用）");
    await ctx.preflight.updateDraft(req.id, r1.id, "D1", { title: "さらに直した" });
    expect(carryover(r2.id)).toContain("人が直した題");
  });

  it("直近が失敗なら古い成功 run に戻らず前回なし。失敗に渡しただけのメモは渡し済みにしない", async () => {
    const { ctx, req, preflight, carryover } = await setup();
    const n1 = await ctx.ws.notes.add(req.id, "一つ目");
    const ok = await preflight();
    const n2 = await ctx.ws.notes.add(req.id, "二つ目");
    const failed = await preflight("codex");
    expect(failed).toMatchObject({ status: "failed", previous: ok.id, notes: [n2.id] });

    const retry = await preflight();
    expect(retry.previous).toBeUndefined();
    expect(retry.notes).toEqual([n1.id, n2.id]); // 前回なしなら全部
    expect(carryover(retry.id)).toContain(`引き継ぎません（直近の ${failed.id} が失敗のため）`);
    expect(retry.log.map((l) => l.text)).toContainEqual(expect.stringContaining("引き継ぎません"));

    // 成功した retry を引き継ぐ次の run では、retry に渡したメモは渡し済み
    expect((await preflight()).notes).toBeUndefined();
  });

  it("Mock でもメモの箇条書きを案に足し、前回不採用の案は不採用のまま、確認事項は答えられたものとする", async () => {
    const { ctx, req, preflight } = await setup();
    const r1 = await preflight();
    expect(r1.assessment?.verdict).toBe("clarify"); // 本文が短い
    await ctx.preflight.updateDraft(req.id, r1.id, "D1", { include: false });
    await ctx.ws.notes.add(req.id, "回答です。\n- CSV も出す");
    const r2 = await preflight();
    expect(r2.drafts.map((d) => [d.title, d.include])).toEqual([
      ["作る", false],
      ["CSV も出す", true],
    ]);
    expect(r2.assessment).toMatchObject({ verdict: "go", questions: [] });
    expect(r2.assessment?.summary).toContain(`前回 ${r1.id} を引き継ぎ、メモ 1 件を反映しました`);
  });

  it("前回の記録が無い・古い形式の run.json でも動く", async () => {
    const { ctx, req, preflight } = await setup();
    const r1 = await preflight();
    // 引き継ぎの項目が無い古い run.json
    const file = join(ctx.ws.preflight.runDir(req.id, r1.id), "run.json");
    const { startedBy, previous, notes, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old));
    const n = await ctx.ws.notes.add(req.id, "メモ");
    expect(await preflight()).toMatchObject({ status: "completed", previous: r1.id, notes: [n.id] });
  });
});
