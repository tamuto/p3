import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedDemo } from "../scripts/demoData.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { tempDir } from "./helpers.ts";

describe("デモデータ（一時フォルダに作る。.p3-demo には触れない）", () => {
  it("成果物は1つの例と、URL・文章・パスを混ぜた複数の例があり、どれも文字列の配列で保存される", async () => {
    const dir = join(tempDir("p3-demo-"), ".p3-demo");
    await seedDemo(dir);
    const ws = new Workspace(dir);
    await ws.load();
    const done = ws.allTasks().filter((t) => t.outputs.length);
    for (const t of done) expect(t.outputs.every((o) => typeof o === "string")).toBe(true);
    expect(done.some((t) => t.outputs.length === 1 && t.outputs[0].startsWith("https://"))).toBe(true);
    const views = ws.requests.list().find((r) => r.title.startsWith("要望ごとのタスクボード"))!;
    const [t1, t2] = ["T001", "T002"].map((id) => ws.tasksOf(views.id).require(id));
    // 済み（対応済みの一覧で見る）と、完了のまま（ボードで見る）
    expect([t1.checkedAt !== undefined, t2.status, t2.checkedAt]).toEqual([true, "done", undefined]);
    for (const t of [t1, t2]) {
      expect(t.outputs.filter((o) => o.startsWith("https://")).length).toBeGreaterThanOrEqual(1);
      expect(t.outputs.some((o) => /[ぁ-んァ-ン一-龠]/.test(o) && !o.startsWith("http"))).toBe(true); // 日本語の文章
      expect(t.outputs.some((o) => /^(docs|src)\//.test(o))).toBe(true); // パス
    }
    expect(t1.outputs.filter((o) => o.startsWith("https://"))).toHaveLength(2);
  });
});
