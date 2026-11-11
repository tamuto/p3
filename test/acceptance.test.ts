import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcceptanceInputError, acceptanceStatus, applyAcceptanceOps, parseEvidenceArg, parseEvidenceFile, type AcceptanceState } from "../src/shared/acceptance.ts";
import { CHECK_CLEARED_BY_ACCEPTANCE, createTask, updateTask } from "../src/core/requestOps.ts";
import { checkStatusChange } from "../src/core/requestStatus.ts";
import { ConflictError } from "../src/core/store/collection.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import { makeProject, newRequest, newTask, tempDir } from "./helpers.ts";

/**
 * タスクの受け入れ基準と項目ごとの証拠（shared/acceptance.ts・core/requestOps.ts）。ID の安定・文言を変えた後の失効・消した基準の証拠・
 * 壊れた直接編集・済みの解除・完了を拒まないこと・CLI と API の同等性を確かめる
 */

const at = { now: "2026-11-11T00:00:00.000Z", actor: "ai:test" };

describe("基準と証拠の規則（shared）", () => {
  it("ID は A1, A2, ... を振り、並べ替え・文言の変更で変えず、消した ID を使い直さない", () => {
    let s: AcceptanceState = applyAcceptanceOps({}, [{ op: "add", text: "一" }, { op: "add", text: "二" }, { op: "add", text: "三" }], at);
    expect(s.acceptanceCriteria).toEqual([{ id: "A1", text: "一" }, { id: "A2", text: "二" }, { id: "A3", text: "三" }]);
    s = applyAcceptanceOps(s, [{ op: "order", ids: ["A3", "A1", "A2"] }, { op: "edit", id: "A1", text: "いち" }, { op: "remove", id: "A3" }], at);
    expect(s.acceptanceCriteria).toEqual([{ id: "A1", text: "いち" }, { id: "A2", text: "二" }]);
    s = applyAcceptanceOps(s, [{ op: "add", text: "四" }], at);
    expect(s.acceptanceCriteria!.map((c) => c.id)).toEqual(["A1", "A2", "A4"]);
    expect(s.acceptanceSeq).toBe(4);
    // 全部消しても番号は戻らない
    s = applyAcceptanceOps(s, ["A1", "A2", "A4"].map((id) => ({ op: "remove" as const, id })), at);
    expect(s.acceptanceCriteria).toBeUndefined();
    expect(applyAcceptanceOps(s, [{ op: "add", text: "五" }], at).acceptanceCriteria).toEqual([{ id: "A5", text: "五" }]);
  });

  it("規則に合わない操作は1件も当てずに断る", () => {
    const s = applyAcceptanceOps({}, [{ op: "add", text: "一" }], at);
    const bad: [string, Parameters<typeof applyAcceptanceOps>[1]][] = [
      ["空の文", [{ op: "add", text: "  " }]],
      ["無い ID", [{ op: "edit", id: "A9", text: "x" }]],
      ["並べ替えの不足", [{ op: "order", ids: [] }]],
      ["並べ替えの重複", [{ op: "order", ids: ["A1", "A1"] }]],
      ["証拠の無い met", [{ op: "record", id: "A1", result: "met", evidence: " " }]],
      ["不正な結果", [{ op: "record", id: "A1", result: "ok" as never, evidence: "x" }]],
      ["無い証拠を消す", [{ op: "unrecord", id: "A1" }]],
      ["途中で失敗", [{ op: "add", text: "二" }, { op: "remove", id: "A7" }]],
    ];
    for (const [name, ops] of bad) expect(() => applyAcceptanceOps(s, ops, at), name).toThrow(AcceptanceInputError);
    // 満たせなかった・未検証は本文を省ける
    expect(applyAcceptanceOps(s, [{ op: "record", id: "A1", result: "unverified", evidence: "" }], at).acceptanceEvidence).toHaveLength(1);
  });

  it("文言を変えた基準の証拠は再確認が必要、消した基準の証拠は対応する基準のない証拠として残る。同じ値の再記録は元のまま", () => {
    let s = applyAcceptanceOps({}, [{ op: "add", text: "一" }, { op: "add", text: "二" }, { op: "add", text: "三" }], at);
    s = applyAcceptanceOps(s, [{ op: "record", id: "A1", result: "met", evidence: "テスト A" }, { op: "record", id: "A2", result: "met", evidence: "テスト B" }, { op: "record", id: "A3", result: "unmet", evidence: "理由" }], at);
    const again = applyAcceptanceOps(s, [{ op: "record", id: "A1", result: "met", evidence: "テスト A" }], { now: "2030-01-01T00:00:00.000Z" });
    expect(again.acceptanceEvidence![0].recordedAt).toBe(at.now);
    s = applyAcceptanceOps(s, [{ op: "edit", id: "A2", text: "二（変更）" }, { op: "remove", id: "A3" }], at);
    const st = acceptanceStatus(s)!;
    expect(st.total).toBe(2);
    expect(st.met).toBe(1);
    expect(st.items.map((i) => [i.id, i.state])).toEqual([["A1", "met"], ["A2", "stale"]]);
    expect(st.orphans.map((e) => e.criterionId)).toEqual(["A3"]);
    expect(st.shortfalls).toEqual(["基準を変えた後の再確認が必要: A2", "対応する基準のない証拠: A3"]);
    // 再記録で今の文言に置き換わる
    s = applyAcceptanceOps(s, [{ op: "record", id: "A2", result: "met", evidence: "テスト B2" }], at);
    expect(acceptanceStatus(s)!.met).toBe(2);
    expect(acceptanceStatus({})).toBeUndefined();
  });

  it("証拠の入力（--evidence と Markdown のファイル）", () => {
    expect(parseEvidenceArg("A1=met:pnpm check で通過")).toEqual({ op: "record", id: "A1", result: "met", evidence: "pnpm check で通過" });
    expect(parseEvidenceArg("A2=unverified")).toEqual({ op: "record", id: "A2", result: "unverified", evidence: "" });
    expect(() => parseEvidenceArg("A1=done:x")).toThrow(AcceptanceInputError);
    const ops = parseEvidenceFile("\n## A1 met\n- `pnpm -s check` 775 件\n- test/a.test.ts\n\n## A2: unmet\n時間切れ\n");
    expect(ops).toEqual([
      { op: "record", id: "A1", result: "met", evidence: "- `pnpm -s check` 775 件\n- test/a.test.ts" },
      { op: "record", id: "A2", result: "unmet", evidence: "時間切れ" },
    ]);
    expect(() => parseEvidenceFile("前置き\n## A1 met\nx")).toThrow(AcceptanceInputError);
    expect(() => parseEvidenceFile("## A1 met\nx\n## A1 unmet\ny")).toThrow(AcceptanceInputError);
    expect(() => parseEvidenceFile("## A1 passed\nx")).toThrow(AcceptanceInputError);
  });
});

async function setup() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "要望" });
  const file = (tid: string) => join(p.dataDir, "requests", req.id, "tasks", `${tid}.md`);
  return { ...p, rid: req.id, file };
}

describe("保存と更新（core）", () => {
  it("作るときに基準を付け、操作で証拠を残して読み直せる。基準のない古いタスクはそのまま読み書きできる", async () => {
    const { ctx, rid, file } = await setup();
    const old = await newTask(ctx, rid, { title: "古い" });
    const r = await createTask(ctx, rid, { title: "新しい", criteria: ["一覧に出る", "  画面で直せる  "] }, "ai:test");
    expect(r.task.acceptanceCriteria).toEqual([{ id: "A1", text: "一覧に出る" }, { id: "A2", text: "画面で直せる" }]);
    await updateTask(ctx, rid, r.task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "test/x.test.ts" }] }, { actor: "ai:test" });
    await ctx.ws.reloadAll();
    const back = ctx.ws.tasksOf(rid).require(r.task.id);
    expect(back.acceptanceEvidence).toEqual([expect.objectContaining({ criterionId: "A1", criterionText: "一覧に出る", result: "met", evidence: "test/x.test.ts", recordedBy: "ai:test" })]);
    expect(back.acceptanceSeq).toBe(2);
    // 古いタスク: 項目は増えず、無関係な更新でも書かない
    await updateTask(ctx, rid, old.id, { title: "古い（改題）" });
    const text = await readFile(file(old.id), "utf8");
    expect(text).not.toContain("acceptance");
    expect(acceptanceStatus(ctx.ws.tasksOf(rid).require(old.id))).toBeUndefined();
  });

  it("無関係な更新で基準・証拠・知らない項目を失わない。基準・証拠は patch で直接は変えられない", async () => {
    const { ctx, rid, file } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "unmet", evidence: "なぜ" }] });
    await writeFile(file(task.id), (await readFile(file(task.id), "utf8")).replace(/^rev:/m, "futureField: keep\nrev:"));
    await updateTask(ctx, rid, task.id, { status: "doing", acceptanceCriteria: [{ id: "X", text: "上書き" }] });
    const text = await readFile(file(task.id), "utf8");
    expect(text).toContain("futureField: keep");
    const t = ctx.ws.tasksOf(rid).require(task.id);
    expect(t.acceptanceCriteria).toEqual([{ id: "A1", text: "一" }]);
    expect(t.acceptanceEvidence?.[0].result).toBe("unmet");
  });

  it("直接編集で壊れた基準・証拠は問題として知らせ、操作では変えず、無関係な更新ではファイルの元の値を残す", async () => {
    const { ctx, rid, file } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一", "二"] });
    const src = await readFile(file(task.id), "utf8");
    const broken = src.replace(/acceptanceCriteria:\n(?:  .*\n)+/, "acceptanceCriteria:\n  - id: A1\n    text: 一\n  - id: A1\n    text: 重複\n  - text: ID なし\n");
    expect(broken).not.toBe(src);
    await writeFile(file(task.id), broken);
    await ctx.ws.reloadAll();
    const t = ctx.ws.tasksOf(rid).require(task.id);
    expect(t.acceptanceCriteria).toEqual([{ id: "A1", text: "一" }]);
    expect(t.acceptanceProblems).toEqual(["受け入れ基準の id が重複しています: A1", "受け入れ基準 3 件目 の id が読めません"]);
    expect(acceptanceStatus(t)!.shortfalls.some((s) => s.startsWith("読めない:"))).toBe(true);
    await expect(updateTask(ctx, rid, task.id, { acceptance: [{ op: "add", text: "三" }] })).rejects.toBeInstanceOf(AcceptanceInputError);
    await updateTask(ctx, rid, task.id, { status: "doing" });
    const after = await readFile(file(task.id), "utf8");
    expect(after).toContain("text: 重複");
    expect(after).toContain("text: ID なし");
    expect(after).not.toContain("acceptanceProblems");
  });

  it("rev が違えば競合（何も書かない）", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await expect(updateTask(ctx, rid, task.id, { acceptance: [{ op: "add", text: "二" }] }, { expectedRev: task.rev + 5 })).rejects.toBeInstanceOf(ConflictError);
    expect(ctx.ws.tasksOf(rid).require(task.id).acceptanceCriteria).toHaveLength(1);
  });

  it("不足があっても完了・済み・対応済を拒まない。完了と同時に証拠を残せ、後の成果物の追記で基準・証拠・doneAt を失わない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一", "二"] });
    const done = await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] });
    expect(done.task.status).toBe("done");
    expect(acceptanceStatus(done.task)!.shortfalls).toEqual(["証拠なし: A2"]);
    await expect(checkStatusChange(ctx.ws, rid, "resolved")).resolves.toBeUndefined();
    const checked = await updateTask(ctx, rid, task.id, { checked: true });
    expect(checked.task.checkedAt).toBeTruthy();
    const later = await updateTask(ctx, rid, task.id, { outputs: ["https://example.com/pr/1"] });
    expect(later.task).toMatchObject({ doneAt: done.task.doneAt, checkedAt: checked.task.checkedAt, acceptanceCriteria: done.task.acceptanceCriteria, acceptanceEvidence: done.task.acceptanceEvidence });
    expect(later.checkCleared).toBeUndefined();
  });

  it("済みの後に基準・証拠の中身が変わったら済みを外す。同じ値の再保存では外さない。未完了へ戻すと従来どおり外れる", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", status: "done", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] });
    await updateTask(ctx, rid, task.id, { checked: true });
    const same = await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] });
    expect(same.task.checkedAt).toBeTruthy();
    expect(same.checkCleared).toBeUndefined();
    const changed = await updateTask(ctx, rid, task.id, { acceptance: [{ op: "edit", id: "A1", text: "一（変更）" }] });
    expect(changed.task.checkedAt).toBeUndefined();
    expect(changed.checkCleared).toBe(CHECK_CLEARED_BY_ACCEPTANCE);
    // 同じ操作で済みを付け直すなら外さない
    const both = await updateTask(ctx, rid, task.id, { checked: true, acceptance: [{ op: "add", text: "二" }] });
    expect(both.task.checkedAt).toBeTruthy();
    const back = await updateTask(ctx, rid, task.id, { status: "todo" });
    expect(back.task.checkedAt).toBeUndefined();
    expect(back.task.acceptanceEvidence).toHaveLength(1);
  });
});

describe("API", () => {
  const send = async (app: ReturnType<typeof apiRoutes>, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("作るときの基準・操作・不足の読み取り・入力の誤り（400）。CLI と同じ状態になる", async () => {
    const { ctx, rid, dataDir } = await setup();
    const app = apiRoutes(ctx);
    const made = await send(app, "POST", `/requests/${rid}/tasks`, { title: "API", criteria: ["一", "二"], acceptanceCriteria: [{ id: "Z", text: "無視" }] });
    expect(made.status).toBe(201);
    expect(made.body.acceptanceCriteria).toEqual([{ id: "A1", text: "一" }, { id: "A2", text: "二" }]);
    const id = made.body.id as string;
    const patched = await send(app, "PATCH", `/requests/${rid}/tasks/${id}`, {
      status: "done",
      acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }, { op: "order", ids: ["A2", "A1"] }],
    });
    expect(patched.status).toBe(200);
    const got = await send(app, "GET", `/requests/${rid}/tasks/${id}`);
    expect((got.body.acceptance as { shortfalls: string[] }).shortfalls).toEqual(["証拠なし: A2"]);
    const bad = await send(app, "PATCH", `/requests/${rid}/tasks/${id}`, { acceptance: [{ op: "record", id: "A2", result: "met", evidence: "" }] });
    expect(bad).toMatchObject({ status: 400, body: { code: "acceptance_invalid" } });
    const conflict = await send(app, "PATCH", `/requests/${rid}/tasks/${id}`, { rev: 1, acceptance: [{ op: "add", text: "三" }] });
    expect(conflict.status).toBe(409);

    // CLI で同じことをすると同じ基準・証拠になる
    const cli = p3(dataDir, ["new", "CLI", "--req", rid, "--criterion", "一", "--criterion", "二", "--json"], "ai:test");
    const cid = (JSON.parse(cli.out) as { id: string }).id;
    expect(p3(dataDir, ["move", cid, "done", "--req", rid, "--evidence", "A1=met:e", "--record", "r"], "ai:test").code).toBe(0);
    expect(p3(dataDir, ["criteria", cid, "order", "A2", "A1", "--req", rid], "ai:test").code).toBe(0);
    await ctx.ws.reloadAll();
    const a = ctx.ws.tasksOf(rid).require(id);
    const c = ctx.ws.tasksOf(rid).require(cid);
    const shape = (t: typeof a) => ({ criteria: t.acceptanceCriteria, evidence: t.acceptanceEvidence?.map(({ recordedAt: _r, recordedBy: _b, ...e }) => e), status: acceptanceStatus(t)?.shortfalls });
    expect(shape(c)).toEqual(shape(a));
  });
});

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[], actor = "human:test", input?: string) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: actor };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, input, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI", () => {
  it("criteria / evidence の操作、show の通常・brief・JSON、完了と同時の証拠のファイル、標準入力の取り合いを断る", async () => {
    const { rid, dataDir } = await setup();
    const req = ["--req", rid];
    const made = JSON.parse(p3(dataDir, ["new", "画面", ...req, "--criterion", "一覧", "--json"]).out) as { id: string };
    const t = made.id;
    expect(p3(dataDir, ["criteria", t, "add", "詳細", "保存", ...req]).code).toBe(0);
    expect(p3(dataDir, ["criteria", t, "edit", "A2", "詳細を", "開ける", ...req]).code).toBe(0);
    expect(p3(dataDir, ["criteria", t, "rm", "A3", ...req]).code).toBe(0);
    expect(p3(dataDir, ["criteria", t, "add", "幅 375", ...req]).code).toBe(0);
    const ls = JSON.parse(p3(dataDir, ["criteria", t, ...req, "--json"]).out) as { criteria: { id: string; text: string }[] };
    expect(ls.criteria).toEqual([{ id: "A1", text: "一覧" }, { id: "A2", text: "詳細を 開ける" }, { id: "A4", text: "幅 375" }]);

    // 証拠: 1件ずつ（本文は --body / --file）
    expect(p3(dataDir, ["evidence", t, "A1", "met", "--body", "-", ...req], "ai:test", "test/ui/x.ui.test.ts\n").code).toBe(0);
    expect(p3(dataDir, ["evidence", t, "A1", "passed", ...req]).code).toBe(1);
    expect(p3(dataDir, ["evidence", t, "A9", "met", "x", ...req]).code).toBe(1);
    // 完了と同時にファイルで（記録も別のファイル）
    await writeFile(join(dataDir, "ev.md"), "## A2 met\n画面で確かめた\n\n## A4 unverified\n375 の端末が無い\n");
    const stdin = p3(dataDir, ["move", t, "done", ...req, "--evidence-file", "-", "--record", "-"], "ai:test", "x");
    expect(stdin.code).toBe(1);
    expect(stdin.err).toContain("標準入力");
    const done = p3(dataDir, ["move", t, "done", ...req, "--evidence-file", "ev.md", "--record", "記録"], "ai:test");
    // 完了は不足があっても通る（不足は stderr で知らせる）
    expect(done.code).toBe(0);
    expect(done.err).toContain("未検証: A4");

    const show = JSON.parse(p3(dataDir, ["show", t, ...req, "--json"]).out) as { acceptance: { met: number; total: number } };
    expect(show.acceptance).toMatchObject({ met: 2, total: 3 });
    const brief = JSON.parse(p3(dataDir, ["show", t, ...req, "--brief", "--json"]).out) as { item: { acceptanceCriteria: unknown[] }; acceptance: { shortfalls: string[] } };
    expect(brief.item.acceptanceCriteria).toHaveLength(3);
    expect(brief.acceptance.shortfalls).toEqual(["未検証: A4"]);
    const text = p3(dataDir, ["show", t, ...req]).out;
    expect(text).toContain("受け入れ基準（2/3 を満たした");
    expect(text).toContain("375 の端末が無い");

    // set: 基準を足す・証拠を残す。evidence rm
    expect(p3(dataDir, ["set", t, ...req, "--criterion", "五", "--evidence", "A4=met:実機で確認"]).code).toBe(0);
    expect(p3(dataDir, ["evidence", t, "rm", "A1", ...req]).code).toBe(0);
    const after = JSON.parse(p3(dataDir, ["criteria", t, ...req, "--json"]).out) as { acceptance: { shortfalls: string[] } };
    expect(after.acceptance.shortfalls).toEqual(["証拠なし: A1, A5"]);

    // 基準のないタスクは「受け入れ基準なし」
    p3(dataDir, ["new", "古い", ...req]);
    expect(p3(dataDir, ["show", "T002", ...req]).out).toContain("受け入れ基準なし");
  });
});
