import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { discardDraft, draftOf, editDraft, isDirty, shallowEqual, syncDraft } from "../src/web/lib/draft.ts";
import { latestOnly, STALE } from "../src/web/lib/latest.ts";
import { applyLoad, initialLoad } from "../src/web/lib/requestLoad.ts";
import { makeProject, newRequest } from "./helpers.ts";

describe("入力欄の下書き（取り直しても編集中は上書きしない）", () => {
  it("編集していなければ取り直した値に追従する", () => {
    const d = draftOf("A", 1);
    expect(syncDraft(d, "A", 1)).toBe(d); // 変わらなければ同じもの（描き直さない）
    expect(syncDraft(d, "B", 2)).toEqual(draftOf("B", 2));
  });

  it("編集中に外で変わったら入力はそのまま、最新を external に持つ。保存に使う rev は編集を始めたとき", () => {
    const d = editDraft(draftOf("A", 1), "入力中");
    expect(isDirty(d)).toBe(true);
    const s = syncDraft(d, "外で変えた", 3);
    expect(s).toEqual({ value: "入力中", base: "A", baseRev: 1, external: { value: "外で変えた", rev: 3 } });
    expect(syncDraft(s, "外で変えた", 3)).toBe(s);
    // 捨てると最新に
    expect(discardDraft(s)).toEqual(draftOf("外で変えた", 3));
    // 外で変わっていなければ編集前に
    expect(discardDraft(d)).toEqual(draftOf("A", 1));
  });

  it("入力を始めた後に戻ってきた取得の応答（同じ rev）や古い応答では上書きしない", () => {
    const d = editDraft(draftOf("A", 2), "入力中");
    expect(syncDraft(d, "A", 2)).toBe(d);
    expect(syncDraft(d, "もっと古い", 1)).toBe(d);
    expect(syncDraft(draftOf("A", 2), "もっと古い", 1)).toEqual(draftOf("A", 2));
  });

  it("入力を元の値に戻したら編集していない扱いで、また追従する", () => {
    const d = editDraft(editDraft(draftOf("A", 1), "AB"), "A");
    expect(isDirty(d)).toBe(false);
    expect(syncDraft(d, "B", 2)).toEqual(draftOf("B", 2));
  });

  it("タスク詳細のような平らなオブジェクトも比べられる", () => {
    const base = { title: "T", body: "" };
    const d = editDraft(draftOf(base, 1), { ...base, body: "書いた" });
    expect(isDirty(d, shallowEqual)).toBe(true);
    expect(isDirty(editDraft(d, { ...base }), shallowEqual)).toBe(false);
    expect(syncDraft(d, { title: "外", body: "" }, 2, shallowEqual).value).toEqual({ title: "T", body: "書いた" });
  });

  it("保持した編集開始時の rev で保存すると、外で更新されていれば競合で拒否される（最新の rev に差し替えない）", async () => {
    const p = await makeProject();
    const app = apiRoutes(p.ctx);
    const r = await newRequest(p.ctx, { title: "元" });
    let d = draftOf(r.title, r.rev);
    d = editDraft(d, "画面で入力中");
    await p.ctx.ws.requests.update(r.id, { title: "外で変えた" }); // 外での更新
    const latest = p.ctx.ws.requests.get(r.id)!;
    d = syncDraft(d, latest.title, latest.rev);
    expect(d.external?.value).toBe("外で変えた");
    const res = await app.request(`/requests/${r.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: d.value, rev: d.baseRev }),
    });
    expect(res.status).toBe(409);
    expect(p.ctx.ws.requests.get(r.id)!.title).toBe("外で変えた");
    expect(d.value).toBe("画面で入力中"); // 入力は残る
  });
});

describe("最後に始めた取得の応答だけを使う", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };

  it("応答の順が入れ替わっても、古い取得の結果は stale", async () => {
    const l = latestOnly();
    const a = deferred<string>();
    const b = deferred<string>();
    const ra = l.run(() => a.promise);
    const rb = l.run(() => b.promise);
    b.resolve("新");
    a.resolve("古");
    expect(await rb).toBe("新");
    expect(await ra).toBe(STALE);
  });

  it("古い取得の失敗は投げず、最後の取得の失敗だけ投げる。cancel で全部捨てる", async () => {
    const l = latestOnly();
    const a = deferred<string>();
    const ra = l.run(() => a.promise);
    const rb = l.run(() => Promise.reject(new Error("最後の失敗")));
    a.reject(new Error("古い失敗"));
    expect(await ra).toBe(STALE);
    await expect(rb).rejects.toThrow("最後の失敗");
    const c = l.run(() => Promise.resolve("x"));
    l.cancel();
    expect(await c).toBe(STALE);
  });
});

describe("要望を取り直した結果の扱い", () => {
  const ok = (title: string) => ({ ok: true as const, data: { title } });

  it("表示中に見つからなくなったら、前の内容を残して gone（画面を外さない）。初めから無ければ「見つかりません」", () => {
    const shown = applyLoad(initialLoad<{ title: string }>(), ok("A"));
    expect(shown).toEqual({ data: { title: "A" }, gone: false, error: null });
    expect(applyLoad(shown, { ok: false, status: 404, message: "not found" })).toEqual({ data: { title: "A" }, gone: true, error: null });
    expect(applyLoad(initialLoad(), { ok: false, status: 404, message: "not found" })).toEqual({ data: null, gone: false, error: null });
  });

  it("一時的な失敗は削除とみなさず前の内容のまま。取り直せたら消える", () => {
    const shown = applyLoad(initialLoad<{ title: string }>(), ok("A"));
    const failed = applyLoad(shown, { ok: false, message: "Failed to fetch" });
    expect(failed).toEqual({ data: { title: "A" }, gone: false, error: "Failed to fetch" });
    expect(applyLoad(failed, { ok: false, status: 500, message: "" }).error).toBe("読み込めませんでした");
    expect(applyLoad(failed, ok("B"))).toEqual({ data: { title: "B" }, gone: false, error: null });
    // 初めの取得が失敗: まだ何も無い（再試行できる）
    expect(applyLoad(initialLoad(), { ok: false, message: "x" })).toEqual({ data: undefined, gone: false, error: "x" });
  });
});
