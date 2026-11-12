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

  it("タスク化は人が行い、Preflight は自分から始めないことを、どちらもはっきり書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    expect(skill).toMatch(/Preflight（評価・細分化）は自分から始めず、タスク化（`accept`）は人が行う/);
    expect(snippet).toMatch(/Preflight（`preflight`）は自分から始めない（勧めない・尋ねない）。タスク化（`accept`）は人が行う/);
    expect(skill).toMatch(/Preflight を勧めたり、実行してよいか尋ねたりもしない/);
    // Preflight を通さないタスクの登録・作業の手順は残す
    for (const text of [skill, snippet]) expect(text).toContain("request new");
  });

  it("Preflight を頼まれたときは担当（whoami の preflight.runner）で分け、codex / agent / 読めないときを、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
      expect(text).toContain("`preflight.runner`");
      // codex: 人が実行。AI は通常の実行をしない。手元の評価は明示の依頼のときだけ
      expect(text).toMatch(/`codex`/);
      expect(text).toMatch(/AI は[^\n]*`--prepare` の無い[^\n]*`p3 preflight`[^\n]*をしない|AI は `p3 preflight <要望ID>`（`--prepare` の無い通常の実行）をしない/);
      expect(text).toMatch(/人がチャットで対象の要望[^\n]*手元の評価を(?:\n\s*)?明示的に(?:\n\s*)?頼んだときだけ/);
      // agent: 「Preflight して」で手元で評価し、「このチャットで」は求めない
      expect(text).toMatch(/`agent`/);
      expect(text).toMatch(/「Preflight して」/);
      expect(text).toMatch(/「このチャットで」(?:のような言い方)?は求めない/);
      // 読めない担当を agent と推測しない
      expect(text).toMatch(/`agent` と推測しない|`agent` と推測せず/);
      // 子も親と同じ
      expect(text).toMatch(/子の要望も(?:親と)?同じ/);
      expect(text).toContain("対象の要望が分からなければ確かめる");
    }
  });

  it("スキルの役割の表・登録の後・子の要望・してはいけないことが同じ分け方で、前の「Preflight は人」の決まりを残さない", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    expect(skill).toMatch(/\| Preflight（評価・細分化。`preflight`） \| 担当（`whoami --json` の `preflight\.runner`）で決まる/);
    expect(skill).toMatch(/子の Preflight は親と同じく、頼まれたときだけ\n\s*「Preflight を頼まれたとき」の担当に従う/);
    expect(snippet).toMatch(/子の Preflight は親と同じ担当で、頼まれたときだけ/);
    expect(skill).toMatch(/手元の評価（`--prepare` \/ `--complete`）は、上の「Preflight を頼まれたとき」の担当ごとの条件を満たしたときだけ/);
    for (const text of [skill, snippet]) {
      expect(text).not.toMatch(/子の Preflight は人が行う/);
      expect(text).not.toMatch(/Preflight（[^）]*）とタスク化（`accept`）は人が行う/);
      expect(text).not.toMatch(/Preflight の実行（`preflight`）とタスク化（`accept`）をしない/);
    }
  });

  it("Preflight を頼まれたときは手元で評価し、書くのは run の成果物だけ、タスク化と着手はしないと、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
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

  it("受け入れ基準: 着手する前に読み、完了と同時に基準ごとの証拠をファイルで残し、未達・未検証は正直に書いて人に伝えると、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
      expect(text).toContain("acceptanceCriteria");
      expect(text).toContain("--evidence-file evidence.md");
      expect(text).toContain("## A1 met");
      expect(text).toContain("`unmet`");
      expect(text).toContain("`unverified`");
      expect(text).toContain("推測で `met` にしない");
      expect(text).toContain("人に伝える");
      expect(text).toMatch(/基準を自分で消す・書き換え/);
    }
    // 証拠は申告で、済みは人。変更の記録とは役割が違う
    expect(skill).toContain("証拠は自分の申告で、レビューの判定ではない");
    expect(skill).toContain("役割が違う");
    expect(skill).toContain("`--record -` と標準入力を取り合う");
  });

  it("止まっている理由: 続けられないときだけ付け、保存を確かめて人に伝えて終え、回答で解除して再開すると、どちらも書く", () => {
    const snippet = AGENTS_SNIPPET.replaceAll("\\`", "`");
    for (const text of [skill, snippet]) {
      expect(text).toContain("block");
      expect(text).toContain("--reason");
      expect(text).toContain("--decision");
      expect(text).toContain("通常の修正・調査の途中では使わない");
      expect(text).toMatch(/JSON の `block` で保存できたことを確かめ/);
      expect(text).toContain("止まったまま完了・済み・");
      expect(text).toContain("unblock");
      expect(text).toContain("--resolution");
      expect(text).toContain("解除だけでは");
    }
    // スキルには、質問をタスクにしない代わり・依存待ちに付けない・失敗を偽らない・人が先に解除したとき・新しい理由
    expect(skill).toContain("人への質問を新しいタスクにする代わりに、今のタスクに付ける");
    expect(skill).toContain("未着手の依存待ちのタスクを作業中にしてまで付けない");
    expect(skill).toContain("記録できたと偽らずに伝える");
    expect(skill).toContain("人が先に解除していたら");
    expect(skill).toContain("新しい停止として付ける");
    expect(skill).toContain("回答を受けずに自分で解除しない");
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
