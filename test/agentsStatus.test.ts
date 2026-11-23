import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { git, gitInit, tempDir } from "./helpers.ts";
import { agentsText, diagnoseAgents, type AgentsDiagnosis } from "../packages/p3/src/cli/agentsStatus.ts";
import { ENTRY_VERSION } from "../packages/p3/src/cli/guide.ts";
import { AGENTS_SNIPPET, agentsSnippet, placeAgents, SKILL_SOURCE } from "../packages/p3/src/cli/project.ts";

const CLAUDE = ".claude/skills/p3/SKILL.md";
const CODEX = ".agents/skills/p3/SKILL.md";
const bundled = readFileSync(SKILL_SOURCE, "utf8");
/** 前の p3 が置いた全文のスキル（入口の版が無い） */
const OLD_SKILL = "---\nname: p3\ndescription: 前の版\n---\n\n# p3 でこのプロジェクトの作業を管理する\n\n- 手順の全文\n";
/** 前の p3 が足した節（入口の版のコメントが無い） */
const OLD_SECTION = "# 手順\n\n## タスク管理（infodb p3）\n\n- 作業の単位は要望。詳しい手順はスキル `.claude/skills/p3/SKILL.md`（Claude Code）\n\n## ほかの決まり\n\n- 残す\n";

function repo(): string {
  const root = tempDir("p3-agents-status-");
  gitInit(root);
  return root;
}
const put = (root: string, path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const status = (d: AgentsDiagnosis) => Object.fromEntries(d.entries.map((e) => [e.path, e.status]));

describe("置いた AI 向けの入口の診断（whoami・guide の agents）", () => {
  it("何も置いていなければ未配置で、人が先を選んで置くよう案内する", () => {
    const root = repo();
    const d = diagnoseAgents(root);
    expect(d).toMatchObject({ root, placed: false, ok: false, entries: [], expectedVersion: ENTRY_VERSION });
    expect(d.writeRoot).toBeUndefined();
    expect(d.advice.join("\n")).toContain("pnpx @infodb/p3 agents claude|codex|both");
    expect(agentsText(d)[0]).toBe("置かれていません");
  });

  it("p3 agents both で置いた直後は、両方のスキルと節が current", async () => {
    const root = repo();
    await placeAgents(root, root, "both");
    const d = diagnoseAgents(root);
    expect(d.ok).toBe(true);
    expect(status(d)).toEqual({ [CLAUDE]: "current", [CODEX]: "current", "AGENTS.md": "current" });
    expect(d.entries.every((e) => e.version === ENTRY_VERSION)).toBe(true);
    expect(d.advice).toEqual([]);
    expect(agentsText(d)[0]).toMatch(/^最新/);
  });

  it("claude だけ・codex だけを置いたときは、選ばなかった先が無くても current（必須にしない）", async () => {
    for (const choice of ["claude", "codex"] as const) {
      const root = repo();
      await placeAgents(root, root, choice);
      const d = diagnoseAgents(root);
      expect(d.ok, choice).toBe(true);
      expect(d.entries.map((e) => e.path).sort()).toEqual([choice === "claude" ? CLAUDE : CODEX, "AGENTS.md"].sort());
    }
  });

  it("前の p3 の全文のスキルと節は outdated。差分を見てから --force を案内し、force で入口に移れる（force 無しは保護のまま）", async () => {
    const root = repo();
    put(root, CLAUDE, OLD_SKILL);
    put(root, "AGENTS.md", OLD_SECTION);
    const d = diagnoseAgents(root);
    expect(status(d)).toEqual({ [CLAUDE]: "outdated", "AGENTS.md": "outdated" });
    expect(d.entries.every((e) => e.version === null)).toBe(true);
    expect(d.advice.join("\n")).toMatch(/git diff[^\n]*pnpx @infodb\/p3 agents claude --force/);

    // 通常の実行は変えない（保護）
    expect((await placeAgents(root, root, "claude")).join("\n")).toContain("保護");
    expect(readFileSync(join(root, CLAUDE), "utf8")).toBe(OLD_SKILL);
    // force で入口に置き換わり、節の前後の文は残る
    await placeAgents(root, root, "claude", true);
    expect(readFileSync(join(root, CLAUDE), "utf8")).toBe(bundled);
    const doc = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(doc.startsWith("# 手順\n")).toBe(true);
    expect(doc).toContain("## ほかの決まり\n\n- 残す\n");
    expect(diagnoseAgents(root).ok).toBe(true);
  });

  it("入口の版が同じで中身が違えば modified。--force をすぐには勧めない", async () => {
    const root = repo();
    await placeAgents(root, root, "claude");
    writeFileSync(join(root, CLAUDE), `${bundled}\n- 手で足した決まり\n`);
    const d = diagnoseAgents(root);
    expect(status(d)[CLAUDE]).toBe("modified");
    expect(d.entries.find((e) => e.path === CLAUDE)?.version).toBe(ENTRY_VERSION);
    expect(d.advice.join("\n")).not.toContain("--force で更新");
    expect(d.advice.join("\n")).toContain("手で直した内容を確かめて");
  });

  it("CLI より新しい入口の版は newer で、古い CLI でないか確かめるよう案内する", async () => {
    const root = repo();
    await placeAgents(root, root, "claude");
    writeFileSync(join(root, CLAUDE), bundled.replace(`p3-entry-version: "${ENTRY_VERSION}"`, `p3-entry-version: "${ENTRY_VERSION + 1}"`));
    const doc = join(root, "AGENTS.md");
    writeFileSync(doc, readFileSync(doc, "utf8").replace(`p3-entry-version: ${ENTRY_VERSION} `, `p3-entry-version: ${ENTRY_VERSION + 1} `));
    const d = diagnoseAgents(root);
    expect(status(d)).toEqual({ [CLAUDE]: "newer", "AGENTS.md": "newer" });
    expect(d.advice.join("\n")).toContain("cliVersion");
  });

  it("入口の版が読めない・節が複数・見出しになっていなければ unknown", async () => {
    const root = repo();
    put(root, CLAUDE, bundled.replace(`p3-entry-version: "${ENTRY_VERSION}"`, 'p3-entry-version: "一"'));
    put(root, "AGENTS.md", `${AGENTS_SNIPPET}${AGENTS_SNIPPET}`);
    const d = diagnoseAgents(root);
    expect(status(d)).toEqual({ [CLAUDE]: "unknown", "AGENTS.md": "unknown" });
    expect(d.entries.find((e) => e.path === "AGENTS.md")?.reason).toContain("2 つ");
    expect(d.advice.join("\n")).toContain("1つの節");
  });

  it("読めない入口は unreadable（ほかの入口の結果は残す）", async () => {
    const root = repo();
    await placeAgents(root, root, "claude");
    mkdirSync(join(root, CODEX), { recursive: true }); // ファイルの場所がフォルダ
    const d = diagnoseAgents(root);
    expect(status(d)).toEqual({ [CLAUDE]: "current", [CODEX]: "unreadable", "AGENTS.md": "current" });
  });

  it("CLAUDE.md の節は、版や形にかかわらず misplaced で、AGENTS.md に最新の節があっても人が移すよう案内する", async () => {
    const root = repo();
    await placeAgents(root, root, "claude");
    put(root, "CLAUDE.md", OLD_SECTION);
    const d = diagnoseAgents(root);
    expect(d.ok).toBe(false);
    expect(d.entries.filter((e) => e.kind === "section")).toEqual([
      expect.objectContaining({ path: "AGENTS.md", primary: true, status: "current" }),
      expect.objectContaining({ path: "CLAUDE.md", primary: false, status: "misplaced" }),
    ]);
    expect(d.advice.join("\n")).toContain("CLAUDE.md の p3 の節を消す");
    expect(agentsText(d).join("\n")).toContain("CLAUDE.md にある");

    // 最新の版の節が CLAUDE.md だけにある: CLAUDE.md は misplaced、AGENTS.md は missing（置き方を案内）
    const only = repo();
    put(only, CLAUDE, bundled);
    put(only, "CLAUDE.md", `# メモ\n${agentsSnippet(["claude"])}`);
    const o = diagnoseAgents(only);
    expect(status(o)).toEqual({ [CLAUDE]: "current", "CLAUDE.md": "misplaced", "AGENTS.md": "missing" });
    expect(o.entries.find((e) => e.path === "CLAUDE.md")?.version).toBe(ENTRY_VERSION);
    expect(o.advice.join("\n")).toContain("pnpx @infodb/p3 agents");

    // 見出しになっていない言及・複数の節も misplaced（移す対象）
    const mention = repo();
    put(mention, "CLAUDE.md", "メモ: タスク管理（infodb p3）は後で書く\n");
    expect(status(diagnoseAgents(mention))).toEqual({ "CLAUDE.md": "misplaced", "AGENTS.md": "missing" });
  });

  it("節が指すスキルが無ければ missing、スキルだけあって節が無ければ節が missing", async () => {
    const both = repo();
    await placeAgents(both, both, "both");
    // 節は両方を指すのに codex のスキルを消した
    const other = repo();
    put(other, "AGENTS.md", readFileSync(join(both, "AGENTS.md"), "utf8"));
    put(other, CLAUDE, bundled);
    const d = diagnoseAgents(other);
    expect(status(d)).toEqual({ [CLAUDE]: "current", [CODEX]: "missing", "AGENTS.md": "current" });
    expect(d.advice.join("\n")).toContain("pnpx @infodb/p3 agents codex");

    const noSection = repo();
    put(noSection, CLAUDE, bundled);
    put(noSection, "CLAUDE.md", "# メモ\n");
    const n = diagnoseAgents(noSection);
    // 書く先は CLAUDE.md があっても AGENTS.md
    expect(n.entries.find((e) => e.kind === "section")).toMatchObject({ path: "AGENTS.md", primary: true, status: "missing" });
  });

  it("見出しの段（###）と改行（CRLF）の違いは current のまま", async () => {
    const root = repo();
    put(root, "AGENTS.md", "# 手順\n\n### タスク管理（infodb p3）\n\n- 古い\n");
    put(root, CLAUDE, bundled.replaceAll("\n", "\r\n"));
    await placeAgents(root, root, "claude", true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("### タスク管理（infodb p3）");
    writeFileSync(join(root, CLAUDE), bundled.replaceAll("\n", "\r\n"));
    expect(diagnoseAgents(root).ok).toBe(true);
  });

  it("サブフォルダからでも作業ツリーのルートを、追加の作業ツリーではその作業ツリーを調べ、書く先との違いを案内する", async () => {
    const root = repo();
    await placeAgents(root, root, "claude");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    expect(diagnoseAgents(join(root, "src", "deep"))).toMatchObject({ root, ok: true });

    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "init");
    const wt = join(tempDir("p3-agents-wt-"), "wt");
    git(root, "worktree", "add", "-q", "-b", "feature", wt);
    // 作業ツリーの側だけ古い
    writeFileSync(join(wt, CLAUDE), OLD_SKILL);
    const d = diagnoseAgents(wt);
    expect(d).toMatchObject({ root: wt, writeRoot: root, ok: false });
    expect(status(d)[CLAUDE]).toBe("outdated");
    expect(d.advice.join("\n")).toContain(`メインの作業ツリー（${root}）`);
    // メインの作業ツリーは最新のまま
    expect(diagnoseAgents(root).ok).toBe(true);
  });

  it("診断は読むだけで、ファイルを変えない", async () => {
    const root = repo();
    put(root, CLAUDE, OLD_SKILL);
    put(root, "AGENTS.md", OLD_SECTION);
    const snap = () => {
      const files: Record<string, string> = {};
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          if (name === ".git") continue;
          const f = join(d, name);
          if (statSync(f).isDirectory()) walk(f);
          else files[relative(root, f)] = `${statSync(f).mtimeMs}:${readFileSync(f, "utf8")}`;
        }
      };
      walk(root);
      return files;
    };
    const before = snap();
    diagnoseAgents(root);
    diagnoseAgents(root);
    expect(snap()).toEqual(before);
  });
});
