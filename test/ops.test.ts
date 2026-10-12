import { afterEach, describe, expect, it, vi } from "vitest";
import { listTasks, progress, resolve, resolveRef, resolveRequestId } from "../src/core/ops.ts";
import { addRelation, removeRelation } from "../src/core/requestOps.ts";
import { NotFoundError } from "../src/core/store/collection.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

async function setup() {
  const p = await makeProject();
  const { ctx } = p;
  const A = (await newRequest(ctx, { title: "ガントチャート表示" })).id;
  const B = (await newRequest(ctx, { title: "認証の見直し", status: "draft" })).id;
  await newTask(ctx, A, { title: "ガントの依存矢印", status: "doing", areas: ["src/web/routes"] });
  await newTask(ctx, A, { title: "かんばん", status: "done" });
  await newTask(ctx, A, { title: "スケジュール", relations: [{ type: "depends_on", target: "T001" }] });
  await newTask(ctx, B, { title: "トークンの扱い", areas: ["src/server/api"], body: "期限切れの扱い" });
  return { ...p, A, B };
}

describe("参照の解き方", () => {
  it("要望は完全な ID・乱数部分・一意な一部で指せる", async () => {
    const { ctx, A } = await setup();
    expect(resolveRequestId(ctx, A)).toBe(A);
    expect(resolveRequestId(ctx, A.slice(-5))).toBe(A);
    expect(resolveRequestId(ctx, A.slice(-5).toUpperCase())).toBe(A);
    expect(resolveRequestId(ctx, "zz")).toBeUndefined();
  });

  it("タスクは今の要望の中なら T3 / 3、そうでなければ <要望>/T3", async () => {
    const { ctx, A, B } = await setup();
    expect(resolveRef(ctx, "T3", A)).toBe(`${A}/T003`);
    expect(resolveRef(ctx, "1", B)).toBe(`${B}/T001`);
    expect(resolveRef(ctx, "T3")).toBeUndefined();
    expect(resolveRef(ctx, "T9", A)).toBeUndefined();
    expect(resolveRef(ctx, `${B.slice(-5)}/t1`)).toBe(`${B}/T001`);
    expect(resolveRef(ctx, B)).toBe(B);
  });
});

describe("resolve", () => {
  it("参照 → タイトル部分一致（今の要望を先に） → 内容類似 の順で候補を返す", async () => {
    const { ctx, A, B } = await setup();
    expect(resolve(ctx, "T3", A).match).toBe(`${A}/T003`);
    const gantt = resolve(ctx, "ガント", A);
    expect(gantt.match).toBeNull();
    expect(gantt.candidates.slice(0, 2).map((c) => c.ref).sort()).toEqual([A, `${A}/T001`].sort());
    expect(resolve(ctx, "トークン").match).toBe(`${B}/T001`);
  });
});

describe("listTasks", () => {
  it("要望・ステータス・領域・語句で絞り込む", async () => {
    const { ctx, A, B } = await setup();
    const refs = (f: Parameters<typeof listTasks>[1]) => listTasks(ctx, f).map((t) => t.ref);
    expect(refs({ request: A })).toEqual([`${A}/T001`, `${A}/T002`, `${A}/T003`]);
    expect(refs({ status: ["todo"] }).sort()).toEqual([`${A}/T003`, `${B}/T001`].sort());
    expect(refs({ area: "src/server" })).toEqual([`${B}/T001`]);
    expect(refs({ q: "期限切れ" })).toEqual([`${B}/T001`]);
  });
});

describe("addRelation / removeRelation", () => {
  it("同じ要望のタスクは T003、別の要望は絶対参照でファイルに書く。変更者が AI なら origin: ai", async () => {
    const { ctx, A, B } = await setup();
    const t = await addRelation(ctx, `${A}/T001`, { type: "impacts", target: `${A}/T002` }, "human:a");
    expect(t.relations).toEqual([{ type: "impacts", target: "T002", origin: "human" }]);
    const u = await addRelation(ctx, `${A}/T001`, { type: "relates_to", target: `${B}/T1`, confidence: 0.6 }, "ai:claude");
    expect(u.relations.at(-1)).toEqual({ type: "relates_to", target: `${B}/T001`, origin: "ai", confidence: 0.6 });
    // 同じ種類・相手は張り直しで上書き（相対・絶対どちらで書いても同じ相手）
    const v = await addRelation(ctx, `${A}/T001`, { type: "impacts", target: "T2", note: "見直し" }, "human:a");
    expect(v.relations.filter((r) => r.type === "impacts")).toEqual([{ type: "impacts", target: "T002", note: "見直し", origin: "human" }]);
  });

  it("自分自身・存在しない相手・依存の循環を拒む", async () => {
    const { ctx, A } = await setup();
    await expect(addRelation(ctx, `${A}/T001`, { type: "relates_to", target: "T001" }, "h")).rejects.toThrow("自分自身");
    await expect(addRelation(ctx, `${A}/T001`, { type: "relates_to", target: "T404" }, "h")).rejects.toBeInstanceOf(NotFoundError);
    await addRelation(ctx, `${A}/T001`, { type: "depends_on", target: "T002" }, "h");
    await expect(addRelation(ctx, `${A}/T002`, { type: "depends_on", target: "T003" }, "h")).rejects.toThrow("循環");
  });

  it("要望にも関係を張れる。無い関係を外そうとしたら NotFound", async () => {
    const { ctx, A, B } = await setup();
    const r = await addRelation(ctx, B, { type: "impacts", target: A }, "h");
    expect(r.relations).toEqual([{ type: "impacts", target: A, origin: "human" }]);
    expect((await removeRelation(ctx, B, { type: "impacts", target: A }, "h")).relations).toEqual([]);
    await expect(removeRelation(ctx, B, { type: "impacts", target: A }, "h")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("progress", () => {
  // 日時はテストの中で決める（実時計だと続けて作ったものが同じミリ秒になり、順番が決まらない）
  afterEach(() => vi.useRealTimers());
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  it("要望ごとにステータス別の件数を集計する", async () => {
    const { ctx, A, B } = await setup();
    const ps = progress(ctx);
    expect(ps.find((p) => p.request.id === A)).toMatchObject({ total: 3, done: 1, counts: { todo: 1, doing: 1, done: 1 } });
    expect(ps.find((p) => p.request.id === B)).toMatchObject({ total: 1, done: 0 });
  });

  it("最終更新は要望自身とタスクの新しい方。タスクの無い要望は要望自身", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-10-10T00:00:00.000Z");
    const { ctx } = await makeProject();
    const r = await newRequest(ctx, { title: "R" });
    const empty = await newRequest(ctx, { title: "タスク無し" });
    at("2026-10-10T01:00:00.000Z");
    await newTask(ctx, r.id, { title: "t" });
    const of = (id: string) => progress(ctx).find((p) => p.request.id === id)!.updatedAt;
    expect(of(r.id)).toBe("2026-10-10T01:00:00.000Z"); // タスクの更新
    expect(of(empty.id)).toBe("2026-10-10T00:00:00.000Z");
    at("2026-10-10T02:00:00.000Z");
    await ctx.ws.requests.update(r.id, { title: "R2" });
    expect(of(r.id)).toBe("2026-10-10T02:00:00.000Z"); // 要望自身の更新
  });

  it("新しい順。同じ日時なら要望 ID の順（作った順や ID の並びに左右されない）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-10-10T00:00:00.000Z");
    const { ctx } = await makeProject();
    const ids = [(await newRequest(ctx, { title: "1" })).id, (await newRequest(ctx, { title: "2" })).id, (await newRequest(ctx, { title: "3" })).id];
    // 一覧と同じ ID の順（数を含む部分は数として比べる。乱数部分が 9abcd と 12xyz なら 9abcd が先）
    const [lo, mid, hi] = [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const order = () => progress(ctx).map((p) => p.request.id);
    expect(order()).toEqual([lo, mid, hi]); // 全部同じ日時

    // ID の大きいものから順に更新しても、同じ日時の間は ID の順
    at("2026-10-10T01:00:00.000Z");
    await newTask(ctx, hi, { title: "x" });
    await newTask(ctx, lo, { title: "y" });
    expect(order()).toEqual([lo, hi, mid]);

    // 日時が違えば、ID に関係なく新しい方が先
    at("2026-10-10T02:00:00.000Z");
    await newTask(ctx, mid, { title: "z" });
    expect(order()).toEqual([mid, lo, hi]);
  });
});
