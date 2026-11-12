import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/core/requestOps.ts";
import { NotFoundError } from "../src/core/store/collection.ts";
import { bodyItems, extractTaskReview, safeRelPath, TASK_REVIEW_LIMITS, TaskReviewRejected } from "../src/core/taskReview/material.ts";
import { git, gitInit, makeProject, newRequest, tempDir } from "./helpers.ts";

/**
 * タスクの AI レビューの材料（core/taskReview/material.ts）: 対象のタスクの固定・比較対象の正規化（単一・複数・ルート・マージ・範囲・
 * PR・他のタスク・浅い履歴・worktree・読めない参照先）・差分と前後の中身（削除・名前の変更・バイナリ・submodule・シンボリックリンク・
 * 上限）・観点（固定した SHA・作業ブランチで差し替えない）・hash
 */

const commit = (root: string, msg: string, files: Record<string, string | null>) => {
  for (const [p, c] of Object.entries(files)) {
    if (c === null) git(root, "rm", "-q", p);
    else {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), c);
      git(root, "add", p);
    }
  }
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
};

async function setup() {
  const p = await makeProject();
  // .p3 は git に入れない（データのフォルダの変更をコードの差分に混ぜない）
  writeFileSync(join(p.root, ".gitignore"), ".p3/\n");
  const c0 = commit(p.root, "最初", { ".gitignore": ".p3/\n", "src/a.ts": "export const a = 1;\n", "src/old.ts": "export const old = 1;\n" });
  const req = await newRequest(p.ctx, { title: "通知を足す", body: "通知を送れるようにする" });
  const rid = req.id;
  const c1 = commit(p.root, `通知を送る（${rid}/T001）`, { "src/a.ts": "export const a = 2;\n", "src/notify.ts": "export const send = () => true;\n" });
  const { task } = await createTask(p.ctx, rid, { title: "送る", criteria: ["送信できる", "失敗を記録する"], body: "## 作業内容\n送る\n\n## 完了条件\n- 送れる\n- 失敗を記録する\n" });
  await updateTask(p.ctx, rid, task.id, {
    status: "done",
    record: "送る処理を足した",
    outputs: [`https://github.com/x/y/commit/${c1}`],
    acceptance: [{ op: "record", id: "A1", result: "met", evidence: "notify.test.ts" }],
  });
  const refs = p.ctx.ws.refs();
  const extract = (opts: Parameters<typeof extractTaskReview>[4] = {}, tid = task.id) => extractTaskReview(p.dataDir, rid, tid, refs, opts);
  return { ...p, rid, tid: task.id, c0, c1, refs, extract };
}

describe("タスクと比較項目", () => {
  it("完了したタスクの本文・基準・証拠（状態つき）・記録・成果物・要望の文脈を写し、証拠は判定に変えない", async () => {
    const { extract, rid, c1, c0 } = await setup();
    const { input, files } = await extract();
    expect(input.request).toMatchObject({ id: rid, title: "通知を足す", body: "通知を送れるようにする" });
    expect(input.task).toMatchObject({ ref: `${rid}/T001`, status: "done", record: "送る処理を足した" });
    expect(input.items).toEqual([
      { id: "A1", kind: "criterion", text: "送信できる" },
      { id: "A2", kind: "criterion", text: "失敗を記録する" },
    ]);
    expect(input.task.evidenceStates).toEqual([{ id: "A1", state: "met" }, { id: "A2", state: "missing" }]);
    expect(input.notes.map((n) => n.code)).toEqual(["no_evidence", "quality_unset"]);
    // 比較対象: 成果物のコミット。親との差分と前後の中身
    expect(input.targets).toHaveLength(1);
    const t = input.targets[0];
    expect(t).toMatchObject({ repo: "main", kind: "commits", commits: [{ sha: c1, parents: [c0], otherTasks: [] }] });
    expect(t.diffs[0]).toMatchObject({ base: c0, head: c1 });
    const changes = Object.fromEntries(t.diffs[0].changes.map((c) => [c.path, c]));
    expect(changes["src/a.ts"]).toMatchObject({ status: "M", baseFile: `code/main/${c0}/src/a.ts`, headFile: `code/main/${c1}/src/a.ts` });
    expect(changes["src/notify.ts"]).toMatchObject({ status: "A", headFile: `code/main/${c1}/src/notify.ts` });
    expect(changes["src/notify.ts"].baseFile).toBeUndefined();
    expect(files.get(`code/main/${c0}/src/a.ts`)!.toString()).toBe("export const a = 1;\n");
    expect(files.get(t.diffs[0].patchFile)!.toString()).toContain("+export const send");
    expect(input.files.map((f) => f.path).sort()).toEqual([...files.keys()].sort());
  });

  it("基準が無ければ本文の完了条件から項目を取り出し、元の段落を残す。記録・成果物なしを注意に残す", async () => {
    expect(bodyItems("## 作業内容\n- 手順\n\n## 完了条件\n- 送れる\n- [x] 記録する\n\n## 判断の根拠\n- x")).toEqual([
      { id: "B1", kind: "body", text: "送れる", source: "送れる" },
      { id: "B2", kind: "body", text: "記録する", source: "記録する" },
    ]);
    expect(bodyItems("段落 1\n\n段落 2").map((i) => i.text)).toEqual(["段落 1", "段落 2"]);
    const { ctx, rid, extract, c1 } = await setup();
    const { task } = await createTask(ctx, rid, { title: "基準なし", body: "## 完了条件\n- 画面に出る\n" });
    await updateTask(ctx, rid, task.id, { status: "done" });
    const { input } = await extract({ targets: [`main:${c1}`] }, task.id);
    expect(input.items).toEqual([{ id: "B1", kind: "body", text: "画面に出る", source: "画面に出る" }]);
    // 比べたコミットは T001 のもの（他のタスクの作業が混ざっている注意）
    expect(input.notes.map((n) => n.code)).toEqual(["no_criteria", "no_record", "no_outputs", "other_tasks", "quality_unset"]);
  });

  it("無い・未完了・アーカイブしたタスクは理由つきで断る", async () => {
    const { ctx, rid, extract } = await setup();
    await expect(extract({}, "T009")).rejects.toBeInstanceOf(NotFoundError);
    const { task } = await createTask(ctx, rid, { title: "途中" });
    await expect(extract({}, task.id)).rejects.toMatchObject({ code: "not_done" });
    await updateTask(ctx, rid, task.id, { status: "done" });
    await ctx.ws.tasksOf(rid).archive(task.id);
    await expect(extract({}, task.id)).rejects.toMatchObject({ code: "archived" });
  });
});

describe("比較対象", () => {
  it("複数のコミット・範囲（merge-base を残す）・ルートのコミット（空の tree）。他のタスクのコミットを分けて知らせる", async () => {
    const { root, extract, c0, c1, rid } = await setup();
    const c2 = commit(root, `ほかのタスク（${rid}/T002）`, { "src/b.ts": "b\n" });
    const many = (await extract({ targets: [`main:${c1.slice(0, 10)},${c2}`] })).input;
    expect(many.targets[0].commits.map((c) => c.sha)).toEqual([c1, c2]);
    expect(many.targets[0].diffs.map((d) => [d.base, d.head])).toEqual([
      [c0, c1],
      [c1, c2],
    ]);
    expect(many.targets[0].commits[1].otherTasks).toEqual([`${rid}/T002`]);
    expect(many.notes.some((n) => n.code === "other_tasks")).toBe(true);
    git(root, "branch", "topic", c1);
    const range = (await extract({ targets: [`main:${c0}..main`] })).input.targets[0];
    expect(range).toMatchObject({ kind: "range", range: { base: c0, head: c2, mergeBase: c0, baseSpec: c0, headSpec: "main" } });
    expect(range.diffs).toEqual([expect.objectContaining({ base: c0, head: c2 })]);
    const rootT = (await extract({ targets: [`main:${c0}`] })).input.targets[0];
    expect(rootT.diffs[0].base).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(rootT.diffs[0].changes.every((c) => c.status === "A" && !c.baseFile)).toBe(true);
  });

  it("マージのコミット・未解決の PR・無いコミット・形の違う指定・読めない参照先は理由つきで断る", async () => {
    const { root, extract, ctx, rid, tid, c1 } = await setup();
    git(root, "switch", "-q", "-c", "side", c1);
    commit(root, "side", { "s.txt": "s\n" });
    git(root, "switch", "-q", "main");
    commit(root, "main 側", { "m.txt": "m\n" });
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
    const merge = git(root, "rev-parse", "HEAD");
    await expect(extract({ targets: [`main:${merge}`] })).rejects.toMatchObject({ code: "merge_commit" });
    await expect(extract({ targets: ["https://github.com/x/y/pull/3"] })).rejects.toMatchObject({ code: "pr_unresolved" });
    await expect(extract({ targets: ["main:deadbeef"] })).rejects.toMatchObject({ code: "unknown_commit" });
    await expect(extract({ targets: ["main:not a sha"] })).rejects.toMatchObject({ code: "bad_target" });
    await expect(extract({ targets: ["main:--output=x..HEAD"] })).rejects.toMatchObject({ code: "bad_target" });
    // 成果物に PR があれば出典として残す
    await updateTask(ctx, rid, tid, { outputs: [`https://github.com/x/y/commit/${c1}`, "https://github.com/x/y/pull/3"] });
    expect((await extract()).input.notes.some((n) => n.code === "pr_unresolved")).toBe(true);
    // 読めない参照先
    const bad = ctx.ws.refs().map((r) => ({ ...r, status: "missing" as const, reason: "無い" }));
    await expect(extractTaskReview(ctx.ws.dataDir, rid, tid, bad, { targets: [`main:${c1}`] })).rejects.toMatchObject({ code: "repo_unavailable" });
  });

  it("成果物にコミットが無ければ指定を求める", async () => {
    const { ctx, rid, tid, extract } = await setup();
    await updateTask(ctx, rid, tid, { outputs: ["src/notify.ts"] });
    await expect(extract()).rejects.toMatchObject({ code: "no_target" });
  });

  it("作業ツリーの未コミットの変更・ブランチの切り替えは固定した対象に混ざらず、同じ材料なら hash は日時によらず同じ", async () => {
    const { root, extract, c1 } = await setup();
    const a = (await extract({ targets: [`main:${c1}`] })).input;
    writeFileSync(join(root, "src/a.ts"), "dirty\n");
    git(root, "switch", "-q", "-c", "other");
    const b = (await extract({ targets: [`main:${c1}`] })).input;
    expect(b.hash).toBe(a.hash);
    expect(b.extractedAt >= a.extractedAt).toBe(true);
  });

  it("文面・基準・証拠・対象の SHA・観点のどれかが変われば hash が変わる", async () => {
    const { ctx, rid, tid, root, extract, c1 } = await setup();
    const h = async (o: Parameters<typeof extract>[0] = { targets: [`main:${c1}`] }) => (await extract(o)).input.hash;
    const base = await h();
    await updateTask(ctx, rid, tid, { acceptance: [{ op: "record", id: "A2", result: "unverified", evidence: "" }] });
    const ev = await h();
    expect(ev).not.toBe(base);
    await updateTask(ctx, rid, tid, { body: "本文を変えた" });
    const body = await h();
    expect(body).not.toBe(ev);
    const c2 = commit(root, "次", { "src/c.ts": "c\n" });
    expect(await h({ targets: [`main:${c2}`] })).not.toBe(body);
    writeFileSync(join(ctx.ws.dataDir, "project.yaml"), `${await import("node:fs/promises").then((f) => f.readFile(join(ctx.ws.dataDir, "project.yaml"), "utf8"))}taskReview:\n  viewpoints: 観点 A\n`);
    expect(await h({ targets: [`main:${c1}`], viewpoint: "project" })).not.toBe(body);
  });

  it("浅い履歴の境界のコミットは親を読めないので断る。worktree からも読める", async () => {
    const { root, c1, ctx, rid, tid } = await setup();
    const shallow = tempDir("p3-shallow-");
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, "c");
    const local = join(shallow, "c");
    const head = git(local, "rev-parse", "HEAD");
    const refs = ctx.ws.refs().map((r) => ({ ...r, local }));
    await expect(extractTaskReview(ctx.ws.dataDir, rid, tid, refs, { targets: [`main:${head}`] })).rejects.toMatchObject({ code: "shallow" });
    const wt = join(tempDir("p3-wt-"), "w");
    git(root, "worktree", "add", "-q", wt, c1);
    const r2 = ctx.ws.refs().map((r) => ({ ...r, local: wt }));
    const { input } = await extractTaskReview(ctx.ws.dataDir, rid, tid, r2, { targets: [`main:${c1}`] });
    expect(input.targets[0].commits[0].sha).toBe(c1);
  });
});

describe("差分と前後の中身", () => {
  it("削除・名前の変更・バイナリ・シンボリックリンク・submodule。中身を追わず、取り出さないものは注意に残す", async () => {
    const { root, extract } = await setup();
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
    symlinkSync("/etc/passwd", join(root, "link"));
    const sub = tempDir("p3-sub-");
    gitInit(sub);
    commit(sub, "sub", { "x.txt": "x\n" });
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub");
    git(root, "mv", "src/old.ts", "src/renamed.ts");
    git(root, "rm", "-q", "src/a.ts");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "いろいろ");
    const sha = git(root, "rev-parse", "HEAD");
    const { input, files } = await extract({ targets: [`main:${sha}`] });
    const ch = Object.fromEntries(input.targets[0].diffs[0].changes.map((c) => [c.path, c]));
    expect(ch["src/a.ts"]).toMatchObject({ status: "D" });
    expect(ch["src/a.ts"].baseFile).toBeTruthy();
    expect(ch["src/a.ts"].headFile).toBeUndefined();
    expect(ch["src/renamed.ts"]).toMatchObject({ status: "R", oldPath: "src/old.ts" });
    expect(ch["bin.dat"]).toMatchObject({ binary: true });
    expect(ch["link"]).toMatchObject({ symlink: true });
    expect(ch["vendor/sub"]).toMatchObject({ submodule: true });
    for (const p of ["bin.dat", "link", "vendor/sub"]) {
      expect(ch[p].headFile).toBeUndefined();
      expect(input.notes.some((n) => n.code === "omitted" && n.target === `main:${p}`)).toBe(true);
    }
    expect([...files.keys()].some((k) => k.includes("passwd") || k.includes("vendor/sub/"))).toBe(false);
  });

  it("上限を超えるファイルは切り詰めずに取り出さず未確認の範囲にする。差分の合計が上限を超えたら断る", async () => {
    const { root, extract } = await setup();
    const big = commit(root, "大きい", { "big.txt": `${"x".repeat(TASK_REVIEW_LIMITS.fileBytes + 10)}\n`.replace(/(.{100})/g, "$1\n") });
    const { input, files } = await extract({ targets: [`main:${big}`] });
    expect(input.targets[0].diffs[0].changes[0].headFile).toBeUndefined();
    expect(input.notes.some((n) => n.code === "omitted" && n.target.endsWith(":big.txt"))).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith("big.txt"))).toBe(false);
    const huge = commit(root, "巨大", { "huge.txt": "y\n".repeat(TASK_REVIEW_LIMITS.patchBytes) });
    await expect(extract({ targets: [`main:${huge}`] })).rejects.toMatchObject({ code: "too_large" });
  });

  it("材料のフォルダに置けないパスは使わない", () => {
    for (const p of ["../x", "/etc/passwd", "a/../b", "a//b", "a\\b", "a\nb", ""]) expect(safeRelPath(p), p).toBe(false);
    expect(safeRelPath("src/日本語.ts")).toBe(true);
  });
});

describe("観点", () => {
  it("固定した SHA のファイルを読む（作業ブランチで変えても選んだ SHA の文面）。project は project.yaml の設定。推測しない", async () => {
    const { root, extract, c1, ctx } = await setup();
    const v1 = commit(root, "観点", { "REVIEW.md": "観点: エラーを握りつぶさない\n" });
    commit(root, "作業ブランチで観点を変える", { "REVIEW.md": "観点: 何でも通す\n" });
    const { input } = await extract({ targets: [`main:${c1}`], viewpoint: `main@${v1}:REVIEW.md` });
    expect(input.viewpoint).toMatchObject({ source: "file", text: "観点: エラーを握りつぶさない", repo: "main", sha: v1, path: "REVIEW.md" });
    expect((await extract({ targets: [`main:${c1}`] })).input.viewpoint.source).toBe("builtin");
    await expect(extract({ targets: [`main:${c1}`], viewpoint: "project" })).rejects.toMatchObject({ code: "bad_viewpoint" });
    await expect(extract({ targets: [`main:${c1}`], viewpoint: `main@${v1}:../x` })).rejects.toMatchObject({ code: "bad_viewpoint" });
    await expect(extract({ targets: [`main:${c1}`], viewpoint: `main@${v1}:NOPE.md` })).rejects.toMatchObject({ code: "bad_viewpoint" });
    await expect(extract({ targets: [`main:${c1}`], viewpoint: "AGENTS.md" })).rejects.toBeInstanceOf(TaskReviewRejected);
    expect(ctx).toBeTruthy();
  });

  it("抽出は参照先・データのフォルダに書き込まない", async () => {
    const { root, extract, c1 } = await setup();
    const before = git(root, "status", "--porcelain", "--ignored");
    await extract({ targets: [`main:${c1}`] });
    expect(git(root, "status", "--porcelain", "--ignored")).toBe(before);
  });
});
