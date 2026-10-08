import { describe, expect, it } from "vitest";
import { addRelation, listTasks, normalizeId, removeRelation, resolve } from "../src/server/ops.ts";
import { NotFoundError } from "../src/server/store/collection.ts";
import { makeProject, newTask } from "./helpers.ts";

async function setup() {
  const p = await makeProject();
  await p.ctx.ws.requests.create({ title: "ガントチャート表示", status: "draft", areas: [], relations: [], body: "" }, "t");
  await newTask(p.ctx, { title: "ガントの依存矢印", status: "ready", request: "REQ-0001", areas: ["src/web/views"] });
  await newTask(p.ctx, { title: "認証の整理", status: "done", areas: ["src/server/api"], body: "トークンの扱い" });
  await newTask(p.ctx, { title: "かんばん", status: "ready" });
  return p;
}

describe("normalizeId", () => {
  it("短い書き方を正式な ID にする。数字だけなら prefer の種類", async () => {
    const { ctx } = await setup();
    expect(normalizeId(ctx, "2")).toBe("TASK-0002");
    expect(normalizeId(ctx, "task-2")).toBe("TASK-0002");
    expect(normalizeId(ctx, "TASK-0002")).toBe("TASK-0002");
    expect(normalizeId(ctx, "1", "REQ")).toBe("REQ-0001");
    expect(normalizeId(ctx, "req-1")).toBe("REQ-0001");
    expect(normalizeId(ctx, "99")).toBeUndefined();
    expect(normalizeId(ctx, "ガント")).toBeUndefined();
  });
});

describe("resolve", () => {
  it("ID → タイトル部分一致 → 内容類似 の順で候補を返し、1件に絞れたら match にする", async () => {
    const { ctx } = await setup();
    expect(resolve(ctx, "task-3").match).toBe("TASK-0003");
    const gantt = resolve(ctx, "ガント");
    expect(gantt.match).toBeNull();
    expect(gantt.candidates.map((c) => c.id)).toEqual(expect.arrayContaining(["TASK-0001", "REQ-0001"]));
    expect(resolve(ctx, "認証").match).toBe("TASK-0002");
  });
});

describe("listTasks", () => {
  it("ステータス・要望・領域・語句で絞り込む", async () => {
    const { ctx } = await setup();
    const ids = (f: Parameters<typeof listTasks>[1]) => listTasks(ctx, f).map((t) => t.id);
    expect(ids({ status: ["ready"] })).toEqual(["TASK-0001", "TASK-0003"]);
    expect(ids({ request: "REQ-0001" })).toEqual(["TASK-0001"]);
    expect(ids({ area: "src/server" })).toEqual(["TASK-0002"]);
    expect(ids({ q: "トークン" })).toEqual(["TASK-0002"]);
  });
});

describe("addRelation / removeRelation", () => {
  it("変更者が AI なら origin: ai、人なら human を記録する。同じ種類・相手は張り直しで上書き", async () => {
    const { ctx } = await setup();
    await addRelation(ctx, "TASK-0001", { type: "impacts", target: "TASK-0003", confidence: 0.6 }, "ai:claude");
    const t = await addRelation(ctx, "TASK-0001", { type: "impacts", target: "TASK-0003", note: "見直し" }, "human:a");
    expect(t.relations).toEqual([{ type: "impacts", target: "TASK-0003", note: "見直し", origin: "human" }]);
    const ai = await addRelation(ctx, "TASK-0002", { type: "relates_to", target: "REQ-0001" }, "ai:claude");
    expect(ai.relations[0].origin).toBe("ai");
  });

  it("自分自身・存在しない相手・依存の循環を拒む", async () => {
    const { ctx } = await setup();
    await expect(addRelation(ctx, "TASK-0001", { type: "relates_to", target: "TASK-0001" }, "h")).rejects.toThrow("自分自身");
    await expect(addRelation(ctx, "TASK-0001", { type: "relates_to", target: "TASK-0404" }, "h")).rejects.toBeInstanceOf(NotFoundError);
    await addRelation(ctx, "TASK-0001", { type: "depends_on", target: "TASK-0002" }, "h");
    await addRelation(ctx, "TASK-0002", { type: "depends_on", target: "TASK-0003" }, "h");
    await expect(addRelation(ctx, "TASK-0003", { type: "depends_on", target: "TASK-0001" }, "h")).rejects.toThrow("循環");
  });

  it("要望にも関係を張れる。無い関係を外そうとしたら NotFound", async () => {
    const { ctx } = await setup();
    const r = await addRelation(ctx, "REQ-0001", { type: "impacts", target: "TASK-0002" }, "h");
    expect(r.relations).toHaveLength(1);
    const after = await removeRelation(ctx, "REQ-0001", { type: "impacts", target: "TASK-0002" }, "h");
    expect(after.relations).toHaveLength(0);
    await expect(removeRelation(ctx, "REQ-0001", { type: "impacts", target: "TASK-0002" }, "h")).rejects.toBeInstanceOf(NotFoundError);
  });
});
