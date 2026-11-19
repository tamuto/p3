import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AcceptanceInputError,
  acceptanceStatus,
  applyAcceptanceOps,
  basisLabel,
  evidenceSummary,
  parseEvidenceJson,
  readAcceptance,
  type AcceptanceState,
  type EvidenceBasis,
} from "../packages/tasks/src/features/requirements/shared/acceptance.ts";
import { progress } from "../packages/tasks/src/core/ops.ts";
import { createTask, updateTask } from "../packages/tasks/src/core/requestOps.ts";
import { extractTaskReview, taskReviewInputHash } from "../packages/tasks/src/features/taskReview/core/material.ts";
import { taskReviewMaterial } from "../packages/tasks/src/features/taskReview/core/review.ts";
import { apiRoutes } from "../packages/tasks/src/server/api/routes.ts";
import { git, makeProject, newRequest, tempDir } from "./helpers.ts";

/**
 * 証拠の根拠の種類（basis）: 未確認・申告のみ・読んで確認・検査結果あり。古い証拠（basis なし）の読み方、入力の規則と組み合わせ、
 * 済みの解除と同じ値の再保存、stale・orphan を内訳に入れないこと、完了・済みを拒まないこと、CLI・API・進捗・レビューの材料を確かめる
 */

const at = { now: "2026-11-17T00:00:00.000Z", actor: "ai:test" };
const machine: EvidenceBasis = { kind: "machine", command: "pnpm vitest run test/x.test.ts", result: "終了コード 0", target: "p3:abc1234" };
const read: EvidenceBasis = { kind: "read", reference: "src/x.ts の y を読み、z を返すことを確かめた" };
const base = (): AcceptanceState => applyAcceptanceOps({}, [{ op: "add", text: "一" }, { op: "add", text: "二" }, { op: "add", text: "三" }], at);

describe("根拠の規則（shared）", () => {
  it("古い証拠（basis なし）は移行せずに読み、unverified は未確認・ほかは申告のみ（種類未記録）と解釈する", () => {
    const old = readAcceptance({
      acceptanceCriteria: [{ id: "A1", text: "一" }, { id: "A2", text: "二" }],
      acceptanceEvidence: [
        { criterionId: "A1", criterionText: "一", result: "met", evidence: "テストを通した", recordedAt: "2026-01-01T00:00:00.000Z" },
        { criterionId: "A2", criterionText: "二", result: "unverified", evidence: "", recordedAt: "2026-01-01T00:00:00.000Z" },
      ],
    });
    expect(old.acceptanceProblems).toBeUndefined();
    expect(old.acceptanceEvidence!.every((e) => e.basis === undefined)).toBe(true);
    expect(basisLabel(old.acceptanceEvidence![0])).toBe("申告のみ（種類未記録）");
    expect(basisLabel(old.acceptanceEvidence![1])).toBe("未確認（種類未記録）");
    const st = acceptanceStatus(old)!;
    // 本文に「テスト」とあっても格上げしない
    expect(st.metByBasis).toEqual({ unverified: 0, declaration: 1, read: 0, machine: 0 });
    expect(st.declarationOnly).toEqual(["A1"]);
    // 古い証拠を開いて同じ値で保存し直しても、根拠は足されず、記録の日時も変わらない
    const same = applyAcceptanceOps(old, [{ op: "record", id: "A1", result: "met", evidence: "テストを通した" }], at);
    expect(same.acceptanceEvidence![0]).toEqual(old.acceptanceEvidence![0]);
    // 根拠を省いて本文だけ直すと、根拠は無いまま（古い画面の更新を妨げない）
    const edited = applyAcceptanceOps(old, [{ op: "record", id: "A1", result: "met", evidence: "直した" }], at);
    expect(edited.acceptanceEvidence![0]).toMatchObject({ evidence: "直した", recordedAt: at.now });
    expect(edited.acceptanceEvidence![0].basis).toBeUndefined();
  });

  it("新しい入力: 省けば unverified は未確認・ほかは申告のみ。読んで確認・検査結果ありを保存し、検査は失敗も記録できる", () => {
    const s = applyAcceptanceOps(
      base(),
      [
        { op: "record", id: "A1", result: "met", evidence: "対象のテストが通った", basis: machine },
        { op: "record", id: "A2", result: "unmet", evidence: "失敗した", basis: { ...machine, result: "終了コード 1（2 件失敗）" } },
        { op: "record", id: "A3", result: "unverified", evidence: "" },
      ],
      at,
    );
    expect(s.acceptanceEvidence!.map((e) => e.basis)).toEqual([machine, { ...machine, result: "終了コード 1（2 件失敗）" }, { kind: "unverified" }]);
    const d = applyAcceptanceOps(base(), [{ op: "record", id: "A1", result: "met", evidence: "e" }, { op: "record", id: "A2", result: "met", evidence: "e", basis: read }], at);
    expect(d.acceptanceEvidence!.map((e) => e.basis)).toEqual([{ kind: "declaration" }, read]);
    // 空白を除いて保存する
    const trimmed = applyAcceptanceOps(base(), [{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "read", reference: "  資料  " } }], at);
    expect(trimmed.acceptanceEvidence![0].basis).toEqual({ kind: "read", reference: "資料" });
    // 根拠を省いた再記録は、同じ結果の前の根拠を引き継ぐ。結果が変われば既定に戻る
    const kept = applyAcceptanceOps(s, [{ op: "record", id: "A1", result: "met", evidence: "本文だけ直した" }], at);
    expect(kept.acceptanceEvidence![0].basis).toEqual(machine);
    const changed = applyAcceptanceOps(s, [{ op: "record", id: "A2", result: "met", evidence: "直して通した" }], at);
    expect(changed.acceptanceEvidence![1].basis).toEqual({ kind: "declaration" });
  });

  it("知らない種類・要る項目の欠け・長すぎる・結果と合わない組み合わせは理由をつけて断り、1件も当てない", () => {
    const bad: [Parameters<typeof applyAcceptanceOps>[1], RegExp][] = [
      [[{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "human" } as unknown as EvidenceBasis }], /根拠の種類は unverified \/ declaration \/ read \/ machine/],
      [[{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "machine", command: "x", result: "", target: "t" } }], /検査の結果（result）が要ります/],
      [[{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "read", reference: " " } }], /読んだもの（reference）が要ります/],
      [[{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "read", reference: "x".repeat(1001) } }], /1000 文字まで/],
      [[{ op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "unverified" } }], /met（満たした）に根拠「未確認」は付けられません/],
      [[{ op: "record", id: "A1", result: "unmet", evidence: "e", basis: { kind: "unverified" } }], /根拠「未確認」は付けられません/],
      [[{ op: "record", id: "A1", result: "unverified", evidence: "", basis: read }], /unverified（未検証）の根拠は「未確認」だけです/],
      // 先の正しい操作も当てない
      [[{ op: "record", id: "A2", result: "met", evidence: "ok", basis: read }, { op: "record", id: "A1", result: "met", evidence: "e", basis: { kind: "x" } as unknown as EvidenceBasis }], /根拠の種類/],
    ];
    const s = base();
    for (const [ops, msg] of bad) {
      expect(() => applyAcceptanceOps(s, ops, at)).toThrow(AcceptanceInputError);
      expect(() => applyAcceptanceOps(s, ops, at)).toThrow(msg);
    }
    expect(s.acceptanceEvidence).toBeUndefined();
  });

  it("直接編集で壊れた根拠は問題として知らせる（証拠を黙って消さない）", () => {
    const r = readAcceptance({
      acceptanceCriteria: [{ id: "A1", text: "一" }, { id: "A2", text: "二" }],
      acceptanceEvidence: [
        { criterionId: "A1", criterionText: "一", result: "met", evidence: "e", basis: { kind: "machine", command: "x" }, recordedAt: at.now },
        { criterionId: "A2", criterionText: "二", result: "unverified", evidence: "", basis: { kind: "read", reference: "r" }, recordedAt: at.now },
      ],
    });
    expect(r.acceptanceProblems).toEqual([
      "証拠 1 件目（A1） の根拠（basis）が読めません: 根拠「検査結果あり」には検査の結果（result）が要ります",
      "証拠 2 件目（A2） の根拠（basis）が結果と合いません: unverified（未検証）の根拠は「未確認」だけです（読んで確認 は付けられません）",
    ]);
  });

  it("stale・orphan の根拠は有効な内訳に入れない。基準なし・証拠なし・未検証・読めない値を混同しない", () => {
    let s = applyAcceptanceOps(
      base(),
      [
        { op: "record", id: "A1", result: "met", evidence: "e", basis: machine },
        { op: "record", id: "A2", result: "met", evidence: "e", basis: read },
        { op: "record", id: "A3", result: "met", evidence: "e" },
      ],
      at,
    );
    expect(acceptanceStatus(s)!.metByBasis).toEqual({ unverified: 0, declaration: 1, read: 1, machine: 1 });
    s = applyAcceptanceOps(s, [{ op: "edit", id: "A1", text: "いち" }, { op: "remove", id: "A3" }], at);
    const st = acceptanceStatus(s)!;
    expect(st.met).toBe(1);
    expect(st.metByBasis).toEqual({ unverified: 0, declaration: 0, read: 1, machine: 0 });
    expect(st.declarationOnly).toEqual([]);
    expect(st.items.map((i) => i.state)).toEqual(["stale", "met"]);
    expect(st.orphans.map((e) => e.criterionId)).toEqual(["A3"]);
    expect(evidenceSummary({})).toBeUndefined();
    expect(evidenceSummary({ acceptanceProblems: ["x"] })).toMatchObject({ met: 0, total: 0, problems: true });
  });

  it("証拠の JSON は record と同じ規則で読み、形の誤り・知らない項目・重複を断る", () => {
    expect(parseEvidenceJson(JSON.stringify([{ id: "A1", result: "met", evidence: "e", basis: machine }, { id: "A2", result: "unverified" }]))).toEqual([
      { op: "record", id: "A1", result: "met", evidence: "e", basis: machine },
      { op: "record", id: "A2", result: "unverified", evidence: "" },
    ]);
    for (const [src, msg] of [
      ["{", /JSON が読めません/],
      ["[]", /1件以上/],
      ['[{"id":"A1","result":"done"}]', /result は met/],
      ['[{"id":"A1","result":"met","note":"x"}]', /知らない項目があります: note/],
      ['[{"id":"A1","result":"met","basis":{"kind":"read"}}]', /reference/],
      ['[{"id":"A1","result":"met"},{"id":"A1","result":"unmet"}]', /A1 が2回/],
    ] as const)
      expect(() => parseEvidenceJson(src)).toThrow(msg);
  });
});

async function setup() {
  const p = await makeProject();
  const req = await newRequest(p.ctx, { title: "要望" });
  const file = (tid: string) => join(p.dataDir, "requests", req.id, "tasks", `${tid}.md`);
  return { ...p, rid: req.id, file };
}

describe("保存と更新（core）", () => {
  it("根拠を保存して読み直せる。根拠だけの変更で済みを外し、同じ値の再保存では記録の日時も済みも変えない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: read }] }, { actor: "ai:test" });
    await updateTask(ctx, rid, task.id, { checked: true }, { actor: "human:test" });
    await ctx.ws.reloadAll();
    const saved = ctx.ws.tasksOf(rid).require(task.id);
    expect(saved.acceptanceEvidence![0].basis).toEqual(read);
    expect(saved.checkedAt).toBeTruthy();

    const same = await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: read }] }, { actor: "ai:other" });
    expect(same.task.checkedAt).toBe(saved.checkedAt);
    expect(same.task.acceptanceEvidence![0].recordedAt).toBe(saved.acceptanceEvidence![0].recordedAt);

    const changed = await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: machine }] }, { actor: "ai:test" });
    expect(changed.task.checkedAt).toBeUndefined();
    expect(changed.checkCleared).toBeTruthy();
  });

  it("申告のみの met があっても完了と人の済みを拒まない", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    const done = await updateTask(ctx, rid, task.id, { status: "done", acceptance: [{ op: "record", id: "A1", result: "met", evidence: "やった" }] });
    expect(done.task.status).toBe("done");
    expect(acceptanceStatus(done.task)!.declarationOnly).toEqual(["A1"]);
    const checked = await updateTask(ctx, rid, task.id, { checked: true }, { actor: "human:test" });
    expect(checked.task.checkedAt).toBeTruthy();
  });

  it("壊れた根拠のタスクは操作で変えず、無関係な更新でもファイルの元の値を残す", async () => {
    const { ctx, rid, file } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: read }] });
    const src = await readFile(file(task.id), "utf8");
    const broken = src.replace(/kind: read\n(\s+)reference: .*\n/, "kind: telepathy\n");
    expect(broken).not.toBe(src);
    await writeFile(file(task.id), broken);
    await ctx.ws.reloadAll();
    const t = ctx.ws.tasksOf(rid).require(task.id);
    expect(t.acceptanceProblems?.[0]).toContain("根拠（basis）が読めません");
    await expect(updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e" }] })).rejects.toBeInstanceOf(AcceptanceInputError);
    await updateTask(ctx, rid, task.id, { status: "doing" });
    expect(await readFile(file(task.id), "utf8")).toContain("kind: telepathy");
  });

  it("進捗のタスクの印に証拠の概要を載せ、本文は載せない（基準のないタスクは省く）", async () => {
    const { ctx, rid } = await setup();
    const { task } = await createTask(ctx, rid, { title: "t", criteria: ["一", "二"] });
    await createTask(ctx, rid, { title: "基準なし" });
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "秘密の本文", basis: machine }, { op: "record", id: "A2", result: "met", evidence: "e" }] });
    const row = progress(ctx).find((p) => p.request.id === rid)!;
    const [a, b] = row.tasks;
    expect(a.evidence).toEqual({ met: 2, total: 2, declarationOnly: 1, metByBasis: { unverified: 0, declaration: 1, read: 0, machine: 1 }, problems: false });
    expect(b.evidence).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("秘密の本文");
    expect(JSON.stringify(row)).not.toContain("pnpm vitest");
    // 完了数・総数の意味は変えない
    expect([row.total, row.done]).toEqual([2, 0]);
  });

  it("レビューの材料に根拠が残り、根拠の変更で材料の hash が変わる。材料を作っても証拠と済みは変わらない", async () => {
    const { ctx, rid, dataDir, root } = await setup();
    const put = (path: string, c: string) => (mkdirSync(join(root, path, ".."), { recursive: true }), writeFileSync(join(root, path), c), git(root, "add", path));
    put(".gitignore", ".p3/\n");
    put("src/a.ts", "a1\n");
    git(root, "commit", "-q", "-m", "最初");
    put("src/a.ts", "a2\n");
    git(root, "commit", "-q", "-m", "変更");
    const sha = git(root, "rev-parse", "HEAD");
    const { task } = await createTask(ctx, rid, { title: "t", repo: "main", criteria: ["一"] });
    await updateTask(ctx, rid, task.id, { status: "done", outputs: [sha], acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: read }] });
    await updateTask(ctx, rid, task.id, { checked: true }, { actor: "human:test" });
    await ctx.ws.reloadAll();
    const before = ctx.ws.tasksOf(rid).require(task.id);
    const first = (await extractTaskReview(dataDir, rid, task.id, ctx.ws.refs())).input;
    expect(first.task.evidence?.[0].basis).toEqual(read);
    expect(taskReviewMaterial(first).task.workerEvidence[0]).toMatchObject({ criterion: "A1", basis: read, basisRecorded: true });
    await ctx.ws.reloadAll();
    const after = ctx.ws.tasksOf(rid).require(task.id);
    expect(after.acceptanceEvidence).toEqual(before.acceptanceEvidence);
    expect(after.checkedAt).toBe(before.checkedAt);
    await updateTask(ctx, rid, task.id, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: machine }] });
    const second = (await extractTaskReview(dataDir, rid, task.id, ctx.ws.refs())).input;
    expect(second.hash).not.toBe(first.hash);
    const { extractedAt: _x, hash: _h, ...body } = first;
    expect(taskReviewInputHash(body)).toBe(first.hash);
  });
});

describe("API", () => {
  const send = async (app: ReturnType<typeof apiRoutes>, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("PATCH の record で根拠を保存し、GET の acceptance に内訳が出る。読めない根拠は 400 で何も書かない", async () => {
    const { ctx, rid } = await setup();
    const app = apiRoutes(ctx);
    const made = await send(app, "POST", `/requests/${rid}/tasks`, { title: "API", criteria: ["一", "二"] });
    const id = made.body.id as string;
    const ok = await send(app, "PATCH", `/requests/${rid}/tasks/${id}`, { acceptance: [{ op: "record", id: "A1", result: "met", evidence: "e", basis: machine }, { op: "record", id: "A2", result: "met", evidence: "e" }] });
    expect(ok.status).toBe(200);
    const got = await send(app, "GET", `/requests/${rid}/tasks/${id}`);
    expect(got.body.acceptance).toMatchObject({ met: 2, metByBasis: { machine: 1, declaration: 1 }, declarationOnly: ["A2"] });
    expect((got.body.task as { acceptanceEvidence: { basis: unknown }[] }).acceptanceEvidence[0].basis).toEqual(machine);
    for (const basis of [{ kind: "machine", command: "x" }, { kind: "nope" }, "read"]) {
      const bad = await send(app, "PATCH", `/requests/${rid}/tasks/${id}`, { acceptance: [{ op: "record", id: "A2", result: "met", evidence: "e2", basis }] });
      expect(bad.status).toBe(400);
    }
    await ctx.ws.reloadAll();
    expect(ctx.ws.tasksOf(rid).require(id).acceptanceEvidence![1]).toMatchObject({ evidence: "e", basis: { kind: "declaration" } });
  });
});

const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));
function p3(dataDir: string, args: string[], input?: string) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-"), P3_ACTOR: "ai:test" };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, ...args], { encoding: "utf8", env, input, cwd: dataDir });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("CLI", () => {
  it("evidence の --basis と検査の項目、--evidence-json、show の通常・brief・JSON。合わない指定は断る", async () => {
    const { dataDir, rid } = await setup();
    const req = ["--req", rid];
    const t = (JSON.parse(p3(dataDir, ["new", "t", ...req, "--criterion", "一", "--criterion", "二", "--criterion", "三", "--json"]).out) as { id: string }).id;

    const ok = p3(dataDir, ["evidence", t, "A1", "met", "対象のテストが通った", ...req, "--basis", "machine", "--command", machine.command, "--check-result", machine.result, "--target", machine.target]);
    expect(ok.code, ok.err).toBe(0);
    expect(p3(dataDir, ["evidence", t, "A2", "met", "読んだ", ...req, "--basis", "read", "--reference", read.reference]).code).toBe(0);
    // 合わない指定
    const noBasis = p3(dataDir, ["evidence", t, "A3", "met", "x", ...req, "--reference", "r"]);
    expect(noBasis.code).toBe(1);
    expect(noBasis.err).toContain("--basis");
    expect(p3(dataDir, ["evidence", t, "A3", "met", "x", ...req, "--basis", "read", "--command", "c"]).err).toContain("--basis read には --command を使いません");
    expect(p3(dataDir, ["evidence", t, "A3", "met", "x", ...req, "--basis", "machine", "--command", "c"]).err).toContain("検査の結果");
    expect(p3(dataDir, ["evidence", t, "A3", "met", "x", ...req, "--basis", "unverified"]).err).toContain("未確認」は付けられません");
    expect(p3(dataDir, ["evidence", t, "A3", "met", "x", ...req, "--basis", "human"]).err).toContain("--basis は");

    // 完了と同時に JSON で（Markdown と一緒・標準入力の取り合いは断る）
    const json = JSON.stringify([{ id: "A3", result: "unmet", evidence: "2 件落ちた", basis: { ...machine, result: "終了コード 1" } }]);
    await writeFile(join(dataDir, "ev.json"), json);
    await writeFile(join(dataDir, "ev.md"), "## A3 met\nx\n");
    expect(p3(dataDir, ["move", t, "done", ...req, "--evidence-json", "ev.json", "--evidence-file", "ev.md", "--record", "r"]).err).toContain("どちらか一方");
    expect(p3(dataDir, ["move", t, "done", ...req, "--evidence-json", "-", "--record", "-"], json).err).toContain("標準入力");
    const bad = p3(dataDir, ["move", t, "done", ...req, "--evidence-json", "-", "--record", "r"], '[{"id":"A3","result":"met","basis":{"kind":"read"}}]');
    expect(bad.code).toBe(1);
    expect(JSON.parse(p3(dataDir, ["show", t, ...req, "--json"]).out).item.status).toBe("todo");
    const done = p3(dataDir, ["move", t, "done", ...req, "--evidence-json", "ev.json", "--record", "r"]);
    expect(done.code, done.err).toBe(0);

    const show = JSON.parse(p3(dataDir, ["show", t, ...req, "--json"]).out) as { acceptance: { met: number; metByBasis: Record<string, number>; declarationOnly: string[] }; item: { acceptanceEvidence: { basis: unknown }[] } };
    expect(show.acceptance).toMatchObject({ met: 2, metByBasis: { machine: 1, read: 1, declaration: 0 }, declarationOnly: [] });
    expect(show.item.acceptanceEvidence.map((e) => e.basis)).toEqual([machine, read, { ...machine, result: "終了コード 1" }]);
    const brief = JSON.parse(p3(dataDir, ["show", t, ...req, "--brief", "--json"]).out) as { item: { acceptanceEvidence: { basis: unknown }[] }; acceptance: { metByBasis: Record<string, number> } };
    expect(brief.item.acceptanceEvidence[0].basis).toEqual(machine);
    expect(brief.acceptance.metByBasis.machine).toBe(1);
    const text = p3(dataDir, ["show", t, ...req]).out;
    expect(text).toContain("受け入れ基準（2/3 を満たしたと申告。根拠: 読んで確認 1・検査結果あり 1）");
    expect(text).toContain("根拠: 検査結果あり");
    expect(text).toContain(`コマンド: ${machine.command}`);
    expect(text).toContain("対象: p3:abc1234");
    expect(text).toContain(`読んだもの: ${read.reference}`);
    // まとめての JSON（evidence コマンド）
    await writeFile(join(dataDir, "ev2.json"), JSON.stringify([{ id: "A2", result: "met", evidence: "読んだ", basis: { kind: "declaration" } }]));
    expect(p3(dataDir, ["evidence", t, "--evidence-json", "ev2.json", ...req]).code).toBe(0);
    expect(p3(dataDir, ["evidence", t, "--evidence-json", "ev2.json", "--basis", "read", ...req]).err).toContain("--basis は1項目のときだけ");
    expect(JSON.parse(p3(dataDir, ["criteria", t, ...req, "--json"]).out).acceptance.declarationOnly).toEqual(["A2"]);
  });
});
