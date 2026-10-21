import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMilestoneRemoval, OpRuleError } from "../src/core/requestOps.ts";
import { extractMaterial } from "../src/core/releaseNotes/material.ts";
import { exportReleaseNote, releaseMaterial, releaseNoteDetail, releaseOverview, saveReleaseNote } from "../src/core/releaseNotes/service.ts";
import { ReleaseNoteError, ReleaseNoteStore } from "../src/core/releaseNotes/store.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import { apiRoutes } from "../src/server/api/routes.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

const MS = [
  { id: "v1", title: "最初のリリース" },
  { id: "v2", title: "次" },
];

async function setup() {
  const p = await makeProject({ milestones: MS });
  /** 要望とタスクを作る（作成日時の順を決めるため1件ずつ） */
  const add = async (title: string, status: string, tasks: { status: string; record?: string }[], milestone = "v1") => {
    // 作成日時が同じミリ秒にならないように（同じなら ID の順になる）
    await new Promise((r) => setTimeout(r, 3));
    const r = await newRequest(p.ctx, { title, status: status as never, milestone });
    for (const [i, t] of tasks.entries()) await newTask(p.ctx, r.id, { title: `${title}-${i + 1}`, status: t.status as never, record: t.record });
    return r.id;
  };
  return { ...p, add };
}

const codes = (ws: { code: string; target: string }[]) => ws.map((w) => `${w.code}:${w.target}`);

/** 要望のフォルダと frontmatter の ID・作成日時を決め打ちの値に直す（材料はファイルから読み直すので、これで効く） */
async function relabel(dataDir: string, from: string, to: string, createdAt: string): Promise<string> {
  if (from !== to) await rename(join(dataDir, "requests", from), join(dataDir, "requests", to));
  const file = join(dataDir, "requests", to, "request.md");
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(/^id: .*$/m, `id: ${to}`).replace(/^createdAt: .*$/m, `createdAt: ${createdAt}`));
  return to;
}

describe("リリースノートの材料（マイルストーンごと）", () => {
  it("状態と所属で収録を分け、未完了・記録なし・タスクなし・状態の食い違いを警告する", async () => {
    const { ctx, add, dataDir } = await setup();
    const ok = await add("検索", "resolved", [{ status: "done", record: "索引を足した" }, { status: "done" }]);
    const done = await add("一覧", "done", [{ status: "done", record: "並びを直した" }]);
    const active = await add("途中", "active", [{ status: "doing" }]);
    const rejected = await add("見送り", "rejected", [{ status: "todo" }]);
    const empty = await add("空", "resolved", []);
    const mismatch = await add("食い違い", "done", [{ status: "done", record: "x" }, { status: "todo" }]);
    const noRecord = await add("記録なし", "resolved", [{ status: "done" }]);
    await add("他のマイルストーン", "done", [{ status: "done", record: "y" }], "v2");
    await newRequest(ctx, { title: "所属なし", status: "done" });

    const m = await extractMaterial(dataDir, "v1");
    expect(m.milestone).toMatchObject({ id: "v1", title: "最初のリリース", known: true });
    expect(m.requests.map((r) => [r.id, r.included, r.reason ?? ""])).toEqual([
      [ok, true, ""],
      [done, true, ""],
      [active, false, "未完了（active）"],
      [rejected, false, "見送り"],
      [empty, false, "タスクが無い"],
      [mismatch, false, "完了していないタスクがある"],
      [noRecord, true, ""],
    ]);
    // 見送りは理由だけ（警告しない）
    expect(m.requests.find((r) => r.id === rejected)!.warnings).toEqual([]);
    expect(m.requests.flatMap((r) => codes(r.warnings))).toEqual([
      `missing_record:${ok}/T002`,
      `not_finished:${active}`,
      `no_tasks:${empty}`,
      `open_tasks:${mismatch}`,
      `missing_record:${noRecord}/T001`,
      `no_material:${noRecord}`,
    ]);
    // 要約の材料は収録する要望の、記録のある完了したタスクだけ
    expect(m.sources).toEqual([
      { request: ok, title: "検索", status: "resolved", tasks: [{ id: "T001", title: "検索-1", status: "done", record: "索引を足した" }] },
      { request: done, title: "一覧", status: "done", tasks: [{ id: "T001", title: "一覧-1", status: "done", record: "並びを直した" }] },
      { request: noRecord, title: "記録なし", status: "resolved", tasks: [] },
    ]);
    expect(m.warnings).toEqual([]);
  });

  it("候補ゼロ・材料ゼロを明示し、読めない要望は全体の警告、読めないタスクは要望の警告に残す。アーカイブは外す", async () => {
    const { ctx, add, dataDir } = await setup();
    expect(codes((await extractMaterial(dataDir, "v1")).warnings)).toEqual(["no_candidates:v1"]);

    const a = await add("記録なし", "done", [{ status: "done" }]);
    expect(codes((await extractMaterial(dataDir, "v1")).warnings)).toEqual(["no_sources:v1"]);

    const b = await add("壊れたタスク", "done", [{ status: "done", record: "r" }]);
    await writeFile(join(dataDir, "requests", b, "tasks", "T002.md"), "---\n: [\n---\n");
    const c = await add("アーカイブする", "done", [{ status: "done", record: "r" }]);
    await ctx.ws.requests.archive(c);
    await mkdir(join(dataDir, "requests", "261001-zzzzz"), { recursive: true });
    await writeFile(join(dataDir, "requests", "261001-zzzzz", "request.md"), "---\n: [\n---\n");

    const m = await extractMaterial(dataDir, "v1");
    expect(m.requests.map((r) => r.id)).toEqual([a, b]);
    expect(codes(m.requests[1].warnings)).toEqual([`broken_task:${b}`]);
    expect(codes(m.warnings)).toEqual(["broken_request:requests/261001-zzzzz/request.md", "no_sources:v1"]);
  });

  it("並びは作成日時 → ID（数字の部分は数として比べる）、タスクは ID の順で、同じ材料なら hash も同じ。変わると hash が変わる", async () => {
    const { add, dataDir } = await setup();
    // ID と作成日時を決め打ちにする（乱数の ID の組で結果が変わらないように）。8nda1 と 88d8b は、数字を数として比べると
    // 8 < 88 で 8nda1 が先、既定の文字列の比べ方なら "8" + "8" < "8" + "n" で 88d8b が先になる組
    const first = await relabel(dataDir, await add("先に作った", "done", [{ status: "done", record: "1" }]), "261019-88d8b", "2026-10-19T01:00:00.000Z");
    const second = await relabel(dataDir, await add("後に作った", "done", [{ status: "done", record: "2" }]), "261019-8nda1", "2026-10-19T01:00:00.000Z");
    const m1 = await extractMaterial(dataDir, "v1");
    // 作成日時が同じなら ID の順（数字の部分は数として）
    expect(m1.requests.map((r) => r.id)).toEqual(["261019-8nda1", "261019-88d8b"]);
    expect(m1.sources.map((x) => x.request)).toEqual(["261019-8nda1", "261019-88d8b"]);
    expect((await extractMaterial(dataDir, "v1")).hash).toBe(m1.hash);

    // 作成日時が違えば、ID より作成日時（88d8b を先にする）
    await relabel(dataDir, first, first, "2026-10-19T00:00:00.000Z");
    const m2 = await extractMaterial(dataDir, "v1");
    expect(m2.requests.map((r) => r.id)).toEqual(["261019-88d8b", "261019-8nda1"]);
    expect(m2.hash).not.toBe(m1.hash);

    const ext = new Workspace(dataDir);
    await ext.load();
    await ext.tasksOf(second).update("T001", { record: "2 に直した" });
    expect((await extractMaterial(dataDir, "v1")).hash).not.toBe(m2.hash);
  });

  it("project.yaml に無く、ノートも無いマイルストーンは見つからない。ID が保存先の外を指すものは断る", async () => {
    const { ctx } = await setup();
    await expect(releaseMaterial(ctx, "nope")).rejects.toMatchObject({ code: "not_found" });
    for (const bad of ["..", ".", "../x", "a/b", "a\\b", ""]) {
      await expect(releaseMaterial(ctx, bad)).rejects.toMatchObject({ code: "bad_id" });
      expect(() => ctx.ws.releaseNotes.path(bad)).toThrow(ReleaseNoteError);
    }
  });
});

describe("リリースノートの保存", () => {
  it("新規保存・読み直し・本文の出力。出典は frontmatter、出力は本文だけ。重複作成は exists", async () => {
    const { ctx, add, dataDir } = await setup();
    const rid = await add("検索", "done", [{ status: "done", record: "索引を足した" }]);
    const detail0 = await releaseNoteDetail(ctx, "v1");
    expect(detail0).toMatchObject({ note: null, noteError: null, materialChanged: false });

    const { note, warnings } = await saveReleaseNote(ctx, "v1", { body: "## 新機能\n\n- 検索が速くなった", basedOn: detail0.material.hash }, "human:test");
    expect(warnings).toEqual([]);
    expect(note).toMatchObject({ milestone: "v1", title: "最初のリリース", createdBy: "human:test", materialHash: detail0.material.hash });
    expect(note.sources).toEqual([{ request: rid, title: "検索", status: "done", tasks: [{ id: "T001", title: "検索-1", status: "done", record: "索引を足した" }] }]);

    const file = await readFile(join(dataDir, "release-notes", "v1.md"), "utf8");
    expect(file).toMatch(/^---\nmilestone: v1\n/);
    expect(file).toContain("record: 索引を足した");
    const out = await exportReleaseNote(ctx, "v1");
    expect(out).toBe("## 新機能\n\n- 検索が速くなった\n");
    expect(out).not.toContain("索引を足した");

    // 別のプロセスから読んでも同じ
    const again = await new ReleaseNoteStore(dataDir).read("v1");
    expect(again).toEqual(note);
    await expect(saveReleaseNote(ctx, "v1", { body: "上書き" })).rejects.toMatchObject({ code: "exists" });
    expect((await ctx.ws.releaseNotes.read("v1")).body).toBe("## 新機能\n\n- 検索が速くなった");
  });

  it("更新は版が必須。直接編集（rev を増やさない書き換え）や同時の更新は conflict で何も書かない", async () => {
    const { ctx, add, dataDir } = await setup();
    await add("検索", "done", [{ status: "done", record: "r" }]);
    const { note } = await saveReleaseNote(ctx, "v1", { body: "画面で書いた" });
    const path = join(dataDir, "release-notes", "v1.md");

    // 直接編集（エディタ）
    const edited = (await readFile(path, "utf8")).replace("画面で書いた", "エディタで直した");
    await writeFile(path, edited);
    await expect(saveReleaseNote(ctx, "v1", { body: "画面で直した", version: note.version })).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(path, "utf8")).toBe(edited);

    // 同時の更新（同じ版から2つ）: 片方だけが通る
    const cur = await ctx.ws.releaseNotes.read("v1");
    const results = await Promise.allSettled([
      saveReleaseNote(ctx, "v1", { body: "A", version: cur.version }),
      new ReleaseNoteStore(dataDir).update("v1", { body: "B" }, cur.version),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "conflict" });
    const after = await ctx.ws.releaseNotes.read("v1");
    expect(["A", "B"]).toContain(after.body);
    expect(after.createdAt).toBe(note.createdAt);

    // 消されたノートの更新は not_found
    await rm(path);
    await expect(saveReleaseNote(ctx, "v1", { body: "C", version: after.version })).rejects.toMatchObject({ code: "not_found" });
  });

  it("要望・タスクが変わっても保存した本文と出典は変わらず、材料の変更を知らせる", async () => {
    const { ctx, add } = await setup();
    const rid = await add("検索", "done", [{ status: "done", record: "索引を足した" }]);
    const before = await releaseMaterial(ctx, "v1");
    const { note } = await saveReleaseNote(ctx, "v1", { body: "- 検索が速くなった", basedOn: before.hash });

    await ctx.ws.tasksOf(rid).update("T001", { record: "索引と並びを直した" });
    await ctx.ws.requests.update(rid, { title: "検索 2" });
    const d = await releaseNoteDetail(ctx, "v1");
    expect(d.materialChanged).toBe(true);
    expect(d.note).toEqual(note);
    // 古い材料の hash で保存すると知らせる（保存はする）
    const saved = await saveReleaseNote(ctx, "v1", { body: "- 直した", basedOn: before.hash, version: note.version });
    expect(codes(saved.warnings)).toEqual(["material_changed:v1"]);
    expect(saved.note.sources[0]).toMatchObject({ title: "検索 2", tasks: [{ record: "索引と並びを直した" }] });
    expect((await releaseNoteDetail(ctx, "v1")).materialChanged).toBe(false);
  });

  it("読めないノートは空のノートとして扱わず、上書きもしない", async () => {
    const { ctx, dataDir } = await setup();
    await mkdir(join(dataDir, "release-notes"), { recursive: true });
    await writeFile(join(dataDir, "release-notes", "v1.md"), "---\nmilestone: v9\ncreatedAt: x\nupdatedAt: x\n---\n本文");
    const d = await releaseNoteDetail(ctx, "v1");
    expect(d.note).toBeNull();
    expect(d.noteError).toContain("milestone が");
    await expect(saveReleaseNote(ctx, "v1", { body: "新しく" })).rejects.toMatchObject({ code: "exists" });
    const o = await releaseOverview(ctx);
    expect(o.milestones.find((m) => m.milestone === "v1")!.note.state).toBe("invalid");
  });
});

describe("マイルストーンの削除の保護と、消えたマイルストーンのノート", () => {
  it("ノートのあるマイルストーンは CLI の経路（checkMilestoneRemoval）でも API の設定全体の更新でも消せない", async () => {
    const { ctx, add } = await setup();
    const rid = await add("検索", "done", [{ status: "done", record: "r" }]);
    await ctx.ws.requests.update(rid, { milestone: "v2" });
    await saveReleaseNote(ctx, "v1", { body: "手で書いた" });

    await expect(checkMilestoneRemoval(ctx, ["v2"])).rejects.toThrow(/リリースノートのあるマイルストーンは消せません: v1/);
    await expect(checkMilestoneRemoval(ctx, ["v1"])).rejects.toThrow(/使用中のマイルストーンは消せません: v2（要望 1 件）/);
    await expect(checkMilestoneRemoval(ctx, ["v1"])).rejects.toBeInstanceOf(OpRuleError);
    await expect(checkMilestoneRemoval(ctx, ["v1", "v2"])).resolves.toBeUndefined();

    const app = apiRoutes(ctx);
    const put = async (milestones: unknown) => {
      const res = await app.request("/project", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ milestones }) });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    const r = await put([MS[1]]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("リリースノートのあるマイルストーンは消せません: v1");
    expect(ctx.ws.project.milestones.map((m) => m.id)).toEqual(["v1", "v2"]);
  });

  it("直接編集でマイルストーンが消えても、ノートを一覧・閲覧でき、孤立を警告する（状態は変えない）", async () => {
    const { ctx, add, dataDir } = await setup();
    await add("検索", "done", [{ status: "done", record: "r" }]);
    await saveReleaseNote(ctx, "v1", { body: "残る本文" });
    const yaml = await readFile(join(dataDir, "project.yaml"), "utf8");
    await writeFile(join(dataDir, "project.yaml"), yaml.replace(/\n {2}- id: v1\n {4}title: 最初のリリース/, ""));
    await ctx.ws.reloadAll();
    expect(ctx.ws.project.milestones.map((m) => m.id)).toEqual(["v2"]);

    const o = await releaseOverview(ctx);
    expect(o.milestones.map((m) => [m.milestone, m.known, m.note.state])).toEqual([
      ["v2", true, "none"],
      ["v1", false, "ok"],
    ]);
    expect(codes(o.warnings)).toEqual(["unknown_milestone:v1"]);
    const d = await releaseNoteDetail(ctx, "v1");
    expect(d.note?.body).toBe("残る本文");
    expect(codes(d.material.warnings)).toContain("unknown_milestone:v1");
    expect(await exportReleaseNote(ctx, "v1")).toBe("残る本文\n");
  });

  it("一覧は登録したマイルストーンを ID のバージョンの降順に、その後ろに登録に無いノートを同じ降順に並べる（登録の順は変えない）", async () => {
    const { ctx, add } = await setup();
    await add("検索", "done", [{ status: "done", record: "r" }]);
    await saveReleaseNote(ctx, "v1", { body: "1" });
    await saveReleaseNote(ctx, "v2", { body: "2" });
    // 桁の違う ID を登録の順で並べ、v1・v2 は登録から外す（ノートは残る）
    await ctx.ws.saveProject({ milestones: [{ id: "0.9", title: "九" }, { id: "0.10", title: "十" }] });
    const o = await releaseOverview(ctx);
    expect(o.milestones.map((m) => [m.milestone, m.known, m.note.state])).toEqual([
      ["0.10", true, "none"],
      ["0.9", true, "none"],
      ["v2", false, "ok"],
      ["v1", false, "ok"],
    ]);
    expect(codes(o.warnings)).toEqual(["unknown_milestone:v2", "unknown_milestone:v1"]);
    expect(ctx.ws.project.milestones.map((m) => m.id)).toEqual(["0.9", "0.10"]);
  });
});

describe("監視と再読み込み", () => {
  it("ノートの作成・直接編集・削除を監視が知らせる（ロックのファイルは知らせない）", async () => {
    const { ctx, add, dataDir } = await setup();
    await add("検索", "done", [{ status: "done", record: "r" }]);
    const events: ServerEvent[] = [];
    ctx.ws.on((e) => events.push(e));
    await mkdir(join(dataDir, "release-notes"), { recursive: true });
    void ctx.ws.watch();
    await new Promise((r) => setTimeout(r, 100));
    const seen = async (n: number) => {
      for (let i = 0; i < 60 && events.filter((e) => e.type === "changed" && e.kind === "release-note").length < n; i++) await new Promise((r) => setTimeout(r, 50));
      return events.filter((e) => e.type === "changed" && e.kind === "release-note");
    };
    try {
      // 別のプロセス（CLI）が保存する
      const other = new Workspace(dataDir);
      await other.load();
      await other.releaseNotes.create("v1", { title: "t", body: "外で作った", sources: [] });
      expect(await seen(1)).toContainEqual({ type: "changed", kind: "release-note", milestone: "v1" });
      events.length = 0;
      await rm(join(dataDir, "release-notes", "v1.md"));
      expect(await seen(1)).toContainEqual({ type: "changed", kind: "release-note", milestone: "v1" });
    } finally {
      ctx.ws.close();
    }
    expect(events.some((e) => e.type === "changed" && e.kind === "release-note" && e.milestone.startsWith("."))).toBe(false);
  });

  it("ディスクから読むので、再読み込みのあとも外での変更がそのまま見える", async () => {
    const { ctx, add, dataDir } = await setup();
    await add("検索", "done", [{ status: "done", record: "r" }]);
    await saveReleaseNote(ctx, "v1", { body: "画面で書いた" });
    const path = join(dataDir, "release-notes", "v1.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("画面で書いた", "外で直した"));
    await ctx.ws.reloadAll();
    expect((await releaseNoteDetail(ctx, "v1")).note?.body).toBe("外で直した");
    await rm(path);
    expect((await releaseNoteDetail(ctx, "v1")).note).toBeNull();
    expect((await releaseOverview(ctx)).milestones[0].note).toEqual({ state: "none" });
  });
});
