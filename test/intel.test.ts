import { describe, expect, it } from "vitest";
import { areaOverlap, TfIdf, tokenize } from "../src/server/intel/text.ts";
import { makeProject, newTask } from "./helpers.ts";

describe("tokenize", () => {
  it("日本語は bigram、ひらがなだけの bigram は捨てる。パスは区切りでも分割する", () => {
    const tokens = tokenize("ガントチャートを表示する src/web/views");
    expect(tokens).toContain("ガン");
    expect(tokens).toContain("表示");
    expect(tokens).not.toContain("する");
    expect(tokens).toEqual(expect.arrayContaining(["src/web/views", "src", "web", "views"]));
  });
});

describe("TfIdf", () => {
  it("内容が近い文書ほどスコアが高く、共通語を理由として返す", () => {
    const t = new TfIdf();
    t.build([
      { id: "a", text: "ガントチャートの依存矢印を描く" },
      { id: "b", text: "ログイン画面の認証を直す" },
    ]);
    const q = t.vectorize("ガントチャートに依存関係を表示");
    const a = TfIdf.cosine(q, t.vectorOf("a")!);
    const b = TfIdf.cosine(q, t.vectorOf("b")!);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.shared.length).toBeGreaterThan(0);
  });
});

describe("areaOverlap", () => {
  it("パスの包含関係を重なりとみなす", () => {
    expect(areaOverlap(["src/server"], ["src/server/store/workspace.ts"])).toEqual({ score: 1, shared: ["src/server/store/workspace.ts"] });
    expect(areaOverlap(["src/web"], ["src/server"]).score).toBe(0);
    expect(areaOverlap([], ["src"]).score).toBe(0);
  });
});

describe("ProjectIndex", () => {
  async function graph() {
    const p = await makeProject();
    const { ctx } = p;
    await ctx.ws.requests.create({ title: "要望", status: "accepted", areas: [], relations: [], body: "" }, "t");
    const t1 = await newTask(ctx, { title: "ストア", request: "REQ-0001", areas: ["src/server/store"] });
    const t2 = await newTask(ctx, { title: "API", relations: [{ type: "depends_on", target: t1.id }] });
    const t3 = await newTask(ctx, { title: "画面", relations: [{ type: "depends_on", target: t2.id }] });
    const t4 = await newTask(ctx, { title: "通知", relations: [{ type: "impacts", target: "TASK-0005" }] });
    const t5 = await newTask(ctx, { title: "通知の設定画面" });
    const t6 = await newTask(ctx, { title: "監視", areas: ["src/server/store/workspace.ts"] });
    ctx.index.invalidate();
    return { ...p, t1, t2, t3, t4, t5, t6 };
  }

  it("逆向きのエッジと、要望への所属（構造）を導く", async () => {
    const { ctx, t1, t2 } = await graph();
    const n = ctx.index.neighborhood(t1.id);
    expect(n.incoming).toEqual([expect.objectContaining({ from: t2.id, type: "depends_on" })]);
    expect(n.outgoing).toEqual([expect.objectContaining({ to: "REQ-0001", type: "derived_from", origin: "index" })]);
  });

  it("影響範囲は依存の逆向きと impacts を推移的に辿る", async () => {
    const { ctx, t1, t2, t3, t4, t5 } = await graph();
    expect(ctx.index.impactScope(t1.id).sort()).toEqual([t2.id, t3.id].sort());
    expect(ctx.index.impactScope(t4.id)).toEqual([t5.id]);
    expect(ctx.index.impactScope(t3.id)).toEqual([]);
  });

  it("依存の循環を検出する", async () => {
    const { ctx, t1, t3 } = await graph();
    expect(ctx.index.wouldCycle(t1.id, t3.id)).toBe(true);
    expect(ctx.index.wouldCycle(t3.id, t1.id)).toBe(false);
  });

  it("明示の関係が無くても、領域の重なりから関連を理由つきで提示する", async () => {
    const { ctx, t1, t6 } = await graph();
    const n = ctx.index.neighborhood(t1.id);
    const hit = n.implicit.find((r) => r.id === t6.id);
    expect(hit).toBeDefined();
    expect(hit!.reasons.join()).toContain("領域が重複");
  });

  it("関係グラフ上の近さを加点する", async () => {
    const { ctx, t1, t3 } = await graph();
    const withSeed = ctx.index.related({ text: "無関係な語", seeds: [t1.id], minScore: 0 });
    expect(withSeed.find((r) => r.id === "TASK-0002")?.reasons).toContain("関係グラフで 1 ホップ");
    expect(withSeed.find((r) => r.id === t3.id)?.reasons).toContain("関係グラフで 2 ホップ");
  });

  it("ファイルの変更通知でインデックスを作り直す", async () => {
    const { ctx, t5 } = await graph();
    expect(ctx.index.impactScope(t5.id)).toEqual([]);
    await newTask(ctx, { title: "後続", relations: [{ type: "depends_on", target: t5.id }] });
    ctx.ws.emit({ type: "changed", kind: "task", id: "TASK-0007" });
    expect(ctx.index.impactScope(t5.id)).toEqual(["TASK-0007"]);
  });
});
