import { describe, expect, it } from "vitest";
import { areaOverlap, TfIdf, tokenize } from "../src/server/intel/text.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";
import { join } from "node:path";
import { writeRepoEntry } from "../src/server/store/projectFile.ts";

describe("tokenize", () => {
  it("日本語は bigram、ひらがなだけの bigram は捨てる。パスは区切りでも分割する", () => {
    const tokens = tokenize("ガントチャートを表示する src/web/views");
    expect(tokens).toContain("ガン");
    expect(tokens).toContain("表示");
    expect(tokens).not.toContain("する");
    expect(tokens).toEqual(expect.arrayContaining(["src/web/views", "src", "web", "views"]));
  });

  it("要望・タスク・Preflight の ID は語にしない", () => {
    const tokens = tokenize("要望 261009-0zbha より。T003 に依存 / preflight: PF-20261008-165438-f0da");
    expect(tokens.some((t) => /0zbha|261009|t003|f0da|pf-/.test(t))).toBe(false);
    expect(tokens).toEqual(expect.arrayContaining(["要望", "依存", "preflight"]));
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
  /**
   * 要望 A: T001 ストア ← T002 API ← T003 画面
   * 要望 B: T001 通知 —impacts→ T002 通知設定。T003 監視は A/T001 と領域が重なる。
   *         T004 は A/T001 に要望をまたいで依存する
   */
  async function graph() {
    const p = await makeProject();
    const { ctx } = p;
    const A = (await newRequest(ctx, { title: "要望A" })).id;
    const B = (await newRequest(ctx, { title: "要望B" })).id;
    await newTask(ctx, A, { title: "ストア", areas: ["src/server/store"] });
    await newTask(ctx, A, { title: "API", relations: [{ type: "depends_on", target: "T001" }] });
    await newTask(ctx, A, { title: "画面", relations: [{ type: "depends_on", target: "T002" }] });
    await newTask(ctx, B, { title: "通知", relations: [{ type: "impacts", target: "T002" }] });
    await newTask(ctx, B, { title: "通知の設定画面" });
    await newTask(ctx, B, { title: "監視", areas: ["src/server/store/workspace.ts"] });
    await newTask(ctx, B, { title: "移行", relations: [{ type: "depends_on", target: `${A}/T001` }] });
    ctx.index.invalidate();
    return { ...p, A, B };
  }

  it("相対参照（T001）は張った側の要望の中として解き、逆向きのエッジと要望への所属を導く", async () => {
    const { ctx, A, B } = await graph();
    const n = ctx.index.neighborhood(`${A}/T001`);
    expect(n.incoming.map((e) => [e.from, e.type])).toEqual(
      expect.arrayContaining([
        [`${A}/T002`, "depends_on"],
        [`${B}/T004`, "depends_on"],
      ]),
    );
    expect(n.outgoing).toEqual([expect.objectContaining({ to: A, type: "derived_from", origin: "index" })]);
  });

  it("影響範囲は依存の逆向きと impacts を、要望をまたいで推移的に辿る", async () => {
    const { ctx, A, B } = await graph();
    expect(ctx.index.impactScope(`${A}/T001`).sort()).toEqual([`${A}/T002`, `${A}/T003`, `${B}/T004`].sort());
    expect(ctx.index.impactScope(`${B}/T001`)).toEqual([`${B}/T002`]);
    expect(ctx.index.impactScope(`${A}/T003`)).toEqual([]);
  });

  it("依存の循環を検出する", async () => {
    const { ctx, A } = await graph();
    expect(ctx.index.wouldCycle(`${A}/T001`, `${A}/T003`)).toBe(true);
    expect(ctx.index.wouldCycle(`${A}/T003`, `${A}/T001`)).toBe(false);
  });

  it("明示の関係が無くても、別の要望の作業を領域の重なりから理由つきで提示する", async () => {
    const { ctx, A, B } = await graph();
    const hit = ctx.index.neighborhood(`${A}/T001`).implicit.find((r) => r.ref === `${B}/T003`);
    expect(hit?.reasons.join()).toContain("領域が重複");
    expect(hit?.kind).toBe("task");
  });

  it("関係グラフ上の近さを加点する", async () => {
    const { ctx, A } = await graph();
    const withSeed = ctx.index.related({ text: "無関係な語", seeds: [`${A}/T001`], minScore: 0 });
    expect(withSeed.find((r) => r.ref === `${A}/T002`)?.reasons).toContain("関係グラフで 1 ホップ");
    expect(withSeed.find((r) => r.ref === `${A}/T003`)?.reasons).toContain("関係グラフで 2 ホップ");
  });

  it("ファイルの変更通知でインデックスを作り直す", async () => {
    const { ctx, B } = await graph();
    expect(ctx.index.impactScope(`${B}/T002`)).toEqual([]);
    await newTask(ctx, B, { title: "後続", relations: [{ type: "depends_on", target: "T002" }] });
    ctx.ws.emit({ type: "changed", kind: "task", request: B, ref: `${B}/T005` });
    expect(ctx.index.impactScope(`${B}/T002`)).toEqual([`${B}/T005`]);
  });
});

describe("areas の重なりは参照先を区別する", () => {
  const scope = { known: ["allesc", "docs", "infra"], defaultRepo: "allesc" };
  it("同じ参照先の中の一致・親子・参照先の全体。名前なしは先頭の参照先", () => {
    expect(areaOverlap(["allesc:src/server"], ["allesc:src/server/store"], scope).shared).toEqual(["allesc:src/server/store"]);
    expect(areaOverlap(["src/server"], ["allesc:src/server"], scope).shared).toEqual(["allesc:src/server"]); // 今までの書き方と混ぜる
    expect(areaOverlap(["infra:"], ["infra:terraform/prod"], scope).shared).toEqual(["infra:terraform/prod"]);
    expect(areaOverlap(["docs:standard_guide/"], ["docs:standard_guide"], scope).shared).toEqual(["docs:standard_guide"]);
  });

  it("別の参照先の同じパスは重ならない。登録に無い名前・外へ出るパスはどれとも重ならない", () => {
    expect(areaOverlap(["allesc:src"], ["infra:src"], scope).score).toBe(0);
    expect(areaOverlap(["src"], ["docs:src"], scope).score).toBe(0);
    expect(areaOverlap(["unknown:src"], ["allesc:src", "unknown:src"], scope).score).toBe(0);
    expect(areaOverlap(["allesc:../x"], ["allesc:../x"], scope).score).toBe(0);
  });

  it("参照先が1つ（今までのプロジェクト）なら、見せ方も今までどおりパスだけ", () => {
    expect(areaOverlap(["src/a"], ["src/a/b"], { known: ["main"], defaultRepo: "main" }).shared).toEqual(["src/a/b"]);
    expect(areaOverlap(["src/a"], ["src/a/b"]).shared).toEqual(["src/a/b"]);
  });

  it("文脈の選定でも参照先を区別し、理由に名前を残す（内容が似ているだけの関連は出してよい）", async () => {
    const { ctx, dataDir } = await makeProject();
    const file = join(dataDir, "project.yaml");
    for (const name of ["allesc", "infra"]) await writeRepoEntry(file, name, { name, role: "", readFirst: false, writable: false, map: [] });
    await ctx.ws.reloadAll();
    const r = await newRequest(ctx, { title: "基盤の作業", areas: ["infra:src/net"] });
    const same = await newTask(ctx, r.id, { title: "ネットワーク設定", areas: ["infra:src/net/vpc"] });
    const other = await newTask(ctx, r.id, { title: "全く別の話題", areas: ["src/net"] }); // allesc の src/net
    ctx.index.invalidate();
    const rel = ctx.index.related({ text: "無関係な文", areas: ["infra:src/net"], exclude: [r.id] });
    expect(rel.find((x) => x.ref === same.ref)?.reasons).toContain("領域が重複 (infra:src/net/vpc)");
    expect(rel.find((x) => x.ref === other.ref)).toBeUndefined();
  });
});
