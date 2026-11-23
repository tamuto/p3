import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { ProjectConfig } from "@infodb/p3-tasks/shared/types.ts";
import { writeProjectFile, writeRepoEntry } from "@infodb/p3-tasks/core/store/projectFile.ts";
import { normalizeProject } from "@infodb/p3-tasks/core/store/normalize.ts";
import { repoNameProblem } from "@infodb/p3-tasks/shared/repos.ts";
import { DATA_DIR_NAME } from "@infodb/p3-tasks/core/store/locate.ts";
import { ENTRY_VERSION } from "./guide.ts";
import { loadUserConfig, PROJECT_NAME, setProjectNode, updateUserConfig, userConfigPath } from "@infodb/p3-tasks/core/userConfig.ts";
import { repoRoot, resolvePath, UsageError } from "@infodb/p3-shared/node/usage.ts";
import { splitList } from "@infodb/p3-tasks/features/settings/cli/projectSettings.ts";

/** 入口: プロジェクトの初期設定（init）・参加（join）・登録（project）と AI 向けの入口（agents）。設定の変更と今の要望の判定は projectSettings.ts（tasks） */

/** init で本体の主なフォルダ（最初に読むもの）の候補にするドキュメントと、フォルダの入口の候補 */
const DOC_CANDIDATES = ["docs", "doc", "README.md", "ARCHITECTURE.md", "DESIGN.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
const DOC_ENTRIES = ["README.md", "index.md"];

export const AGENTS_MARK = "タスク管理（infodb p3）";

/** AI 向けの使い方を置く先（リポジトリのルートからの相対パス。どれも同じ原本 skills/p3/SKILL.md を写す） */
export const AGENT_TARGETS = {
  claude: { path: ".claude/skills/p3/SKILL.md", agent: "Claude Code" },
  codex: { path: ".agents/skills/p3/SKILL.md", agent: "Codex" },
} as const;
export type AgentKind = keyof typeof AGENT_TARGETS;
/** --agents / p3 agents の選び方（値なしの --agents は both） */
export const AGENT_CHOICES = { claude: ["claude"], codex: ["codex"], both: ["claude", "codex"] } as const satisfies Record<string, readonly AgentKind[]>;
export type AgentChoice = keyof typeof AGENT_CHOICES;
export const isAgentChoice = (v: unknown): v is AgentChoice => typeof v === "string" && Object.hasOwn(AGENT_CHOICES, v);
export const KINDS = Object.keys(AGENT_TARGETS) as AgentKind[];

/** 節の入口の版を書く機械可読のコメント（ENTRY_VERSION。見出しの次の行） */
export const ENTRY_COMMENT = (v: number) => `<!-- p3-entry-version: ${v} -->`;

/**
 * AGENTS.md / CLAUDE.md に書く指示（節）。入口だけで、手順の本文は CLI（p3 guide）から読ませる。
 * スキルの参照は、置いた先（と既にある先）だけを書く。入口の決まりを変えたら ENTRY_VERSION を上げる（test/agents.test.ts が確かめる）
 */
export function agentsSnippet(kinds: readonly AgentKind[]): string {
  const list = KINDS.filter((k) => kinds.includes(k));
  const skills = list.map((k) => `\`${AGENT_TARGETS[k].path}\`（${AGENT_TARGETS[k].agent}）`).join("・") + (list.length > 1 ? "。中身は同じ" : "");
  return `
## ${AGENTS_MARK}

${ENTRY_COMMENT(ENTRY_VERSION)}

- このリポジトリの作業は infodb p3 の要望とタスクで管理する。p3 を操作する前に \`pnpx @infodb/p3 guide --json\` を実行し、返った \`guide\`（作業の手順）を最後まで読んで従う（手順は動いている CLI の版のものが返る。ここには写さない）
- \`guide\` を取得できなければ（コマンドが無い・エラーになる・JSON が読めない）、p3 を操作しない。出たエラーと呼び方（\`pnpx @infodb/p3 guide --json\`）を人に伝えて終える
- 同じ入口のスキル: ${skills}
`;
}

/** 両方に置いたときの節（docs/architecture.md に載せる例。test/agents.test.ts が同じことを確かめる） */
export const AGENTS_SNIPPET = agentsSnippet(KINDS);

/**
 * 同梱のスキルの原本。置くのはプロジェクトの中だけ（個人のスキルの場所に置くと、p3 を使わないプロジェクトでも読まれる）。
 * 原本（skills/p3/SKILL.md）は、この CLI のファイルから上へ探す: 配布物では同梱した <パッケージ>/skills、開発のリポジトリでは
 * ルートの skills（packages/p3/src/cli から 4 つ上）。原本は1つだけで、配布物を作るときに写す（scripts/build-cli.mjs）
 */
export const SKILL_SOURCE = (() => {
  for (const up of ["../../", "../../../../"]) {
    const p = fileURLToPath(new URL(`${up}skills/p3/SKILL.md`, import.meta.url));
    if (existsSync(p)) return p;
  }
  return fileURLToPath(new URL("../../skills/p3/SKILL.md", import.meta.url));
})();

/** 2つの文の最初に違う行（1 から） */
function firstDiffLine(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i + 1;
}

/** 指示の節（見出し「タスク管理（infodb p3）」からその見出しと同じか上の段の次の見出しの前まで。コードの囲みの中は見出しに数えない） */
export function findSections(text: string): { start: number; end: number; level: number }[] {
  const lines = text.split("\n");
  const heads: { line: number; level: number; mark: boolean }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ line: i, level: m[1].length, mark: m[2] === AGENTS_MARK });
  });
  return heads
    .filter((h) => h.mark)
    .map((h) => ({ start: h.line, level: h.level, end: heads.find((n) => n.line > h.line && n.level <= h.level)?.line ?? lines.length }));
}

/**
 * AI 向けの使い方を置く（init --agents と p3 agents）。kinds の先だけを扱い、ほかの先は作らず・変えず・消さない。
 *   - スキル: 無ければ置く・同じなら何もしない・違えば上書きせず違う行と最新にする方法を出す（force なら同梱の版にする）
 *   - 指示: AGENTS.md（無ければ CLAUDE.md、どちらも無ければ AGENTS.md を作る）の節。スキルの参照は kinds と既にある先。
 *     節が無ければ足す・同じなら何もしない・違えば変えずに知らせる（force なら節だけを置き換え、前後の文は残す）。
 *     節が複数・見出しの形が分からないときは force でも変えず、手で整理するよう知らせる
 */
export async function placeAgents(root: string, cwd: string, choice: AgentChoice, force = false): Promise<string[]> {
  const kinds: readonly AgentKind[] = AGENT_CHOICES[choice];
  const lines: string[] = [];
  const update = `p3 agents ${choice} --force`;
  const source = readFileSync(SKILL_SOURCE, "utf8");
  for (const k of kinds) {
    const t = AGENT_TARGETS[k];
    const skill = join(root, t.path);
    const shown = relative(cwd, skill) || skill;
    if (!existsSync(skill)) {
      await mkdir(dirname(skill), { recursive: true });
      await copyFile(SKILL_SOURCE, skill);
      lines.push(`  作成  AI 向けのスキル（${t.agent}）を ${shown} に置きました`);
      continue;
    }
    const now = readFileSync(skill, "utf8");
    if (now === source) lines.push(`  同一  AI 向けのスキル（${t.agent}）${shown} は最新です`);
    else if (force) {
      await copyFile(SKILL_SOURCE, skill);
      lines.push(`  更新  AI 向けのスキル（${t.agent}）${shown} を同梱の版にしました`);
    } else {
      lines.push(`  保護  ※ ${shown}（${t.agent}）は既にあり、同梱の版と違うので上書きしません（${firstDiffLine(now, source)} 行目から違います）。最新にするなら ${update}（原本: ${SKILL_SOURCE}）`);
    }
  }

  // 指示の節のスキルの参照: 置いた先と、既にある先（後から片方を足したとき、もう片方も指す。無い先は書かない）
  const refs = KINDS.filter((k) => kinds.includes(k) || existsSync(join(root, AGENT_TARGETS[k].path)));
  const snippet = agentsSnippet(refs);
  const file = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(root, f))) ?? "AGENTS.md";
  const target = join(root, file);
  const shown = relative(cwd, target) || target;
  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  const sections = findSections(text);
  if (!sections.length && !text.includes(AGENTS_MARK)) {
    await appendFile(target, text ? snippet : snippet.replace(/^\n/, ""));
    lines.push(`  作成  AI 向けの使い方を ${shown} に${text ? "追記しました" : "書きました"}`);
  } else if (sections.length !== 1) {
    lines.push(
      `  保護  ※ ${shown} の「${AGENTS_MARK}」の節が${sections.length ? `${sections.length} つあります` : "見出しとして見つかりません"}。どこまでが p3 の節か決められないので変えません。手で1つの節（見出し「## ${AGENTS_MARK}」）に整理してから、もう一度実行してください`,
    );
  } else {
    const all = text.split("\n");
    const { start, end, level } = sections[0];
    // 見出しの段は今のもの（### などで書かれていればそのまま）
    const body = snippet.replace(/^\n/, "").replace(/^## /, `${"#".repeat(level)} `);
    const current = all.slice(start, end).join("\n");
    if (current.trim() === body.trim()) lines.push(`  同一  AI 向けの使い方（${shown} の節）は最新です`);
    else if (force) {
      const before = all.slice(0, start).join("\n");
      const after = all.slice(end).join("\n");
      await writeFile(target, `${before}${before ? "\n" : ""}${body.trimEnd()}\n${after ? `\n${after.replace(/^\n+/, "")}` : ""}`);
      lines.push(`  更新  AI 向けの使い方（${shown} の「${AGENTS_MARK}」の節）を置き換えました（前後の文はそのまま）`);
    } else {
      lines.push(`  保護  ※ ${shown} の「${AGENTS_MARK}」の節は同梱の版と違うので変えません。最新にするなら ${update}（節だけを置き換えます）`);
    }
  }
  return lines;
}

export interface InitOptions {
  cwd: string;
  /** 個人設定に登録する名前（既定: リポジトリのフォルダ名） */
  project?: string;
  /** データを置くフォルダ（既定はリポジトリのルートの .p3。端末では聞く）。相対パスは実行した場所から */
  dir?: string;
  name?: string;
  description?: string;
  instructions?: string;
  /** AI 向けの使い方を置く先（未指定なら、対話では聞き（Enter は置かない）、非対話では置かない） */
  agents?: AgentChoice;
  yes?: boolean;
  /** このリポジトリの参照先の名前（既定はフォルダ名） */
  repoName?: string;
  /** 対話の問い（既定は端末の readline。テストが答えを渡す）。渡すと対話として聞く */
  prompt?: (question: string) => Promise<string>;
}

/** 対話の問い（--yes・非対話なら既定値のまま）。使い終えたら close */
function prompter(o: { yes?: boolean; prompt?: (q: string) => Promise<string> }) {
  const interactive = !o.yes && (!!o.prompt || (process.stdin.isTTY && process.stdout.isTTY));
  const rl = interactive && !o.prompt ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const question = o.prompt ?? (rl ? (q: string) => rl.question(q) : undefined);
  const ask = async (q: string, def: string) => {
    if (!question) return def;
    const a = (await question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  };
  return { interactive: !!question, ask, close: () => rl?.close() };
}

/** プロジェクト名とデータのフォルダ（init・join で同じ決め方。未指定はルートの .p3、指定は相対なら実行した場所から・~・絶対） */
async function projectAndDir(o: { cwd: string; project?: string; dir?: string }, root: string, ask: (q: string, def: string) => Promise<string>, dirQuestion: string) {
  const key = await ask("プロジェクト名（切り替えに使う短い名前）", o.project ?? slugifyName(basename(root)) ?? "project");
  if (!PROJECT_NAME.test(key)) throw new UsageError(`プロジェクト名は英数字と . _ - で: ${key}`);
  // 明示した空のパスは未指定と分けて断る
  if (o.dir !== undefined && !o.dir.trim()) throw new UsageError("--dir が空です。既定（リポジトリのルートの .p3）にするなら --dir を付けずに実行してください");
  const dir = resolvePath(o.cwd, o.dir ?? (await ask(dirQuestion, join(root, DATA_DIR_NAME))));
  return { key, dir };
}

/** --dir の案内（既定の場所なら付けない） */
const dirHint = (dir: string, root: string) => (dir === join(root, DATA_DIR_NAME) ? "" : ` --dir ${dir}`);

/**
 * p3 init。管理したいリポジトリの中で実行し、新しくプロジェクトを作る（作るだけ。既にあるプロジェクトへの参加は p3 join）。
 *   - データを置くフォルダに project.yaml と requests/ を作る。既定はリポジトリのルート（git のメインの作業ツリー。
 *     git 管理外なら実行した場所）の .p3。サブフォルダや追加の作業ツリーから実行してもルートの .p3 にする。
 *     公開できないデータや、リポジトリと別に管理したいときは --dir でリポジトリの外を指せる
 *   - そのフォルダに既に project.yaml があれば、何も書かずに断って p3 join を案内する（--agents を付けても置かない）
 *   - 個人設定に「プロジェクト名 → フォルダ・手元のリポジトリ」を登録する。以後はリポジトリの中なら指定が要らない
 * 端末から実行すると対話式で聞き、--yes か非対話（AI・スクリプト）なら引数と推測した既定値で作る。
 */
export async function init(o: InitOptions): Promise<string> {
  const root = repoRoot(o.cwd);
  const user = await loadUserConfig();
  const { interactive, ask, close } = prompter(o);

  try {
    if (interactive) console.log(`p3 のプロジェクトを作ります（リポジトリ: ${root}）\n（Enter で [ ] 内の既定値）\n`);
    const { key, dir } = await projectAndDir(o, root, ask, "データを置くフォルダ（相対パスは今いる場所から。リポジトリの外も指定できます）");

    // 既にあるプロジェクト: 作らず、何も書かない（参加は join、AI 向けの使い方は agents）
    if (existsSync(join(dir, "project.yaml"))) {
      throw new UsageError(
        [
          `${dir} には既にプロジェクトがあります（init は新しく作るだけです。何も変えていません）`,
          `  参加するなら: p3 join --project ${key}${dirHint(dir, root)}`,
          ...(o.agents ? ["  AI 向けの使い方を置く・最新にするなら: p3 agents claude|codex|both"] : []),
        ].join("\n"),
      );
    }
    const registered = user.projects[key];
    if (registered && registered.dir !== dir) throw new UsageError(`プロジェクト名「${key}」は別のフォルダで登録済みです: ${registered.dir}`);
    const refName = o.repoName ?? slugifyName(basename(root)) ?? "app";
    if (repoNameProblem(refName)) throw new UsageError(`参照先の名前: ${repoNameProblem(refName)}（--repo-name で指定してください）`);

    // 既定値: git とリポジトリの中身から推測する
    const docsFound = DOC_CANDIDATES.filter((d) => existsSync(join(root, d)));
    const name = o.name ?? key;
    const description = await ask("何を作っているプロジェクトか（Preflight の前提になります）", o.description ?? "");
    // ドキュメントは本体（最初に読む）の主なフォルダにする。Preflight は評価の前に必要な範囲で読む。
    // フォルダの入口は、その中に README.md / index.md があればそれ（任意）
    const docs = splitList(await ask("最初に読むドキュメント（カンマ区切り。Preflight が評価の前に読みます）", docsFound.join(", ")));
    const map = docs.map((d) => {
      const entry = DOC_ENTRIES.map((e) => `${d}/${e}`).find((e) => existsSync(join(root, e)));
      return { path: d, role: "ドキュメント", ...(entry ? { entry } : {}) };
    });
    const instructions = await ask("Preflight で重視する観点・制約（任意）", o.instructions ?? "");
    // 既にある AGENTS.md / CLAUDE.md からは推測しない（Enter は置かない）
    let agents = o.agents;
    if (agents === undefined && interactive) {
      const a = await ask("AI 向けの p3 の使い方（スキルと AGENTS.md / CLAUDE.md の節）を置く先（置かない / claude / codex / both）", "置かない");
      if (!["置かない", "none", "n", "no"].includes(a)) {
        if (!isAgentChoice(a)) throw new UsageError(`置く先は 置かない / claude / codex / both のどれか: ${a}`);
        agents = a;
      }
    }

    const cfg: ProjectConfig = {
      name,
      description,
      // このリポジトリを本体の参照先にする（このマシンのパスは個人設定に持ち、共有するデータには書かない）
      repos: [{ name: refName, role: "本体", readFirst: true, writable: true, map }],
      milestones: [],
      branchPattern: "req/{id}-{slug}",
      preflight: { instructions },
    };
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeProjectFile(join(dir, "project.yaml"), cfg);
    await writeRepoEntry(join(dir, "project.yaml"), refName, cfg.repos[0]);
    await register(key, dir, refName, root);

    const agentLines = agents ? await placeAgents(root, o.cwd, agents) : [];
    return [
      `作りました: ${key} → ${dir}`,
      `  参照先        ${refName}（本体） → ${root}`,
      `  主なフォルダ  ${map.map((m) => m.path).join(", ") || "（なし。設定画面で足せます）"}`,
      `  個人設定      ${userConfigPath()} に登録しました`,
      ...agentLines,
      "",
      "次に: p3 request new \"<やりたいこと>\" --body \"...\"  →  p3 preflight <要望ID>（Codex にサインインしたマシン。p3 whoami で分かる）か、手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼む  →  p3 serve",
      cfg.description ? "" : "※ description が空です。p3 config set description=\"...\" で設定してください（Preflight の精度に効きます）",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n")
      .trimEnd();
  } finally {
    close();
  }
}

/** 最新の個人設定の上で、このプロジェクトの登録だけを書く（聞いている間にほかで変わっていても、ほかの登録・項目は消さない） */
function register(key: string, dir: string, refName: string | undefined, root: string) {
  return updateUserConfig((doc, now) => {
    const prev = now.projects[key];
    if (prev && prev.dir !== dir) throw new UsageError(`プロジェクト名「${key}」は別のフォルダで登録済みです: ${prev.dir}`);
    setProjectNode(doc, key, { dir, repos: refName ? { ...prev?.repos, [refName]: root } : (prev?.repos ?? {}) });
  });
}

/** 参加する前に、データのフォルダが読める p3 のプロジェクトかを確かめ、共有の定義（読むだけ）を返す */
async function readSharedProject(dir: string): Promise<ProjectConfig> {
  const create = "新しく作るなら p3 init";
  const st = await stat(dir).catch((e: NodeJS.ErrnoException) => e);
  if (st instanceof Error) {
    throw new UsageError(
      st.code === "ENOENT"
        ? `データのフォルダがありません: ${dir}（パスと、共有のフォルダがつながっているかを確かめてください。${create}）`
        : `データのフォルダを読めません: ${dir}（${st.code ?? st.message}）`,
    );
  }
  if (!st.isDirectory()) throw new UsageError(`データのフォルダがフォルダではありません: ${dir}`);
  const file = join(dir, "project.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new UsageError(
      code === "ENOENT"
        ? `${dir} は p3 のプロジェクトではありません（project.yaml がありません）。指したフォルダと中身を確かめてください（参加では作りません。${create}）`
        : `project.yaml を読めません: ${file}（${code ?? (e as Error).message}）`,
    );
  }
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    throw new UsageError(`project.yaml を読めません（YAML として壊れています）: ${file}: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new UsageError(`project.yaml の中身が p3 の設定ではありません: ${file}`);
  return normalizeProject(data as Record<string, unknown>);
}

export interface JoinOptions {
  cwd: string;
  project?: string;
  dir?: string;
  repoName?: string;
  yes?: boolean;
  prompt?: (question: string) => Promise<string>;
}

/**
 * p3 join。既にあるプロジェクト（ほかの人が作って共有したデータのフォルダ）に参加する。個人設定に
 * 「プロジェクト名 → フォルダ・このリポジトリのこのマシンのパス」を登録するだけで、共有の定義・データ・
 * AI 向けのファイル（スキル・AGENTS.md / CLAUDE.md）は書かない。データのフォルダの既定と指定の仕方は init と同じ。
 *   - このリポジトリを登録する参照先: --repo-name（共有の定義にある名前）→ フォルダ名と同じ名前 → 参照先が1つならそれ。
 *     決まらなければ登録せず p3 repo path を案内する
 *   - 同じ名前で別のフォルダは断る。同じ名前・同じフォルダ・同じパスなら何もしない（成功）
 */
export async function joinProject(o: JoinOptions): Promise<string> {
  const root = repoRoot(o.cwd);
  const { interactive, ask, close } = prompter(o);
  try {
    if (interactive) console.log(`p3 のプロジェクトに参加します（リポジトリ: ${root}）\n（Enter で [ ] 内の既定値）\n`);
    const { key, dir } = await projectAndDir(o, root, ask, "参加するデータのフォルダ（相対パスは今いる場所から）");
    const shared = (await readSharedProject(dir)).repos;
    let refName: string | undefined;
    if (o.repoName !== undefined) {
      if (!shared.some((r) => r.name === o.repoName)) {
        throw new UsageError(`参照先「${o.repoName}」は共有の定義にありません（あるもの: ${shared.map((r) => r.name).join(", ") || "なし"}）`);
      }
      refName = o.repoName;
    } else {
      const derived = slugifyName(basename(root));
      refName = (shared.find((r) => r.name === derived) ?? (shared.length === 1 ? shared[0] : undefined))?.name;
    }
    const user = await loadUserConfig();
    const prev = user.projects[key];
    if (prev && prev.dir !== dir) throw new UsageError(`プロジェクト名「${key}」は別のフォルダで登録済みです: ${prev.dir}`);
    if (prev && (!refName || prev.repos[refName] === root)) return `登録済みです: ${key} → ${dir}（変えていません）`;
    await register(key, dir, refName, root);
    return [
      `参加しました: ${key} → ${dir}`,
      refName
        ? `  参照先 ${refName}  ${root}`
        : `  このリポジトリを参照先として登録していません。p3 repo ls で名前を確かめ、p3 repo path <名前> ${root} で登録してください`,
      `  個人設定 ${userConfigPath()} に登録しました（データ・リポジトリのファイルは変えていません）`,
      "",
      "次に: p3 request ls  /  p3 serve",
    ].join("\n");
  } finally {
    close();
  }
}

/** p3 project [ls | add <名前> <フォルダ> | rm <名前>]: 個人設定のプロジェクトの一覧・登録・登録解除（データは消さない） */
export async function projectCommand(
  cwd: string,
  args: string[],
  o: { repo?: string },
  current: string | undefined,
): Promise<{ data: unknown; text: string }> {
  const user = await loadUserConfig();
  const [sub = "ls", name, dirRaw] = args;
  if (sub === "ls") {
    const rows = Object.entries(user.projects).map(([n, p]) => ({ name: n, ...p, current: n === current }));
    const w = Math.max(4, ...rows.map((r) => r.name.length));
    return {
      data: rows,
      text: rows.length
        ? rows.map((r) => `${r.current ? "*" : " "} ${r.name.padEnd(w)}  ${r.dir}${Object.keys(r.repos).length ? `  （参照先 ${Object.keys(r.repos).join(", ")}）` : ""}`).join("\n")
        : "登録済みのプロジェクトはありません。管理したいリポジトリの中で p3 init --project <名前>（新しく作る）か p3 join --project <名前>（参加する）",
    };
  }
  if (sub === "add") {
    if (!name || !dirRaw) throw new UsageError("p3 project add <名前> <フォルダ>");
    if (o.repo) throw new UsageError("--repo は使えなくなりました。登録したあと、p3 repo path <参照先の名前> <パス> でこのマシンのパスを登録してください");
    if (!PROJECT_NAME.test(name)) throw new UsageError(`プロジェクト名は英数字と . _ - で: ${name}`);
    const dir = resolvePath(cwd, dirRaw);
    if (!existsSync(join(dir, "project.yaml"))) throw new UsageError(`${dir} はまだ p3 のプロジェクトではありません。作るときは管理したいリポジトリの中で p3 init`);
    const saved = await updateUserConfig((doc, now) => {
      const prev = now.projects[name];
      if (prev && prev.dir !== dir) throw new UsageError(`「${name}」は別のフォルダで登録済みです: ${prev.dir}`);
      const next = { dir, repos: prev?.repos ?? {} };
      setProjectNode(doc, name, next);
      return next;
    });
    return {
      data: { name, ...saved },
      text: `登録しました: ${name} → ${dir}\n  参照先のこのマシンのパスは p3 --project ${name} repo ls で確かめ、p3 repo path <名前> <パス> で登録してください`,
    };
  }
  if (sub === "rm") {
    if (!name) throw new UsageError("p3 project rm <名前>");
    await updateUserConfig((doc, now) => {
      if (!now.projects[name]) throw new UsageError(`登録されていません: ${name}`);
      setProjectNode(doc, name, null);
    });
    return { data: { name }, text: `登録を外しました: ${name}（データのフォルダはそのまま）` };
  }
  throw new UsageError("p3 project [ls | add <名前> <フォルダ> | rm <名前>]");
}
const slugifyName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "") || undefined;

