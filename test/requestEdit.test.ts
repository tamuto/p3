import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { ApiError } from "../src/web/lib/api.ts";
import { discardDraft, draftOf, editDraft, isDirty, sameBody, syncFieldDraft } from "../src/web/lib/draft.ts";
import { bodySaveErrorText, excerpt, materializeErrorText, staleNotice, UNSAVED_BLOCKED, unsavedFields } from "../src/web/lib/requestEdit.ts";
import { makeProject, newRequest } from "./helpers.ts";

describe("要望の本文の下書き（タイトル・タグと同じ rev を共有する）", () => {
  it("編集中に rev が上がっても、本文が変わっていなければ競合にせず baseRev を進める（ステータス・タイトルの保存・Preflight）", () => {
    const d = editDraft(draftOf("本文", 3), "書きかけ");
    const s = syncFieldDraft(d, "本文\n", 5, sameBody); // 保存の形（末尾の改行）だけの違いは同じ
    expect(s).toEqual({ value: "書きかけ", base: "本文", baseRev: 5, external: null });
  });

  it("本文が外で変わったら入力を残して知らせ、最新の rev には差し替えない（保存すると競合）", () => {
    const d = editDraft(draftOf("本文", 3), "書きかけ");
    const s = syncFieldDraft(d, "外で変えた", 4, sameBody);
    expect(s).toEqual({ value: "書きかけ", base: "本文", baseRev: 3, external: { value: "外で変えた", rev: 4 } });
    // 知らせた後に別の項目が変わっても、黙って進めない
    expect(syncFieldDraft(s, "本文", 6, sameBody).baseRev).toBe(3);
    // 入力を捨てると最新にする
    expect(discardDraft(s)).toEqual(draftOf("外で変えた", 4));
  });

  it("古い応答は無視し、編集していなければ取り直した値に追従する", () => {
    const d = editDraft(draftOf("本文", 3), "書きかけ");
    expect(syncFieldDraft(d, "古い", 2, sameBody)).toBe(d);
    expect(syncFieldDraft(draftOf("本文", 3), "新しい", 4, sameBody)).toEqual(draftOf("新しい", 4));
  });

  it("空の本文・改行の形と前後の空白は、保存と同じ比べ方", () => {
    expect(isDirty(editDraft(draftOf("本文", 1), ""), sameBody)).toBe(true);
    expect(isDirty(editDraft(draftOf("a\nb", 1), "a\r\nb\n"), sameBody)).toBe(false);
    expect(isDirty(editDraft(draftOf("a\nb", 1), "a  \nb"), sameBody)).toBe(true);
  });
});

describe("Preflight とタスク化を止める・知らせる", () => {
  it("未保存のタイトル・本文があれば止める", () => {
    expect(unsavedFields({ title: false, body: false })).toEqual([]);
    expect(unsavedFields({ title: true, body: true })).toEqual(["タイトル", "本文"]);
    expect(UNSAVED_BLOCKED).toContain("保存するかキャンセルしてください");
  });

  it("評価対象と今の要望の食い違い。タスク化済みの run は取り消したように見せない", () => {
    expect(staleNotice({ status: "same" }, { done: false })).toBeNull();
    expect(staleNotice(undefined, { done: false })).toBeNull();
    const before = staleNotice({ status: "changed", changed: ["body"] }, { done: false })!;
    expect(before.title).toBe("表示中の評価と今の要望が違います");
    expect(before.text).toContain("要望の本文が変わりました");
    expect(before.text).toContain("タスク化できません");
    const after = staleNotice({ status: "changed", changed: ["title", "body"] }, { done: true })!;
    expect(after.text).toContain("タイトルと本文");
    expect(after.text).toContain("タスク化は済んでいます");
    expect(after.text).not.toContain("タスク化できません");
    expect(staleNotice({ status: "unknown", reason: "request.md がない" }, { done: false })!.text).toContain("request.md がない");
  });

  it("タスク化の 409 は code で分ける。本文の保存の失敗は入力を残すと伝える", () => {
    expect(materializeErrorText(new ApiError(409, "評価のあとで要望の本文が変わりました…", { code: "stale_input" }))).toBe("評価のあとで要望の本文が変わりました…");
    expect(materializeErrorText(new ApiError(409, "rev conflict", { code: "rev_conflict" }))).toContain("置き換えられるタスクが他で更新されました");
    expect(materializeErrorText(new Error("ほか"))).toBe("ほか");
    expect(bodySaveErrorText(new ApiError(409, "", {}))).toContain("入力は残してあります");
    expect(bodySaveErrorText(new ApiError(404, "", {}))).toContain("見つからない");
    expect(bodySaveErrorText(new Error("network"))).toContain("入力は残してあります");
    expect(excerpt("a\n".repeat(100), 10)).toBe("a a a a a …");
    expect(excerpt("")).toBe("（空）");
  });
});

describe("画面の保存と再評価（API を通して）", () => {
  it("本文を保存すると表示中の run は changed になり、再評価した run からタスク化できる", async () => {
    const { ctx } = await makeProject();
    const app = apiRoutes(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as any };
    };
    const req = await newRequest(ctx, { title: "通知", status: "draft", body: "- 送信" });
    const first = await ctx.preflight.wait(req.id, (await call("POST", `/requests/${req.id}/preflight`, { engine: "mock" })).body.id);

    // 画面と同じ下書きの流れ: 編集を始めたときの rev で保存する
    let d = draftOf(ctx.ws.requests.require(req.id).body, ctx.ws.requests.require(req.id).rev);
    d = editDraft(d, "- 送信\n- 再送");
    const saved = await call("PATCH", `/requests/${req.id}`, { body: d.value, rev: d.baseRev });
    expect(saved.status).toBe(200);
    expect((await call("GET", `/requests/${req.id}/preflight/${first!.id}`)).body.inputMatch).toEqual({ status: "changed", changed: ["body"] });
    const refused = await call("POST", `/requests/${req.id}/preflight/${first!.id}/materialize`, {});
    expect(materializeErrorText(new ApiError(refused.status, refused.body.error, refused.body))).toContain("もう一度 Preflight");

    const second = await ctx.preflight.wait(req.id, (await call("POST", `/requests/${req.id}/preflight`, { engine: "mock" })).body.id);
    expect(second!.input?.body).toBe("- 送信\n- 再送");
    const ok = await call("POST", `/requests/${req.id}/preflight/${second!.id}/materialize`, {});
    expect(ok.status).toBe(201);
    expect(ok.body.tasks.map((t: any) => t.title)).toEqual(["送信", "再送"]);
  });
});
