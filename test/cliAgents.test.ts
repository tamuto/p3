// CLI を別のプロセスで動かして確かめる: AI 向けの使い方の置く先（init --agents claude|codex|both・p3 agents）。
// 共通の準備（CLI の呼び出し・テストごとの個人設定・初期化済みのプロジェクト）は cliHelpers.ts
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_HOME, p3, repo, withConfigHome, snapshot } from "./cliHelpers.ts";
import { tempDir } from "./helpers.ts";
import { init } from "../packages/p3/src/cli/project.ts";

describe("AI 向けの使い方の置く先（init --agents claude|codex|both・p3 agents）", () => {
  const SKILL = fileURLToPath(new URL("../skills/p3/SKILL.md", import.meta.url));
  const CLAUDE = ".claude/skills/p3/SKILL.md";
  const CODEX = ".agents/skills/p3/SKILL.md";
  const original = () => readFileSync(SKILL, "utf8");
  const has = (root: string, t: string) => existsSync(join(root, t));
  const agentsMd = (root: string) => readFileSync(join(root, "AGENTS.md"), "utf8");
  /** AGENTS.md の p3 の節が指すスキル */
  const refs = (root: string) => [CLAUDE, CODEX].filter((t) => agentsMd(root).includes(`\`${t}\``));

  it.each([
    ["claude", ["--agents", "claude"], [CLAUDE]],
    ["codex（= の形）", ["--agents=codex"], [CODEX]],
    ["both", ["--agents", "both"], [CLAUDE, CODEX]],
    ["値なし（both）", ["--agents"], [CLAUDE, CODEX]],
    ["値なしの後ろにオプション", ["--agents", "--description", "x"], [CLAUDE, CODEX]],
    ["指定なし（置かない）", [], []],
  ])("init %s", async (_label, args, placed) => {
    const root = await repo();
    const r = p3(root, ["init", "--yes", ...args, "--project", "app"]);
    expect(r.code, r.err).toBe(0);
    for (const t of [CLAUDE, CODEX]) expect(has(root, t), t).toBe(placed.includes(t));
    if (placed.length) expect(refs(root)).toEqual(placed);
    else expect(agentsMd(root)).toBe("# rules\n");
    expect(agentsMd(root).includes("中身は同じ")).toBe(placed.length > 1);
  });

  it("init: 知らない値・空の値・余分な位置引数は、何も書く前に断る", async () => {
    for (const args of [["--agents", "cursor"], ["--agents="], ["--agents", "claude", "codex"], ["extra"]]) {
      const root = await repo();
      const before = snapshot(root);
      const r = p3(root, ["init", "--yes", ...args, "--project", "app"]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err, args.join(" ")).toMatch(/--agents は claude \/ codex \/ both|位置引数/);
      expect(snapshot(root), args.join(" ")).toEqual(before);
      expect(existsSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"))).toBe(false);
    }
  });

  it("対話の init: 置く先を選べ、Enter は置かない（既にある AGENTS.md から推測しない）。--agents を付ければ聞かない", async () => {
    for (const [answer, placed] of [["", []], ["claude", [CLAUDE]], ["codex", [CODEX]], ["both", [CLAUDE, CODEX]]] as const) {
      const root = await repo();
      const questions: string[] = [];
      await withConfigHome(tempDir("p3-config-"), () =>
        init({ cwd: root, project: "app", prompt: async (q) => (questions.push(q), q.startsWith("AI 向けの p3 の使い方") ? answer : "") }),
      );
      const q = questions.find((x) => x.startsWith("AI 向けの p3 の使い方"));
      expect(q).toContain("（置かない / claude / codex / both）");
      expect(q).toContain("[置かない]");
      for (const t of [CLAUDE, CODEX]) expect(has(root, t), `${answer || "Enter"}: ${t}`).toBe((placed as readonly string[]).includes(t));
    }
    // 知らない答えは何も作らずに断る
    const root = await repo();
    await expect(
      withConfigHome(tempDir("p3-config-"), () => init({ cwd: root, project: "app", prompt: async (q) => (q.startsWith("AI 向け") ? "cursor" : "") })),
    ).rejects.toThrow("置く先は 置かない / claude / codex / both のどれか");
    expect(existsSync(join(root, ".p3"))).toBe(false);
    // 明示すれば聞かない
    const root2 = await repo();
    const asked: string[] = [];
    await withConfigHome(tempDir("p3-config-"), () => init({ cwd: root2, project: "app", agents: "codex", prompt: async (q) => (asked.push(q), "") }));
    expect(asked.some((x) => x.startsWith("AI 向け"))).toBe(false);
    expect([has(root2, CLAUDE), has(root2, CODEX)]).toEqual([false, true]);
  });

  it("p3 agents: 置く先は省けない。今いるリポジトリのルートに置き、データ・個人設定を作らない・変えない", async () => {
    const root = await repo();
    await mkdir(join(root, "src"));
    for (const args of [[], ["cursor"], ["claude", "codex"]]) {
      const r = p3(root, ["agents", ...args]);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("p3 agents claude|codex|both");
    }
    expect(p3(root, ["init", "--yes", "--force"]).err).toContain("--force は p3 agents でだけ使えます");
    const r = p3(join(root, "src"), ["agents", "claude"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("作成  AI 向けのスキル（Claude Code）を ../.claude/skills/p3/SKILL.md に置きました");
    expect([has(root, CLAUDE), has(root, CODEX), has(join(root, "src"), ".claude")]).toEqual([true, false, false]);
    expect(refs(root)).toEqual([CLAUDE]);
    expect(existsSync(join(root, ".p3"))).toBe(false);
    expect(existsSync(join(CONFIG_HOME, "infodb-p3"))).toBe(false);
    // もう一度は同じ
    const again = p3(root, ["agents", "claude"]);
    expect(again.out).toContain("同一  AI 向けのスキル（Claude Code）.claude/skills/p3/SKILL.md は最新です");
    expect(again.out).toContain("同一  AI 向けの使い方（AGENTS.md の節）は最新です");
  });

  it("p3 agents: 後から片方を足すと、スキルを置き、節の参照は変えずに知らせる。--force で節だけを置き換え（前後の文は残す）、参照は両方になる", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "claude", "--project", "app"]).code).toBe(0);
    writeFileSync(join(root, "AGENTS.md"), `${agentsMd(root)}\n## 自分たちの決まり\n\n- レビューは2人\n`);
    const r = p3(root, ["agents", "codex"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("作成  AI 向けのスキル（Codex）を .agents/skills/p3/SKILL.md に置きました");
    expect(r.out).toContain("保護  ※ AGENTS.md の「タスク管理（infodb p3）」の節は同梱の版と違うので変えません。最新にするなら p3 agents codex --force");
    expect(refs(root)).toEqual([CLAUDE]);
    const f = p3(root, ["agents", "codex", "--force"]);
    expect(f.out).toContain("同一  AI 向けのスキル（Codex）");
    expect(f.out).toContain("更新  AI 向けの使い方（AGENTS.md の「タスク管理（infodb p3）」の節）を置き換えました");
    expect(refs(root)).toEqual([CLAUDE, CODEX]);
    const text = agentsMd(root);
    expect(text.startsWith("# rules\n")).toBe(true);
    expect(text).toContain("## 自分たちの決まり\n\n- レビューは2人\n");
    expect(text.split("タスク管理（infodb p3）")).toHaveLength(2);
    expect(p3(root, ["agents", "both"]).out).toContain("同一  AI 向けの使い方（AGENTS.md の節）は最新です");
  });

  it("p3 agents: 手で直したスキルは上書きせず違う行を出し、--force で選んだ先だけを同梱の版にする。選ばなかった先・ほかの指示は変えない", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "--project", "app"]).code).toBe(0);
    for (const t of [CLAUDE, CODEX]) writeFileSync(join(root, t), original().replace(/\n/, "\n手で足した行\n"));
    const before = { codex: readFileSync(join(root, CODEX), "utf8"), md: agentsMd(root), yaml: readFileSync(join(root, ".p3", "project.yaml"), "utf8"), cfg: readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8") };
    const r = p3(root, ["agents", "claude"]);
    expect(r.out).toContain("保護  ※ .claude/skills/p3/SKILL.md（Claude Code）は既にあり、同梱の版と違うので上書きしません（2 行目から違います）。最新にするなら p3 agents claude --force");
    const f = p3(root, ["agents", "claude", "--force"]);
    expect(f.out).toContain("更新  AI 向けのスキル（Claude Code）.claude/skills/p3/SKILL.md を同梱の版にしました");
    expect(readFileSync(join(root, CLAUDE), "utf8")).toBe(original());
    expect(readFileSync(join(root, CODEX), "utf8")).toBe(before.codex);
    expect(agentsMd(root)).toBe(before.md);
    expect(readFileSync(join(root, ".p3", "project.yaml"), "utf8")).toBe(before.yaml);
    expect(readFileSync(join(CONFIG_HOME, "infodb-p3", "config.yaml"), "utf8")).toBe(before.cfg);
  });

  it("p3 agents: 消した先は戻さない。以前の版の節（両方を指す）は通常は残し、--force で今ある先だけを指す節にする", async () => {
    const root = await repo();
    expect(p3(root, ["init", "--yes", "--agents", "--project", "app"]).code).toBe(0); // 以前と同じ両方
    rmSync(join(root, ".agents"), { recursive: true });
    const r = p3(root, ["agents", "claude"]);
    expect(r.out).toContain("保護  ※ AGENTS.md の「タスク管理（infodb p3）」の節は同梱の版と違うので変えません");
    expect(has(root, CODEX)).toBe(false);
    expect(refs(root)).toEqual([CLAUDE, CODEX]);
    expect(p3(root, ["agents", "claude", "--force"]).code).toBe(0);
    expect(has(root, CODEX)).toBe(false);
    expect(refs(root)).toEqual([CLAUDE]);
  });

  it("p3 agents: 節が複数・見出しになっていないときは --force でも変えず、手で整理するよう知らせる。### の節は段を保って置き換える", async () => {
    const dup = await repo();
    writeFileSync(join(dup, "AGENTS.md"), "# rules\n\n## タスク管理（infodb p3）\n\n- 古い1\n\n## タスク管理（infodb p3）\n\n- 古い2\n");
    const inline = await repo();
    writeFileSync(join(inline, "AGENTS.md"), "# rules\n\nタスク管理（infodb p3）は使わない\n");
    for (const [root, message] of [[dup, "の節が2 つあります"], [inline, "の節が見出しとして見つかりません"]] as const) {
      const before = agentsMd(root);
      const r = p3(root, ["agents", "claude", "--force"]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(message);
      expect(r.out).toContain("手で1つの節");
      expect(agentsMd(root)).toBe(before);
      expect(has(root, CLAUDE)).toBe(true); // スキルは置く
    }
    const deep = await repo();
    writeFileSync(join(deep, "AGENTS.md"), "# rules\n\n### タスク管理（infodb p3）\n\n- 古い\n\n### 次の節\n\n- そのまま\n");
    expect(p3(deep, ["agents", "claude", "--force"]).out).toContain("更新  AI 向けの使い方");
    const text = agentsMd(deep);
    expect(text).toContain("### タスク管理（infodb p3）\n\n<!-- p3-entry-version: ");
    expect(text).not.toContain("- 古い\n");
    expect(text).toContain("### 次の節\n\n- そのまま\n");
    // コードの囲みの中の見出しは数えない
    const fenced = await repo();
    writeFileSync(join(fenced, "AGENTS.md"), "# rules\n\n```md\n## タスク管理（infodb p3）\n```\n");
    expect(p3(fenced, ["agents", "claude"]).out).toContain("の節が見出しとして見つかりません");
  });
});
