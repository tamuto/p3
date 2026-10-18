import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { DraftConflictError } from "../src/core/preflight/service.ts";
import {
  canSaveTitle,
  discardTitle,
  editTitle,
  startTitleSave,
  syncTitle,
  titleDraftOf,
  titleKey,
  titlePending,
  titleSaved,
  titleSaveFailed,
} from "../src/web/lib/draftTitle.ts";
import { makeProject, newRequest, openTestProject } from "./helpers.ts";

describe("タスク案の題の下書き", () => {
  it("編集していなければ取り直した題に追従する。題以外の変更（同じ題）では何も変えない", () => {
    const d = titleDraftOf("CSV を書き出す");
    expect(syncTitle(d, "CSV を書き出す")).toBe(d);
    expect(syncTitle(d, "外で直した題")).toEqual(titleDraftOf("外で直した題"));
    // フォーカス中でも、入力が基準のままなら追従する（下書きはフォーカスを見ない）
    expect(syncTitle(editTitle(d, "CSV を書き出す"), "外で直した題").value).toBe("外で直した題");
  });

  it("編集中に外で変わったら入力を残して外の最新を持ち、保存しない。捨てると最新で編集し直せる", () => {
    const d = editTitle(titleDraftOf("元の題"), "自分の入力");
    const c = syncTitle(d, "外の題");
    expect(c).toMatchObject({ value: "自分の入力", base: "元の題", external: "外の題" });
    expect(canSaveTitle(c)).toBe(false);
    expect(titlePending(c)).toBe(true);
    // さらに外で変わったら最新に差し替える。外が元に戻れば知らせを消す
    expect(syncTitle(c, "外の題2").external).toBe("外の題2");
    expect(syncTitle(c, "元の題").external).toBeNull();
    // 外でも同じ題にしたら、競合ではない
    expect(syncTitle(c, "自分の入力")).toEqual(titleDraftOf("自分の入力"));
    const fresh = discardTitle(c);
    expect(fresh).toEqual(titleDraftOf("外の題"));
    expect(canSaveTitle(editTitle(fresh, "直し直し"))).toBe(true);
  });

  it("変えていなければ欄から離れても保存しない", () => {
    const d = titleDraftOf("題");
    expect(canSaveTitle(d)).toBe(false);
    expect(canSaveTitle(editTitle(d, "題"))).toBe(false);
    expect(titlePending(d)).toBe(false);
  });

  it("保存中は重ねて保存せず、取り直しで競合にしない。保存中に打ち足した入力は成功の応答で消さない", () => {
    const d = startTitleSave(editTitle(titleDraftOf("元"), "新しい題"));
    expect(d.saving).toBe("新しい題");
    expect(canSaveTitle(d)).toBe(false);
    expect(titlePending(d)).toBe(true);
    // 自分の保存が先に取り直しに出ても、応答まで決めない
    expect(syncTitle(d, "新しい題")).toBe(d);
    const typed = editTitle(d, "新しい題（続き）");
    const saved = titleSaved(typed, "新しい題");
    expect(saved).toMatchObject({ value: "新しい題（続き）", base: "新しい題", saving: null });
    expect(canSaveTitle(saved)).toBe(true); // 続きはもう一度保存できる
  });

  it("保存の失敗では入力を残す。409 なら外の今の題を持って知らせる", () => {
    const d = startTitleSave(editTitle(titleDraftOf("元"), "自分の入力"));
    const net = titleSaveFailed(d, "保存できませんでした");
    expect(net).toMatchObject({ value: "自分の入力", base: "元", external: null, saving: null, error: "保存できませんでした" });
    expect(canSaveTitle(net)).toBe(true); // もう一度保存できる
    const conflict = titleSaveFailed(d, "他で変わりました", "外の題");
    expect(conflict).toMatchObject({ value: "自分の入力", external: "外の題" });
    expect(canSaveTitle(conflict)).toBe(false);
  });

  it("下書きは 要望 / run / 案のキー で分ける（同じキーでも別の run と混ぜない）", () => {
    expect(titleKey("261019-aaaaa", "PF-1", "D1")).not.toBe(titleKey("261019-aaaaa", "PF-2", "D1"));
    expect(titleKey("261019-aaaaa", "PF-1", "D1")).not.toBe(titleKey("261019-bbbbb", "PF-1", "D1"));
  });
});

describe("タスク案の題の保存（期待値の比べ）", () => {
  async function setup() {
    const p = await makeProject();
    const req = await newRequest(p.ctx, { title: "Add export", body: "- CSV を書き出す\n- 画面にボタンを置く" });
    const { id } = await p.ctx.preflight.start(req.id, { engine: "mock" });
    await p.ctx.preflight.wait(req.id, id);
    const api = apiRoutes(p.ctx);
    const patch = (body: object) =>
      api.request(`/requests/${req.id}/preflight/${id}/drafts/D1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const file = join(p.dataDir, "requests", req.id, "preflight", id, "drafts", "D1.md");
    // 外の CLI（別の Workspace）
    const cli = await openTestProject(p.dataDir);
    return { ...p, req, id, patch, file, cli };
  }

  it("画面が取り直す前に外で題が変わっていたら、期待値つきの保存は 409 で書かず、外の題を残す", async () => {
    const { req, id, patch, file, cli } = await setup();
    const before = (await cli.preflight.get(req.id, id))!.drafts[0];
    await cli.preflight.updateDraft(req.id, id, "D1", { title: "外で直した題", include: false });
    const r = await patch({ title: "画面の入力", expectedTitle: before.title });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { code: string; current: { title: string; include: boolean } };
    expect(body.code).toBe("rev_conflict");
    expect(body.current).toMatchObject({ title: "外で直した題", include: false });
    expect(await readFile(file, "utf8")).toContain("title: 外で直した題");
    expect(await readFile(file, "utf8")).not.toContain("expectedTitle");
  });

  it("今の題を期待値にすれば保存でき、ほかの項目（採否・本文）の今の値は残す", async () => {
    const { req, id, patch, file, cli } = await setup();
    await cli.preflight.updateDraft(req.id, id, "D1", { title: "外で直した題", include: false, description: "外で直した本文" });
    const r = await patch({ title: "画面の入力", expectedTitle: "外で直した題" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ title: "画面の入力", include: false, description: "外で直した本文" });
    const text = await readFile(file, "utf8");
    expect(text).toContain("title: 画面の入力");
    expect(text).toContain("include: false");
    expect(text).not.toContain("expectedTitle");
  });

  it("期待値を渡さない内部の呼び出し（CLI など）は今までどおり確かめない", async () => {
    const { ctx, req, id } = await setup();
    await expect(ctx.preflight.updateDraft(req.id, id, "D1", { title: "x" }, { expectedTitle: "違う題" })).rejects.toThrow(DraftConflictError);
    await expect(ctx.preflight.updateDraft(req.id, id, "D1", { title: "y" })).resolves.toMatchObject({ title: "y" });
  });
});
