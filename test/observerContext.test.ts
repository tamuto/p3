import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containerEnv, preflightPrompt, referenceContext } from "../packages/tasks/src/core/preflight/instructions.ts";
import { resolveRefs } from "../packages/tasks/src/core/repoRefs.ts";
import { qualitySnapshot } from "../packages/tasks/src/features/quality/shared/quality.ts";
import type { P3Context } from "../packages/tasks/src/core/context.ts";
import { observerAssistant } from "../packages/app/src/core/observerAssistant.ts";
import { mockSuggestion, suggestionMessage, SuggestionService } from "../packages/observer/src/core/suggest.ts";
import { git, gitInit, projectConfig, tempDir } from "./helpers.ts";

/**
 * 観測の手順の提案に渡すプロジェクトの文脈（docs/architecture.md「p3-observer」の手順の提案）。Preflight と同じ組み立てで、
 * プロジェクトの説明・参照先と役割・最初に読むもの・主なフォルダ・品質基準と版・調べ方を渡し、タスク化の規則・データのフォルダは渡さない
 */
function setup() {
  const root = tempDir();
  const main = join(root, "main");
  const lib = join(root, "lib");
  mkdirSync(join(main, "docs"), { recursive: true });
  mkdirSync(join(lib, "src"), { recursive: true });
  writeFileSync(join(main, "docs", "index.md"), "# docs");
  gitInit(main);
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "init");
  const project = projectConfig({
    description: "在庫管理のシステム",
    repos: [
      // 名前とマウント名が違う（日本語の名前は repo1 にマウントする）
      { name: "本体", role: "システム本体", readFirst: true, writable: true, map: [{ path: "docs", role: "設計の文書", entry: "docs/index.md" }] },
      { name: "lib", role: "依存しているライブラリ", readFirst: false, writable: false, map: [{ path: "src", role: "実装", entry: "" }] },
      { name: "gone", role: "使っていない", readFirst: false, writable: false, map: [] },
    ],
    quality: { state: "set", config: { standards: [{ id: "Q1", text: "共通部品は shared に置く", check: { kind: "human", how: "読んで確かめる" } }] } } as never,
    qualityVersion: "qv-1",
  });
  const refs = resolveRefs(project, { localRepos: { 本体: main, lib } });
  return { root, main, project, refs, quality: qualitySnapshot(project.quality, project.qualityVersion) };
}

describe("観測の提案に渡す文脈", () => {
  it("テスト用の接続が受け取った依頼に、Preflight と同じ文脈が入り、読めない参照先・このマシンのパス・タスク化の規則は入らない", async () => {
    const { root, main, project, refs } = setup();
    let asked: { instructions: string; prompt: string; refs?: readonly { name: string; mount: string }[] } | undefined;
    const ctx = {
      ws: { project, refs: () => refs },
      assistant: {
        engine: async () => "codex" as const,
        codex: {
          status: async () => ({ name: "codex", ok: true, detail: "代替" }),
          ask: async (input: typeof asked) => {
            asked = input;
            return { message: suggestionMessage(mockSuggestion({ definition: { title: "t", category: "", description: "p3 ls コマンド", measures: [], procedures: [] } }, ["本体"])), seconds: 0 };
          },
        },
      },
    } as unknown as P3Context;
    const job = await new SuggestionService(observerAssistant(ctx)).run({ definition: { title: "一覧の速さ", category: "", description: "p3 ls コマンドの速さ", measures: [], procedures: [] } });
    expect(job.status, job.error).toBe("completed");
    const p = asked!.prompt;
    expect(p).toContain("## プロジェクト\n" + `${project.name}: 在庫管理のシステム`);
    expect(p).toContain("  - /workspace/repo1 — 本体（システム本体）［最初に読む］［git の履歴あり］");
    expect(p).toContain("  - /workspace/lib — lib（依存しているライブラリ）");
    expect(p).toMatch(/## 最初に読むもの\n.*\n### 本体（システム本体）\n- \/workspace\/repo1\/docs — 設計の文書（入口 \/workspace\/repo1\/docs\/index\.md）/);
    expect(p).toMatch(/## 主なフォルダ[^\n]*\n### lib（依存しているライブラリ）\n- \/workspace\/lib\/src — 実装/);
    expect(p).toContain("## このプロジェクトの品質基準（プロジェクト設定より。版 qv-1）");
    expect(p).toContain("- Q1［全部の参照先］ 共通部品は shared に置く");
    expect(p).toContain("git -C /workspace/<参照先> log --follow");
    expect(p).toContain("## 読める参照先\n- /workspace/repo1\n- /workspace/lib");
    // 読めない参照先は理由つきで見ていないと書き、パスとして渡さない。このマシンのパスは出さない
    expect(p).toContain("見ていない参照先: gone（");
    expect(p).not.toContain("/workspace/gone");
    expect(p).not.toContain(root);
    expect(p).not.toContain(main);
    // タスク化の規則・出力の形・データのフォルダ（Preflight の書き込み）は渡さない
    for (const s of ["タスク案", "assessment.json", "/data", "作業先にできる", "acceptanceCriteria"]) expect(p, s).not.toContain(s);
    // 実際にマウントするのは読める参照先だけで、依頼に書いたパスと同じ場所
    expect(asked!.refs?.map((r) => [r.name, r.mount])).toEqual([["本体", "repo1"], ["lib", "lib"]]);
    // 使った品質基準の版と参照範囲を実行の記録に残す
    expect(job.context).toEqual({ qualityVersion: "qv-1", repos: ["/workspace/repo1", "/workspace/lib"] });
  });

  it("Preflight と同じ設定から、参照先の一覧・最初に読むもの・主なフォルダは同じ文になる", () => {
    const { project, refs, quality } = setup();
    const ctx = referenceContext({ project, refs, quality });
    const dataDir = tempDir();
    const pf = preflightPrompt(
      {
        project,
        refs,
        quality,
        dataDir,
        runDir: join(dataDir, "requests", "261001-aaaaa", "preflight", "PF-1"),
        request: { id: "261001-aaaaa", title: "題", status: "draft", areas: [], tags: [], rev: 1, createdAt: "", updatedAt: "", updatedBy: "", body: "本文" },
      },
      containerEnv({ project, refs, dataDir, runDir: join(dataDir, "r"), request: {} as never }),
    );
    const section = (t: string, h: string) => new RegExp(`${h}[\\s\\S]*?(?=\\n## |$)`).exec(t)?.[0];
    for (const h of ["## 最初に読むもの", "## 主なフォルダ"]) expect(section(ctx, h), h).toBe(section(pf, h));
  });
});
