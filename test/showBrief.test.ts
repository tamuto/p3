import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeProject, newRequest, newTask, tempDir } from "./helpers.ts";

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));

/**
 * 短い出力でどれだけ減るか（README の「短い出力」の目安）。
 * 実データに頼らず、261011-wng6f に似た形の固定データを作る: 本文のある6タスク（依存の鎖と成果物）と、
 * 領域・語の重なる周辺のタスクがたくさんある（以前は「関係しそう」「影響範囲」として出ていた。今はどちらの出力にも出さない）。
 */
async function fixture() {
  const { root, dataDir, ctx } = await makeProject();
  const areas = ["src/server/preflight", "src/cli", "src/server/store", "README.md", "docs/architecture.md"];
  const neighbors: string[] = [];
  for (let r = 0; r < 4; r++) {
    const req = await newRequest(ctx, { title: `周辺の要望 ${r} Preflight と CLI の設定`, body: "- Preflight の設定\n- CLI の出力", areas });
    for (let i = 0; i < 4; i++) {
      const t = await newTask(ctx, req.id, {
        title: `周辺のタスク ${r}-${i} Preflight の CLI 設定と出力を整える`,
        body: "Preflight と CLI の設定・出力・README を整える",
        areas,
        status: i % 2 ? "done" : "todo",
      });
      neighbors.push(t.ref);
    }
  }
  const main = await newRequest(ctx, { title: "公開の準備 Preflight と CLI の設定", body: "- 依存\n- 設定\n- 出力", areas });
  const body = (n: number) =>
    [
      "## 作業内容",
      "",
      `要望ブランチ上の1つの PR で、Preflight と CLI の設定を整える（${n}）。`,
      "",
      "- 設定の置き場所を個人設定に移し、CLI と serve で同じ解決を使う。環境変数と個人設定の優先順位を README に書く。",
      "- 読めない値は直す場所を示して止める。既存の保存経路で新しい項目とコメントを残す。",
      "- Preflight の Codex エンジンにも同じ設定を渡し、パスの対応・認証の選び方・イメージの更新を今と同じにする。",
      "",
      "## 完了条件",
      "",
      "- vitest のテストを追加し pnpm -s check が通る。README と docs を更新する。",
    ].join("\n");
  const refs: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const t = await newTask(ctx, main.id, {
      title: `公開の準備 ${n}: Preflight と CLI の設定を整える`,
      body: body(n),
      areas,
      status: n <= 2 ? "done" : n === 3 ? "doing" : "todo",
      outputs: n <= 2 ? [`https://example.com/commit/${n}`] : [],
      relations: n > 1 ? [{ type: "depends_on" as const, target: `T00${n - 1}`, origin: "preflight" as const }] : [],
    });
    refs.push(t.ref);
  }
  return { root, dataDir, refs };
}

function show(root: string, dataDir: string, ref: string, extra: string[]) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_"))), XDG_CONFIG_HOME: tempDir("p3-config-") };
  const r = spawnSync(process.execPath, [BIN, "--dir", dataDir, "show", ref, ...extra], { cwd: root, encoding: "utf8", env });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("短い出力の出力量", () => {
  it("周辺のタスクが多い6タスクで、短い出力は通常より小さく、作業に要るものは残る", async () => {
    const { root, dataDir, refs } = await fixture();
    const total = { text: { normal: 0, brief: 0 }, json: { normal: 0, brief: 0 } };
    for (const ref of refs) {
      total.text.normal += bytes(show(root, dataDir, ref, []));
      total.json.normal += bytes(show(root, dataDir, ref, ["--json"]));
      const text = show(root, dataDir, ref, ["--brief"]);
      const json = show(root, dataDir, ref, ["--brief", "--json"]);
      total.text.brief += bytes(text);
      total.json.brief += bytes(json);
      // 本文・依存とその状態・成果物・rev は残る
      const b = JSON.parse(json);
      expect(b.item.body).toContain("## 完了条件");
      expect(b.item.rev).toBeGreaterThan(0);
      expect(text).toContain("## 完了条件");
    }
    const t3 = JSON.parse(show(root, dataDir, refs[2], ["--brief", "--json"]));
    expect(t3.dependencies).toEqual([{ ref: refs[1], title: expect.stringContaining("公開の準備 2"), status: "done" }]);
    expect(JSON.parse(show(root, dataDir, refs[0], ["--brief", "--json"])).item.outputs).toEqual(["https://example.com/commit/1"]);

    // 通常の出力も、関係しそう・影響範囲を出さなくなって小さい。短い出力はさらに小さい
    expect(show(root, dataDir, refs[2], [])).not.toContain("関係しそう");
    expect(total.text.brief).toBeLessThan(total.text.normal);
    expect(total.json.brief).toBeLessThan(total.json.normal);
    console.info(`短い出力: テキスト ${total.text.normal} → ${total.text.brief} バイト、JSON ${total.json.normal} → ${total.json.brief} バイト`);
  }, 60_000);
});
