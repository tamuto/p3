import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { Workspace } from "../src/core/store/workspace.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import {
  applyGenerated,
  asNew,
  confirmBeforeReplace,
  conflicted,
  discardNote,
  editNote,
  noteDraftOf,
  saveArgs,
  savedNote,
  syncNote,
  type NoteState,
} from "../src/web/lib/releaseNoteDraft.ts";
import type { Summarizer } from "../src/core/releaseNotes/generate.ts";
import { makeRepo, newRequest, newTask, openTestProject } from "./helpers.ts";

/** 画面の API（app.request で呼ぶ。serve は起動しない） */
async function setup(summarizer?: Summarizer) {
  const repo = await makeRepo({ milestones: [{ id: "v1", title: "最初のリリース" }, { id: "v2", title: "次" }] });
  const ctx = await openTestProject(repo.dataDir, undefined, { summarizer });
  const app = apiRoutes(ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json", "x-p3-actor": "human:web" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const events: ServerEvent[] = [];
  ctx.ws.on((e) => events.push(e));
  const a = await newRequest(ctx, { title: "検索", status: "done", milestone: "v1" });
  await newTask(ctx, a.id, { title: "索引", status: "done", record: "検索の索引を足した" });
  const b = await newRequest(ctx, { title: "途中", status: "active", milestone: "v1" });
  return { ...repo, ctx, call, events, a: a.id, b: b.id };
}

const waitDone = async (call: Awaited<ReturnType<typeof setup>>["call"], id: string) => {
  for (let i = 0; i < 200; i++) {
    const g = (await call("GET", `/release-generations/${id}`)).body;
    if (g.status !== "running") return g;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("終わりません");
};

describe("リリースノートの API", () => {
  it("一覧・詳細・保存・版の競合・本文のダウンロード。保存は要望の状態を変えない", async () => {
    const { call, a, b, events, ctx } = await setup();
    const list = (await call("GET", "/release-notes")).body;
    expect(list.milestones.map((m: any) => [m.milestone, m.requests, m.note.state])).toEqual([
      // 登録の順（v1, v2）ではなく、ID のバージョンの降順
      ["v2", 0, "none"],
      ["v1", 2, "none"],
    ]);
    const d = (await call("GET", "/release-notes/v1")).body;
    expect(d).toMatchObject({ note: null, noteError: null, materialChanged: false });
    expect(d.material.requests.map((r: any) => [r.id, r.included])).toEqual([
      [a, true],
      [b, false],
    ]);

    const created = await call("PUT", "/release-notes/v1", { body: "- 検索が速くなった", basedOn: d.material.hash });
    expect(created.status).toBe(200);
    expect(created.body.note).toMatchObject({ milestone: "v1", body: "- 検索が速くなった", createdBy: "human:web" });
    expect(events).toContainEqual({ type: "changed", kind: "release-note", milestone: "v1" });
    const v1 = created.body.note.version;

    // 版なしの新規は既にあるので 409、古い版も 409（今のノートを添える）
    expect((await call("PUT", "/release-notes/v1", { body: "x" })).body).toMatchObject({ code: "rev_conflict", reason: "exists" });
    const ok = await call("PUT", "/release-notes/v1", { body: "- 直した", version: v1 });
    expect(ok.status).toBe(200);
    const stale = await call("PUT", "/release-notes/v1", { body: "古い版から", version: v1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "rev_conflict", reason: "conflict", current: { body: "- 直した", version: ok.body.note.version } });

    const exp = await call("GET", "/release-notes/v1/export");
    expect(exp.text).toBe("- 直した\n");
    expect(exp.headers.get("content-disposition")).toContain('filename="release-notes-v1.md"');
    expect(exp.headers.get("content-type")).toContain("text/markdown");
    expect(ctx.ws.requests.get(a)!.status).toBe("done");
    expect(ctx.ws.project.milestones.find((m) => m.id === "v1")!.done).toBeUndefined();
  });

  it("入力の誤り・無いもの・使えない ID・読めないノート", async () => {
    const { call, dataDir } = await setup();
    expect((await call("PUT", "/release-notes/v1", { title: "本文なし" })).status).toBe(400);
    expect((await call("GET", "/release-notes/nope")).status).toBe(404);
    expect((await call("GET", "/release-notes/v2/export")).status).toBe(404);
    expect((await call("PUT", "/release-notes/v1", { body: "x", version: "0".repeat(64) })).status).toBe(404); // まだ無いものの更新
    expect((await call("GET", "/release-notes/..")).status).toBe(404); // パスとしては解決されない
    expect((await call("GET", "/release-notes/a%2Fb")).body).toMatchObject({ code: "bad_id" });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(`${dataDir}/release-notes`, { recursive: true });
    await writeFile(`${dataDir}/release-notes/v2.md`, "---\n: [\n---\n");
    const d = (await call("GET", "/release-notes/v2")).body;
    expect(d.note).toBeNull();
    expect(d.noteError).toContain("読めません");
    expect((await call("PUT", "/release-notes/v2", { body: "新しく" })).body).toMatchObject({ code: "rev_conflict", reason: "exists", current: null });
  });

  it("生成の開始・終わり・取り消し・失敗と、材料が無いときの断り。生成は保存しない", async () => {
    let release: () => void = () => {};
    let fail = false;
    const fake: Summarizer = {
      ask: (input, _log, signal) =>
        new Promise((res, rej) => {
          signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
          release = () => {
            if (fail) return rej(new Error("Codex が落ちました"));
            const refs = [...input.prompt.matchAll(/"ref": "([^"]+)"/g)].map((m) => m[1]);
            res({ message: JSON.stringify({ items: [{ text: "検索が速くなった", sources: refs }] }), seconds: 0 });
          };
        }),
    };
    const { call, events, ctx } = await setup(fake);
    const started = await call("POST", "/release-notes/v1/generate", {});
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "running", milestone: "v1", engine: "codex" });
    expect((await call("POST", "/release-notes/v1/generate", {})).body).toMatchObject({ code: "running" });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const done = await waitDone(call, started.body.id);
    expect(done).toMatchObject({ status: "completed", markdown: "## 最初のリリース\n\n- 検索が速くなった", materialChanged: false });
    expect(events.filter((e) => e.type === "release-generation").map((e: any) => e.status)).toEqual(["running", "completed"]);
    expect(await ctx.ws.releaseNotes.ids()).toEqual([]);

    // 取り消し
    const c = (await call("POST", "/release-notes/v1/generate", {})).body;
    await new Promise((r) => setTimeout(r, 10));
    expect((await call("POST", `/release-generations/${c.id}/cancel`, {})).body).toEqual({ cancelled: true });
    expect(await waitDone(call, c.id)).toMatchObject({ status: "cancelled" });

    // 失敗（再試行できる）
    fail = true;
    const f = (await call("POST", "/release-notes/v1/generate", {})).body;
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await waitDone(call, f.id)).toMatchObject({ status: "failed", failure: "error", error: "Codex が落ちました" });
    expect((await call("GET", "/release-notes/v1/generations")).body.map((g: any) => g.id)).toEqual([f.id, c.id, started.body.id]);

    // 材料なし・Mock・無い生成
    expect((await call("POST", "/release-notes/v2/generate", {})).body).toMatchObject({ code: "no_material" });
    const m = (await call("POST", "/release-notes/v1/generate", { engine: "mock" })).body;
    expect(await waitDone(call, m.id)).toMatchObject({ status: "completed", engine: "mock" });
    expect((await call("GET", "/release-generations/RG-x")).status).toBe(404);
    expect(await ctx.ws.releaseNotes.ids()).toEqual([]);
  });

  it("保存のあとで材料が変わると知らせ、CLI での保存は監視なしでも詳細の取り直しで見える", async () => {
    const { call, a, dataDir } = await setup();
    const d = (await call("GET", "/release-notes/v1")).body;
    await call("PUT", "/release-notes/v1", { body: "画面で書いた", basedOn: d.material.hash });
    const cli = new Workspace(dataDir);
    await cli.load();
    await cli.tasksOf(a).update("T001", { record: "CLI で直した記録" });
    const after = (await call("GET", "/release-notes/v1")).body;
    expect(after.materialChanged).toBe(true);
    const cur = await cli.releaseNotes.read("v1");
    await cli.releaseNotes.update("v1", { body: "CLI で直した本文" }, cur.version);
    expect((await call("GET", "/release-notes/v1")).body.note.body).toBe("CLI で直した本文");
    // 古い材料の hash で保存すると知らせる
    const saved = await call("PUT", "/release-notes/v1", { body: "x", basedOn: d.material.hash, version: (await cli.releaseNotes.read("v1")).version });
    expect(saved.body.warnings.map((w: any) => w.code)).toEqual(["material_changed"]);
  });
});

describe("画面の本文の下書き（releaseNoteDraft）", () => {
  const note = (body: string, version: string) => ({ body, version, updatedAt: "2026-10-13T00:00:00Z", updatedBy: "human:x" });
  const S = (n: ReturnType<typeof note> | null, noteError: string | null = null): NoteState => ({ note: n, noteError });

  it("編集していなければ追従し、編集中の外の変更・削除・読めないは入力を残して知らせる。保存は編集を始めた版で", () => {
    const d0 = noteDraftOf(S(note("最初", "v1")));
    expect(syncNote(d0, S(note("最初", "v1")))).toBe(d0);
    expect(syncNote(d0, S(note("外で", "v2")))).toEqual(noteDraftOf(S(note("外で", "v2"))));

    const e = editNote(d0, "入力中");
    const changed = syncNote(e, S(note("外で", "v2")));
    expect(changed).toMatchObject({ value: "入力中", baseVersion: "v1", external: { kind: "changed", note: { version: "v2" } } });
    expect(saveArgs(changed)).toEqual({ body: "入力中", version: "v1" }); // 最新の版に差し替えない
    expect(syncNote(e, S(null))).toMatchObject({ value: "入力中", external: { kind: "deleted" } });
    expect(syncNote(e, S(null, "壊れています"))).toMatchObject({ value: "入力中", external: { kind: "invalid", error: "壊れています" } });
    expect(syncNote(e, S(note("最初", "v1")))).toBe(e);
    // 捨てると今の状態に
    expect(discardNote(S(note("外で", "v2")))).toEqual(noteDraftOf(S(note("外で", "v2"))));
  });

  it("新規・読めないノート・競合・作り直し・生成の取り込み", () => {
    const n = noteDraftOf(S(null));
    expect(saveArgs(editNote(n, "新しく"))).toEqual({ body: "新しく" });
    // 読めないファイルは空の新規として扱わず知らせる
    expect(noteDraftOf(S(null, "読めません"))).toMatchObject({ value: "", baseVersion: null, external: { kind: "invalid" } });
    // 新規の編集中に外で作られた
    expect(syncNote(editNote(n, "新しく"), S(note("外で作った", "v1")))).toMatchObject({ external: { kind: "changed" }, baseVersion: null });

    const c = conflicted(editNote(noteDraftOf(S(note("a", "v1"))), "b"), note("外", "v3"));
    expect(c).toMatchObject({ value: "b", baseVersion: "v1", external: { kind: "changed", note: { version: "v3" } } });
    expect(conflicted(c, null).external).toEqual({ kind: "deleted" });
    // 消えたノートを今の入力で作り直すのは人が選んだとき
    expect(saveArgs(asNew(conflicted(c, null)))).toEqual({ body: "b" });
    expect(savedNote(note("b", "v4"))).toEqual(noteDraftOf(S(note("b", "v4"))));

    // 生成の取り込み: 未保存の入力があれば確かめる。版は変えない
    expect(confirmBeforeReplace(noteDraftOf(S(note("a", "v1"))))).toBe(false);
    expect(confirmBeforeReplace(editNote(noteDraftOf(S(note("a", "v1"))), "直した"))).toBe(true);
    expect(confirmBeforeReplace(editNote(n, "  "))).toBe(false);
    expect(applyGenerated(noteDraftOf(S(note("a", "v1"))), "## 案")).toMatchObject({ value: "## 案", baseVersion: "v1" });
  });
});
