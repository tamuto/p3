// マイルストーンレビューの品質: 品質基準を版つきで材料に固定し hash に入れる、未設定・読めないは警告で品質は評価しない、
// 基準ごとの判定の網羅と根拠、品質の低下は履歴のコミットで裏付けたときだけ、始める前の確かめ（material_changed）、
// 実行中の材料の変化の記録、古い記録は品質を評価していない、目的の判定と別に出る（偽の app-server と偽の頼む先）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import { extractReviewInput } from "../src/core/milestoneReview/material.ts";
import { InvalidReview, parseReview, reviewPrompt } from "../src/core/milestoneReview/review.ts";
import { MilestoneReviewService } from "../src/core/milestoneReview/service.ts";
import { updateQuality } from "../src/core/quality.ts";
import type { Summarizer } from "../src/core/releaseNotes/generate.ts";
import { git, makeRepo, newRequest, newTask, openTestProject, tempDir } from "./helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-reviewer.mjs", import.meta.url));
const codex = (scenario: string) =>
  new CodexWorkspaceEngine({
    authVolume: "vol",
    account: chatgptAccount(join(tempDir(), "chatgpt.json")),
    pathMap: [],
    ensureImage: false,
    command: () => ["env", `FAKE_LOG=${join(tempDir(), "c.log")}`, `FAKE_SCENARIO=${scenario}`, process.execPath, FAKE],
  });

async function setup(reviewer?: Summarizer, quality = true) {
  const repo = await makeRepo({ milestones: [{ id: "v1", title: "最初", purpose: "在庫の確認を速くする", goals: [{ id: "G1", text: "在庫の一覧" }] }] });
  mkdirSync(join(repo.root, "src"), { recursive: true });
  writeFileSync(join(repo.root, "src", "stock.ts"), "export const list = () => [];\n");
  git(repo.root, "add", "src");
  git(repo.root, "commit", "-q", "-m", "在庫の一覧");
  const sha = git(repo.root, "rev-parse", "HEAD");
  const ctx = await openTestProject(repo.dataDir);
  if (quality) {
    await updateQuality(ctx.ws, [
      { op: "add", standard: { text: "lint が通る", check: { kind: "machine", command: "pnpm lint", success: "0" } } },
      { op: "add", standard: { text: "文書を直す", check: { kind: "manual", reference: "r" } } },
      { op: "add", standard: { text: "除外", check: { kind: "manual", reference: "r" } } },
      { op: "exempt", id: "Q3", reason: "対象外" },
    ]);
  }
  ctx.milestoneReview = new MilestoneReviewService(ctx.ws, { codex: reviewer }, { pollMs: 20 });
  const a = await newRequest(ctx, { title: "一覧", body: "在庫を一覧で見たい", milestone: "v1", status: "resolved" });
  await newTask(ctx, a.id, { title: "一覧画面", status: "done", record: "一覧を足した", outputs: [`https://github.com/o/r/commit/${sha}`] });
  return { ...repo, ctx, sha };
}

describe("材料と結果の確かめ", () => {
  it("品質基準を版つきで固定し hash に入れる。未設定は警告で品質は判定させない", async () => {
    const { ctx, dataDir } = await setup();
    const a = await extractReviewInput(dataDir, "v1", ctx.ws.refs());
    expect(a.quality).toMatchObject({ state: "set", standards: [{ id: "Q1" }, { id: "Q2" }, { id: "Q3", exempt: { reason: "対象外" } }] });
    expect(reviewPrompt(a).instructions).toContain("品質（quality）");
    await updateQuality(ctx.ws, [{ op: "edit", id: "Q2", standard: { text: "文書を同じ変更で直す" } }]);
    expect((await extractReviewInput(dataDir, "v1", ctx.ws.refs())).hash).not.toBe(a.hash);
    const none = await setup(undefined, false);
    const n = await extractReviewInput(none.dataDir, "v1", none.ctx.ws.refs());
    expect(n.warnings.map((w) => w.code)).toContain("quality_unset");
    expect(reviewPrompt(n).instructions).not.toContain("品質（quality）");
  });

  it("基準ごとにちょうど1回・根拠・品質の低下はコミットで裏付けたときだけ。古い材料は品質を評価していない", async () => {
    const { ctx, dataDir, sha } = await setup();
    const input = await extractReviewInput(dataDir, "v1", ctx.ws.refs());
    const locals = { main: ctx.ws.refs()[0].local! };
    const msg = (quality: unknown) => JSON.stringify({ overall: "o", units: [{ unit: "G1", verdict: "insufficient", reason: "r", evidence: [], gaps: [] }], unplanned: [], quality });
    const ok = parseReview(msg([{ standard: "Q2", verdict: "not_applicable", reason: "文書の変更なし", evidence: [] }, { standard: "Q1", verdict: "violated", reason: "消した", evidence: [`main@${sha}`], regression: true }]), input, undefined, locals);
    expect(ok.quality).toEqual([expect.objectContaining({ standard: "Q1", regression: true }), expect.objectContaining({ standard: "Q2" })]);
    const bad: [string, unknown][] = [
      ["無い", undefined],
      ["欠落", [{ standard: "Q1", verdict: "undetermined", reason: "r" }]],
      ["除外した基準", [{ standard: "Q1", verdict: "undetermined", reason: "r" }, { standard: "Q2", verdict: "undetermined", reason: "r" }, { standard: "Q3", verdict: "undetermined", reason: "r" }]],
      ["コミットの無い低下", [{ standard: "Q1", verdict: "violated", reason: "r", evidence: ["main:src/stock.ts"], regression: true }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
      ["根拠の無い違反", [{ standard: "Q1", verdict: "violated", reason: "r", evidence: [] }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
      ["理由の無い対象外", [{ standard: "Q1", verdict: "not_applicable", reason: "" }, { standard: "Q2", verdict: "undetermined", reason: "r" }]],
    ];
    for (const [name, q] of bad) expect(() => parseReview(msg(q), input, undefined, locals), name).toThrow(InvalidReview);
    const { quality: _q, ...old } = input;
    expect(parseReview(msg(undefined), old, undefined, locals).quality).toBeUndefined();
  });
});

describe("実行", () => {
  it("偽の app-server: 目的の判定と別に品質の違反・低下を記録する。低下の根拠が無い・判定の欠落は失敗にする", async () => {
    const one = await setup(codex("qregression"));
    const r = await one.ctx.milestoneReview.start("v1");
    const d = await one.ctx.milestoneReview.wait("v1", r.id);
    expect(d.run.status).toBe("completed");
    expect(d.result!.units).toHaveLength(1);
    expect(d.result!.quality).toEqual([expect.objectContaining({ standard: "Q1", verdict: "violated", regression: true }), expect.objectContaining({ standard: "Q2", verdict: "undetermined" })]);
    for (const scenario of ["qbadregression", "qmissing"]) {
      const s = await setup(codex(scenario));
      const x = await s.ctx.milestoneReview.start("v1");
      expect((await s.ctx.milestoneReview.wait("v1", x.id)).run, scenario).toMatchObject({ status: "failed", failure: "invalid_output" });
    }
  });

  it("確かめた後で品質基準が変われば始めない（material_changed）。実行中に変われば記録に残す", async () => {
    let change: (() => Promise<void>) | undefined;
    const reviewer: Summarizer = {
      async ask(input) {
        await change?.();
        const units = (JSON.parse(/<material>\n([\s\S]*?)\n<\/material>/.exec(input.prompt)![1]) as { units: { id: string }[]; quality?: { standards: { id: string }[] } });
        return { message: JSON.stringify({ overall: "o", units: units.units.map((u) => ({ unit: u.id, verdict: "insufficient", reason: "r", evidence: [], gaps: [] })), unplanned: [], quality: (units.quality?.standards ?? []).map((q) => ({ standard: q.id, verdict: "undetermined", reason: "r", evidence: [] })) }), seconds: 0 };
      },
    };
    const { ctx, dataDir } = await setup(reviewer);
    const before = await extractReviewInput(dataDir, "v1", ctx.ws.refs());
    await updateQuality(ctx.ws, [{ op: "edit", id: "Q1", standard: { text: "lint が警告なしで通る" } }]);
    await expect(ctx.milestoneReview.start("v1", undefined, undefined, { expectedHash: before.hash })).rejects.toMatchObject({ code: "material_changed" });
    change = () => updateQuality(ctx.ws, [{ op: "edit", id: "Q2", standard: { text: "文書を同じ変更で直す" } }]).then(() => undefined);
    const r = await ctx.milestoneReview.start("v1");
    const d = await ctx.milestoneReview.wait("v1", r.id);
    expect(d.run).toMatchObject({ status: "completed", inputChanged: true });
    expect(readFileSync(join(dataDir, "project.yaml"), "utf8")).toContain("文書を同じ変更で直す");
  });
});
