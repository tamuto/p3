import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENTS_SNIPPET, SKILL_SOURCE } from "../src/cli/project.ts";

const skill = readFileSync(SKILL_SOURCE, "utf8");
const devSkill = readFileSync(new URL("../.claude/skills/p3/SKILL.md", import.meta.url), "utf8");

describe("AI 向けの指示（同梱のスキルと AGENTS.md への追記）", () => {
  // 役割と終わり方: どちらにも同じことが書いてある
  const shared = [
    "PCUBE_ACTOR=ai:", // 変更者を名乗る
    "pnpx @infodb/p3", // 入っていなくても動く呼び方
    "p3 whoami",
    "request new",
    "`preflight`", // Preflight は人
    "`accept`", // タスク化は人
    "--note-only", // 頼まれたメモの保存はよい
    "status=resolved", // 作業を終えたら対応済
    "rejected", // 完了済・見送りは人
    "check", // 済みは人
    "superseded", // 置き換えられたタスクから始めない
    "warnings",
    "人への質問をタスクにしない",
  ];
  it.each(shared)("どちらにも「%s」がある", (word) => {
    expect(skill).toContain(word);
    expect(AGENTS_SNIPPET.replaceAll("\\`", "`")).toContain(word.replace("人への質問をタスクにしない", "人への質問はタスクにしない"));
  });

  it("Preflight とタスク化を人が行うことを、どちらもはっきり書く", () => {
    expect(skill).toMatch(/Preflight（評価・細分化）とタスク化（`accept`）は人が行う/);
    expect(AGENTS_SNIPPET).toMatch(/Preflight（\\?`preflight\\?`）とタスク化（\\?`accept\\?`）は人が行う（AI は実行しない/);
  });

  it("どのプロジェクトでも動く書き方で、作った人の環境の値を含まない", () => {
    for (const text of [skill, AGENTS_SNIPPET, devSkill]) {
      expect(text).not.toMatch(/\/workspaces\/|\/mnt\/|\/root\/|\/home\/[a-z]/);
      expect(text).not.toMatch(/--project [a-z]/);
      expect(text).not.toMatch(/github\.com\/[\w-]+\//);
      expect(text).not.toMatch(/link:\.\./);
    }
  });

  it("開発用のスキルは原本を参照する", () => {
    expect(devSkill).toContain("skills/p3/SKILL.md");
    expect(devSkill).toContain("pnpm -s check");
  });
});

describe("docs の写し", () => {
  it("docs/architecture.md に載せた追記の内容は AGENTS_SNIPPET と同じ", () => {
    const doc = readFileSync(new URL("../docs/architecture.md", import.meta.url), "utf8");
    expect(doc).toContain(`\`\`\`markdown${AGENTS_SNIPPET.trimEnd()}\n\`\`\``);
  });
});
