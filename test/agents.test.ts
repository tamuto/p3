import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENTS_SNIPPET, agentsSnippet, SKILL_SOURCE } from "../src/cli/project.ts";

const skill = readFileSync(SKILL_SOURCE, "utf8");
const devSkill = readFileSync(new URL("../.claude/skills/p3/SKILL.md", import.meta.url), "utf8");

describe("AI 向けの指示（同梱のスキルと AGENTS.md への追記）", () => {
  // 役割と終わり方: どちらにも同じことが書いてある
  const shared = [
    "P3_ACTOR=ai:", // 変更者を名乗る
    "pnpx @infodb/p3", // 入っていなくても動く呼び方
    "p3 whoami --json",
    "`via`", // プロジェクトの決まり方
    "request new",
    "`preflight`", // Preflight は人
    "`accept`", // タスク化は人
    "--note-only", // 頼まれたメモの保存はよい
    "--brief", // 作業に使うときは短い出力
    "dependencies", // 依存の状態の読み方
    "status=resolved", // 作業を終えたら対応済
    "rejected", // 完了済・見送りは人
    "check", // 済みは人
    "superseded", // 置き換えられたタスクから始めない
    "warnings",
    "人への質問をタスクにしない",
    "`work`", // 作業先のリポジトリとブランチ
    "--repo-output", // 複数のリポジトリの PR を最後のタスクに残す
    "`p3 init`", // 未登録でも自分から作らない・参加しない（どちらかを人に確かめる）
    "`p3 join`",
    "コミットする前に", // 完了・対応済を保存してからコミットする（記録を実装と同じコミットに入れられる）
    "requests/<要望ID>/", // 同じコミットに入れるのは、その要望（と親子でつながる要望）のフォルダ
    "git add -f", // 外・無視・worktree のデータを無理に入れない
    "`children`", // 親を対応済にするのは子が終わってから
    "マージするまで要望のブランチにしか無い", // 切り替えで消えたように見えても、作り直さない・写さない
    "祖先の要望のフォルダ", // 親子の記録（分割の採用・見送りの子）もコミットに入れる
    "子孫の要望のフォルダ",
  ];
  it.each(shared)("どちらにも「%s」がある", (word) => {
    expect(skill).toContain(word);
    expect(AGENTS_SNIPPET.replaceAll("\\`", "`")).toContain(word.replace("人への質問をタスクにしない", "人への質問はタスクにしない"));
  });

  it("Preflight とタスク化を人が行うことを、どちらもはっきり書く", () => {
    expect(skill).toMatch(/Preflight（評価・細分化）とタスク化（`accept`）は人が行う/);
    expect(AGENTS_SNIPPET).toMatch(/Preflight（\\?`preflight\\?`）とタスク化（\\?`accept\\?`）は人が行う（AI は実行しない/);
  });

  it("Preflight は明示の依頼があったときだけ手元で評価し、書くのは run の成果物だけ、タスク化と着手はしないと、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
      expect(text).toMatch(/人がチャットで対象の要望の Preflight を明示的に頼んだときだけ/);
      expect(text).toContain("--prepare --json");
      expect(text).toContain("--complete --run <run> --json");
      expect(text).toMatch(/指示のファイル（`instructions`）|`instructions`（指示のファイル）/);
      expect(text).toMatch(/自分から始めない/);
      expect(text).toMatch(/run の成果物/);
      expect(text).toMatch(/`accept`(?: と|）・)着手はしない|タスク化（`accept`）・タスクの着手はしない/);
      expect(text).not.toContain("claude -p --");
    }
    // 直接編集の禁止の例外は、指定の run の成果物だけ（管理情報・指示のファイルは書かない）
    expect(skill).toMatch(/「データのフォルダを直接編集しない」の唯一の例外で、\n\s*`run\.json`・`instructions\.md`・ほかの要望やタスクのファイルは書かない/);
    expect(skill).toContain("`assessment.json`・`drafts/`・`children/`・`ui/index.json`・`ui/src/`");
    expect(skill).toContain("自分の判断で `--cancel` しない");
    // 長い指示をスキルに写さない（P3 が作る指示のファイルを読む）
    expect(skill).not.toContain("ASSESSMENT_SPEC");
    expect(skill).not.toContain("\"verdict\"");
  });

  it("via が cwd でなければ操作を止めて確かめることを、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
      expect(text).toMatch(/`via`[^\n]*`cwd`[^\n]*でなければ（`dir` \/ `project` \/ `legacy` \/ `only`）、それ以上 p3 を操作せず/);
      expect(text).toMatch(/推測した `--project`/);
    }
  });

  it("どのプロジェクトでも動く書き方で、作った人の環境の値を含まない", () => {
    for (const text of [skill, AGENTS_SNIPPET, devSkill]) {
      expect(text).not.toMatch(/\/workspaces\/|\/mnt\/|\/root\/|\/home\/[a-z]/);
      expect(text).not.toMatch(/--project [a-z]/);
      expect(text).not.toMatch(/github\.com\/[\w-]+\//);
      expect(text).not.toMatch(/link:\.\./);
    }
  });

  it("完了は push の後ではなく、テストを通してコミットする前に保存する（URL は後から足す）。前の手順を残さない", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet, devSkill]) {
      expect(text).not.toMatch(/push したら、完了|コミット・push したら|--output <コミットか PR の URL> --record|--output <PR の URL など> --record/);
      expect(text).toMatch(/--output <URL>|--output` で足す/);
    }
  });

  it("開発用のスキルは原本を参照する", () => {
    expect(devSkill).toContain("skills/p3/SKILL.md");
    expect(devSkill).toContain("pnpm -s check");
  });
});

describe("docs の写し", () => {
  it("節のスキルの参照は、置いた先だけを書く（両方のときが AGENTS_SNIPPET）", () => {
    expect(agentsSnippet(["claude", "codex"])).toBe(AGENTS_SNIPPET);
    expect(agentsSnippet(["codex", "claude"])).toBe(AGENTS_SNIPPET); // 順は固定
    const claude = agentsSnippet(["claude"]);
    expect(claude).toContain("詳しい手順はスキル `.claude/skills/p3/SKILL.md`（Claude Code）\n");
    expect(claude).not.toContain(".agents/skills");
    expect(agentsSnippet(["codex"])).toContain("詳しい手順はスキル `.agents/skills/p3/SKILL.md`（Codex）\n");
    expect(AGENTS_SNIPPET).toContain("`.claude/skills/p3/SKILL.md`（Claude Code）・`.agents/skills/p3/SKILL.md`（Codex）。中身は同じ");
  });

  it("docs/architecture.md に載せた追記の内容は AGENTS_SNIPPET と同じ", () => {
    const doc = readFileSync(new URL("../docs/architecture.md", import.meta.url), "utf8");
    expect(doc).toContain(`\`\`\`markdown${AGENTS_SNIPPET.trimEnd()}\n\`\`\``);
  });
});
