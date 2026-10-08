import { describe, expect, it } from "vitest";
import { addRelation, listTasks, progress, removeRelation, resolve, resolveRef, resolveRequestId } from "../src/server/ops.ts";
import { NotFoundError } from "../src/server/store/collection.ts";
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
  it("要望ごとにステータス別の件数を集計し、更新の新しい順に並べる", async () => {
    const { ctx, A, B } = await setup();
    const ps = progress(ctx);
    const a = ps.find((p) => p.request.id === A)!;
    expect(a).toMatchObject({ total: 3, done: 1, counts: { todo: 1, doing: 1, done: 1 } });
    expect(ps.find((p) => p.request.id === B)).toMatchObject({ total: 1, done: 0 });
    expect(ps[0].request.id).toBe(B); // B のタスクが最後に作られた
  });
});
