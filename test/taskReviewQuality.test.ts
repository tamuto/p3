// タスクのレビューの品質: 取り込んだ版と最新の品質基準を材料に固定して差を示す、観点を替えても品質の比較は残る、hash の変化、
// 基準ごとの判定の網羅・重複・根拠・対象外の理由、未設定・読めない設定は評価しない、古い記録は品質を評価していない、
// タスクの状態・済み・証拠は変えない（偽の app-server）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import { updateQuality } from "../src/core/quality.ts";
import { createTask, updateTask } from "../src/core/requestOps.ts";
import { extractTaskReview } from "../src/core/taskReview/material.ts";
import { InvalidTaskReview, parseTaskReview, taskReviewPrompt } from "../src/core/taskReview/review.ts";
import { TaskReviewService } from "../src/core/taskReview/service.ts";
import { git, makeProject, newRequest, tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-task-reviewer.mjs", import.meta.url));
const codex = (scenario: string) =>
  new CodexWorkspaceEngine({
    authVolume: "vol",
    account: chatgptAccount(join(tempDir(), "chatgpt.json")),
    pathMap: [],
    ensureImage: false,
    command: () => ["env", `FAKE_LOG=${join(tempDir(), "c.log")}`, `FAKE_SCENARIO=${scenario}`, process.execPath, FAKE],
  });

async function setup(opts: { quality?: boolean } = { quality: true }) {
  const p = await makeProject();
  const put = (path: string, c: string) => (mkdirSync(join(p.root, path, ".."), { recursive: true }), writeFileSync(join(p.root, path), c), git(p.root, "add", path));
  put(".gitignore", ".p3/\n");
  put("src/a.ts", "a1\n");
  git(p.root, "commit", "-q", "-m", "最初");
  put("src/a.ts", "a2\n");
  git(p.root, "commit", "-q", "-m", "変更");
  const sha = git(p.root, "rev-parse", "HEAD");
  if (opts.quality) {
    await updateQuality(p.ctx.ws, [
      { op: "add", standard: { text: "lint が通る", check: { kind: "machine", command: "pnpm lint", success: "0" } } },
      { op: "add", standard: { text: "文書を直す", check: { kind: "manual", reference: "r" } } },
      { op: "add", standard: { text: "除外", check: { kind: "manual", reference: "r" } } },
      { op: "exempt", id: "Q3", reason: "対象外" },
    ]);
  }
  const req = await newRequest(p.ctx, { title: "要望" });
  const { task } = await createTask(p.ctx, req.id, { title: "送る", repo: "main", criteria: ["送れる"] });
  await updateTask(p.ctx, req.id, task.id, { status: "done", outputs: [sha] });
  return { ...p, rid: req.id, tid: task.id, sha };
}

describe("材料", () => {
  it("取り込んだ版と最新の品質基準を固定し、差を示す。観点を替えても品質の比較は残り、品質基準が変われば hash が変わる", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const extract = (viewpoint?: string) => extractTaskReview(dataDir, rid, tid, ctx.ws.refs(), { viewpoint });
    const a = (await extract()).input;
    expect(a.quality).toMatchObject({ latest: { state: "set" }, applies: [{ id: "Q1" }, { id: "Q2" }], exempt: [{ id: "Q3" }], imported: [{ quality: "Q1" }, { quality: "Q2" }], diff: [] });
    await updateQuality(ctx.ws, [{ op: "edit", id: "Q1", standard: { check: { kind: "machine", command: "pnpm lint --max-warnings 0", success: "0" } } }]);
    const b = (await extract()).input;
    expect(b.hash).not.toBe(a.hash);
    expect(b.quality!.diff).toEqual([expect.objectContaining({ kind: "change", quality: "Q1" })]);
    expect(b.notes.some((n) => n.code === "quality_changed")).toBe(true);
    writeFileSync(join(ctx.ws.dataDir, "project.yaml"), `${readFileSync(join(ctx.ws.dataDir, "project.yaml"), "utf8")}taskReview:\n  viewpoints: 別の観点\n`);
    const c = (await extract("project")).input;
    expect(c.quality!.applies.map((q) => q.id)).toEqual(["Q1", "Q2"]);
    expect(taskReviewPrompt(c).instructions).toContain("品質（quality）");
  });

  it("未設定は注意に残し、品質は判定させない", async () => {
    const { ctx, rid, tid, dataDir } = await setup({ quality: false });
    const { input } = await extractTaskReview(dataDir, rid, tid, ctx.ws.refs());
    expect(input.quality!.latest.state).toBe("unset");
    expect(input.notes.some((n) => n.code === "quality_unset")).toBe(true);
    expect(taskReviewPrompt(input).instructions).not.toContain("品質（quality）");
  });
});

describe("結果の確かめ", () => {
  it("基準ごとにちょうど1回・区分・対象外の理由・満たす／違反のコードの根拠。古い材料は品質を評価していない", async () => {
    const { ctx, rid, tid, dataDir, sha } = await setup();
    const { input } = await extractTaskReview(dataDir, rid, tid, ctx.ws.refs());
    const code = `main@${sha}:src/a.ts`;
    const base = { overall: "o", items: [{ item: "A1", verdict: "missing", reason: "r", evidence: [], gaps: [] }, { item: "A2", verdict: "missing", reason: "r", evidence: [], gaps: [] }, { item: "A3", verdict: "missing", reason: "r", evidence: [], gaps: [] }], unplanned: [], checks: [], coverage: { read: "r", unread: "" } };
    const msg = (quality: unknown) => JSON.stringify({ ...base, quality });
    const ok = parseTaskReview(msg([{ standard: "Q2", verdict: "not_applicable", reason: "文書の変更が無い", evidence: [] }, { standard: "Q1", verdict: "violated", reason: "lint を消した", evidence: [code] }]), input);
    expect(ok.quality!.map((q) => q.standard)).toEqual(["Q1", "Q2"]);
    const bad: [string, unknown][] = [
      ["無い", undefined],
      ["欠落", [{ standard: "Q1", verdict: "undetermined", reason: "r", evidence: [] }]],
      ["重複", [{ standard: "Q1", verdict: "undetermined", reason: "r" }, { standard: "Q1", verdict: "undetermined", reason: "r" }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
      ["除外した基準", [{ standard: "Q1", verdict: "undetermined", reason: "r" }, { standard: "Q2", verdict: "undetermined", reason: "r" }, { standard: "Q3", verdict: "undetermined", reason: "r" }]],
      ["理由の無い対象外", [{ standard: "Q1", verdict: "not_applicable", reason: "" }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
      ["根拠の無い違反", [{ standard: "Q1", verdict: "violated", reason: "r", evidence: [] }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
      ["区分", [{ standard: "Q1", verdict: "ok", reason: "r" }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
    ];
    for (const [name, q] of bad) expect(() => parseTaskReview(msg(q), input), name).toThrow(InvalidTaskReview);
    // 古い材料（品質の材料が無い）: 品質は無視して評価していない
    const { quality: _q, ...old } = input;
    expect(parseTaskReview(msg(undefined), old).quality).toBeUndefined();
  });
});

describe("実行（偽の app-server）", () => {
  it("品質の違反を記録し、タスクの状態・済み・証拠は変えない。品質の判定の欠落・根拠の無い違反は失敗にする", async () => {
    const { ctx, rid, tid, dataDir } = await setup();
    const file = join(dataDir, "requests", rid, "tasks", `${tid}.md`);
    const before = readFileSync(file, "utf8");
    ctx.taskReview = new TaskReviewService(ctx.ws, { codex: codex("ok") }, { pollMs: 20 });
    const r = await ctx.taskReview.start(rid, tid);
    const d = await ctx.taskReview.wait(rid, tid, r.id);
    expect(d.run.status).toBe("completed");
    expect(d.result!.quality).toEqual([expect.objectContaining({ standard: "Q1", verdict: "violated" }), expect.objectContaining({ standard: "Q2", verdict: "undetermined", unread: "全体の設定" })]);
    expect(readFileSync(file, "utf8")).toBe(before);
    for (const scenario of ["qmissing", "qnoevidence"]) {
      const s = new TaskReviewService(ctx.ws, { codex: codex(scenario) }, { pollMs: 20 });
      const x = await s.start(rid, tid);
      expect((await s.wait(rid, tid, x.id)).run, scenario).toMatchObject({ status: "failed", failure: "invalid_output" });
    }
  });
});
