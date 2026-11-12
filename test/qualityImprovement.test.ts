// 品質の不足から改善要望を明示して登録する（core/qualityImprovement.ts）: 未設定・読めない・違反・判断できない・除外の区別、
// 診断と原稿は何も書かない、登録の直前の診断の版の照合、不足ごとの登録先（run が違っても同じ不足は増えない）、開いている登録先の案内、
// 閉じた要望からの作り直しは明示、並行の登録・途中で落ちた予約からの回復、CLI と API。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { updateQuality } from "../src/core/quality.ts";
import { diagnoseQuality, ImprovementError, improvementDraft, registerImprovement, tokenTag } from "../src/core/qualityImprovement.ts";
import { createRequest, updateRequest } from "../src/core/requestOps.ts";
import { newTaskReviewRunId } from "../src/core/taskReview/store.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { TaskReviewInput, TaskReviewResult } from "../src/shared/taskReview.ts";
import { makeProject, newRequest, tempDir } from "./helpers.ts";

const source = { type: "project" } as const;

/** 品質の判定を持つタスクのレビューの記録を置く（実行はしない） */
async function seedReview(ctx: Awaited<ReturnType<typeof makeProject>>["ctx"], rid: string, quality: TaskReviewResult["quality"]) {
  const store = ctx.ws.taskReviews;
  const run = newTaskReviewRunId(new Date(Date.now() + Math.floor(Math.random() * 100000)));
  const latest = { state: "set" as const, version: ctx.ws.project.qualityVersion ?? "", standards: (ctx.ws.project.quality?.state === "set" ? ctx.ws.project.quality.config.standards : []) };
  const input = {
    version: 1,
    request: { id: rid, title: "t", status: "active", body: "" },
    task: { id: "T001", ref: `${rid}/T001`, title: "t", status: "done", body: "", outputs: [] },
    items: [],
    targets: [],
    viewpoint: { source: "builtin", text: "", hash: "v" },
    notes: [],
    files: [],
    extractedAt: new Date().toISOString(),
    hash: "h",
    quality: { latest, applies: latest.standards.filter((s) => !s.exempt), exempt: latest.standards.filter((s) => s.exempt), imported: [], diff: [] },
  } as unknown as TaskReviewInput;
  await store.create(input, new Map(), { id: run, request: rid, task: "T001", status: "running", engine: "mock", startedAt: new Date().toISOString(), inputHash: "h", log: [] });
  await store.finish(`${rid}/T001`, run, { status: "completed" }, { overall: "o", items: [], unplanned: [], checks: [], coverage: { read: "", unread: "" }, quality });
  return run;
}

async function setup() {
  const p = await makeProject();
  await updateQuality(p.ctx.ws, [
    { op: "add", standard: { text: "lint が通る", check: { kind: "machine", command: "pnpm lint", success: "0" } } },
    { op: "add", standard: { text: "文書を直す", check: { kind: "manual", reference: "r" } } },
    { op: "add", standard: { text: "除外", check: { kind: "manual", reference: "r" } } },
    { op: "exempt", id: "Q3", reason: "対象外" },
  ]);
  const req = await newRequest(p.ctx, { title: "要望" });
  return { ...p, rid: req.id };
}

const q = (standard: string, verdict: "violated" | "undetermined" | "satisfied") => ({ standard, verdict, reason: verdict === "violated" ? "lint の設定を消した" : "材料に無い", evidence: verdict === "violated" ? ["main@abc1234"] : [] });

describe("診断と原稿", () => {
  it("未設定・読めない・違反・判断できない・除外を区別する。除外は既定で選ばず、判断できないを未導入と書かない。何も書かない", async () => {
    const { ctx, dataDir } = await makeProject();
    const before = ctx.ws.requests.list().length;
    const unset = await diagnoseQuality(ctx, source);
    expect(unset.findings).toEqual([expect.objectContaining({ key: "quality:unset", kind: "unset", suggested: true })]);
    expect(improvementDraft(unset, ["quality:unset"]).title).toBe("プロジェクトの品質基準を決める");
    writeFileSync(join(dataDir, "project.yaml"), `${readFileSync(join(dataDir, "project.yaml"), "utf8")}quality: 壊れた\n`);
    await ctx.ws.reloadAll();
    expect((await diagnoseQuality(ctx, source)).findings[0].kind).toBe("invalid");
    expect(existsSync(join(dataDir, "quality-improvements.json"))).toBe(false);
    expect(ctx.ws.requests.list()).toHaveLength(before);

    const s = await setup();
    const run = await seedReview(s.ctx, s.rid, [q("Q1", "violated"), q("Q2", "undetermined")]);
    const d = await diagnoseQuality(s.ctx, { type: "task-review", request: s.rid, task: "T001", run });
    expect(d.findings.map((f) => [f.key, f.kind, f.suggested])).toEqual([
      [`Q1:task:${s.rid}/T001:violated`, "violated", true],
      [`Q2:task:${s.rid}/T001:undetermined`, "undetermined", false],
      [`Q3:task:${s.rid}/T001:exempt`, "exempt", false],
    ]);
    const draft = improvementDraft(d, [d.findings[0].key, d.findings[1].key]);
    expect(draft.body).toContain(`タスクのレビュー ${s.rid}/T001 の ${run}`);
    expect(draft.body).toContain("main@abc1234");
    expect(draft.body).toContain("判断できないは未導入という意味ではありません");
    expect(draft.body).not.toContain("未導入です");
  });
});

describe("登録", () => {
  it("診断の版が違えば作らない。登録先を残し、run が違っても同じ不足は案内する。閉じた要望からの作り直しは明示", async () => {
    const { ctx, rid } = await setup();
    const run1 = await seedReview(ctx, rid, [q("Q1", "violated"), q("Q2", "satisfied")]);
    const src1 = { type: "task-review" as const, request: rid, task: "T001", run: run1 };
    const d1 = await diagnoseQuality(ctx, src1);
    const key = d1.findings[0].key;
    const draft = improvementDraft(d1, [key]);
    await expect(registerImprovement(ctx, { source: src1, keys: [key], ...draft, hash: "違う" })).rejects.toMatchObject({ code: "diagnosis_changed" });
    const r = await registerImprovement(ctx, { source: src1, keys: [key], ...draft, hash: d1.hash }, "human:a");
    expect(r.request).toMatchObject({ title: draft.title, status: "draft", tags: [expect.stringMatching(/^quality-improvement:/)] });
    const ledger = JSON.parse(readFileSync(join(ctx.ws.dataDir, "quality-improvements.json"), "utf8")) as { entries: Record<string, { request: string }> };
    expect(ledger.entries[key].request).toBe(r.request.id);
    // 別の run の同じ不足
    const run2 = await seedReview(ctx, rid, [q("Q1", "violated"), q("Q2", "satisfied")]);
    const src2 = { ...src1, run: run2 };
    const d2 = await diagnoseQuality(ctx, src2);
    expect(d2.registered[key].request).toBe(r.request.id);
    await expect(registerImprovement(ctx, { source: src2, keys: [key], ...draft, hash: d2.hash })).rejects.toMatchObject({ code: "existing", existing: { request: r.request.id } });
    // 閉じたら、作り直しは明示
    await updateRequest(ctx, r.request.id, { status: "rejected" });
    await expect(registerImprovement(ctx, { source: src2, keys: [key], ...draft, hash: d2.hash })).rejects.toMatchObject({ code: "closed_existing" });
    const again = await registerImprovement(ctx, { source: src2, keys: [key], ...draft, hash: d2.hash, reopenClosed: true });
    expect(again.request.id).not.toBe(r.request.id);
    await expect(registerImprovement(ctx, { source: src2, keys: ["Q9:x:violated"], ...draft, hash: d2.hash })).rejects.toBeInstanceOf(ImprovementError);
  });

  it("並行の登録は1件だけ作る。途中で落ちた予約は、タグの付いた要望を見つけて台帳を直す（重複も孤立も残さない）", async () => {
    const { ctx, dataDir } = await makeProject();
    const d = await diagnoseQuality(ctx, source);
    const draft = improvementDraft(d, ["quality:unset"]);
    const all = await Promise.allSettled([1, 2, 3].map(() => registerImprovement(ctx, { source, keys: ["quality:unset"], ...draft, hash: d.hash })));
    expect(all.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(ctx.ws.requests.list().filter((r) => r.tags.some((t) => t.startsWith("quality-improvement:")))).toHaveLength(1);

    // 予約を書いて要望を作った後、登録先を書く前に落ちた
    const p2 = await makeProject();
    const token = "abc123abc123";
    const made = await createRequest(p2.ctx, { title: "途中で作った", body: "", tags: [tokenTag(token)] });
    writeFileSync(join(p2.dataDir, "quality-improvements.json"), JSON.stringify({ version: 1, entries: { "quality:unset": { token, reservedAt: new Date().toISOString(), source } } }));
    const d2 = await diagnoseQuality(p2.ctx, source);
    await expect(registerImprovement(p2.ctx, { source, keys: ["quality:unset"], ...draft, hash: d2.hash })).rejects.toMatchObject({ code: "existing", existing: { request: made.id } });
    // 予約だけ書いて落ちた（要望は無い）: やり直すと1件作る
    const p3 = await makeProject();
    writeFileSync(join(p3.dataDir, "quality-improvements.json"), JSON.stringify({ version: 1, entries: { "quality:unset": { token, reservedAt: new Date().toISOString(), source } } }));
    const d3 = await diagnoseQuality(p3.ctx, source);
    const r3 = await registerImprovement(p3.ctx, { source, keys: ["quality:unset"], ...draft, hash: d3.hash });
    expect(p3.ctx.ws.requests.list().filter((r) => r.title === draft.title).map((r) => r.id)).toEqual([r3.request.id]);
    expect(dataDir).toBeTruthy();
  });
});

describe("CLI と API", () => {
  it("CLI は原稿を出すだけで、--register --hash で作る。API も同じ。登録先があれば 3 / 409", async () => {
    const a = await makeProject();
    const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "human:test" };
    const p3 = (args: string[]) => {
      const r = spawnSync(process.execPath, [BIN, "--dir", a.dataDir, ...args], { encoding: "utf8", env });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const shown = JSON.parse(p3(["quality", "improve", "--json"]).out) as { hash: string; draft: { title: string } };
    expect(shown.draft.title).toBe("プロジェクトの品質基準を決める");
    expect(p3(["request", "ls", "--json"]).out.trim()).toBe("[]");
    expect(p3(["quality", "improve", "--register"]).code).toBe(1);
    const made = p3(["quality", "improve", "--register", "--hash", shown.hash, "--title", "品質基準を決めて書く"]);
    expect(made.code, made.err).toBe(0);
    expect(made.out).toContain("要望を登録しました");
    expect(p3(["quality", "improve", "--register", "--hash", shown.hash]).code).toBe(3);

    const b = await makeProject();
    const app = apiRoutes(b.ctx);
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const pv = await post("/quality/improvements/preview", { source });
    expect(pv.body).toMatchObject({ picked: ["quality:unset"], draft: { title: "プロジェクトの品質基準を決める" } });
    const reg = await post("/quality/improvements", { source, keys: ["quality:unset"], title: "決める", body: "b", hash: pv.body.hash });
    expect(reg.status).toBe(201);
    expect((await post("/quality/improvements", { source, keys: ["quality:unset"], title: "決める", body: "b", hash: pv.body.hash })).body).toMatchObject({ code: "existing" });
    expect((await post("/quality/improvements", { source, keys: ["quality:unset"], title: "決める", body: "b", hash: "x" })).body).toMatchObject({ code: "diagnosis_changed" });
  });
});
