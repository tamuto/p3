import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { REQUEST_ID } from "../shared/refs.ts";
import type { ProjectConfig } from "../shared/types.ts";
import type { PcubeContext } from "../server/context.ts";
import { resolveRequestId } from "../server/ops.ts";
import { mainWorktree } from "../server/store/locate.ts";
import { writeProjectFile } from "../server/store/projectFile.ts";
import type { Workspace } from "../server/store/workspace.ts";
import { loadUserConfig, PROJECT_NAME, saveUserConfig, userConfigPath } from "../server/userConfig.ts";

/** プロジェクトの初期設定・設定変更、変更者と「今の要望」の判定（CLI） */

export class UsageError extends Error {}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** リポジトリのルート（git のメインの作業ツリー）。git 管理外ならカレント */
export function repoRoot(cwd: string): string {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common?.endsWith("/.git")) return common.slice(0, -"/.git".length);
  return git(cwd, "rev-parse", "--show-toplevel") ?? cwd;
}

/**
 * CLI の変更者。明示（--actor / PCUBE_ACTOR。AI は ai:<名前>）→ human:<git の user.name> → OS のユーザー名。
 */
export function resolveActor(explicit: string | undefined, cwd: string): string {
  if (explicit) return explicit;
  return `human:${git(cwd, "config", "user.name") ?? process.env.USER ?? userInfo().username}`;
}

/**
 * 今の要望。明示（--req / PCUBE_REQUEST）→ git のブランチ（要望の作業ツリー req/<要望ID>-...）→ 作業ツリーのパス。
 * AI が要望の作業ツリーで作業していれば、`pcube new "..."` だけでその要望のタスクになる。
 */
export function currentRequest(ctx: PcubeContext, explicit: string | undefined, cwd: string): string | undefined {
  if (explicit) {
    const id = resolveRequestId(ctx, explicit);
    if (!id) throw new UsageError(`要望が見つかりません: ${explicit}`);
    return id;
  }
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const requests = ctx.ws.requests.list();
  const byBranch = branch && requests.find((r) => r.workstream?.branch === branch);
  if (byBranch) return byBranch.id;
  for (const s of [branch ?? "", cwd]) {
    const m = new RegExp(REQUEST_ID.source.slice(1, -1)).exec(s);
    if (m && ctx.ws.requests.get(m[0])) return m[0];
  }
  return undefined;
}

const DOC_CANDIDATES = ["docs", "doc", "README.md", "ARCHITECTURE.md", "DESIGN.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

const AGENTS_MARK = "タスク管理（infodb p3）";

/**
 * p3 init --agents で AGENTS.md / CLAUDE.md に追記する指示。手順の詳しい版は同梱のスキル（skills/p3/SKILL.md）で、
 * 役割と終わり方はそちらとそろえる（test/agents.test.ts が確かめる）
 */
export const AGENTS_SNIPPET = `
## ${AGENTS_MARK}

- 作業の単位は要望。タスクは \`p3\` CLI（入っていなければ \`pnpx @infodb/p3\`）で操作し、\`--json\` で結果を読むこと（データのフォルダを直接編集しない）。
  詳しい手順は \`.claude/skills/p3/SKILL.md\`
- 変更するときは環境変数 \`PCUBE_ACTOR=ai:<エージェント名>\` を付ける
- 操作する要望は \`--req <要望ID>\` で指定する（要望の作業ツリーの中なら省ける）。まず \`p3 whoami\` で確かめる
- 新しい作業を頼まれたら \`p3 request new "<タイトル>" --body "..."\` で要望を登録し、ID を伝えて終える。
  Preflight（\`preflight\`）とタスク化（\`accept\`）は人が行う（AI は実行しない。結果を \`p3 drafts\` で読むのと、頼まれたメモの保存 \`--note-only\` はよい）
- 着手する前に \`p3 show T003 --brief --json\` で本文・依存とその状態（\`dependencies\`）・置き換えの注意（\`warnings\`）を読む
- 着手するときは \`p3 move T003 doing\`、終えたら \`p3 move T003 done --output <PR の URL など>\`
- 要望のタスクを全部終えたら \`p3 request set <要望ID> status=resolved\`（対応済）にする。完了済（done）・見送り（rejected）とタスクの済み（check）は人が決める
- 置き換えられたタスク（\`p3 ls\` の \`※置換\`、\`--json\` の \`superseded\`）からは始めない。\`move\` が \`warnings\` を返したら止めて人に確かめる
- 作業中に新しく必要になった作業は \`p3 new "<タイトル>" --body "..."\` でタスクにする（人への質問はタスクにしない）
- 関係と影響範囲を調べるときは \`--brief\` を付けずに \`p3 show T003 --json\` で確認し、\`p3 link T004 depends_on T003\` で張る
`;

/** 同梱のスキルの原本と、プロジェクトに置く場所（Claude Code のプロジェクトのスキル） */
export const SKILL_SOURCE = fileURLToPath(new URL("../../skills/p3/SKILL.md", import.meta.url));
export const SKILL_TARGET = ".claude/skills/p3/SKILL.md";

/**
 * --agents: AGENTS.md（無ければ CLAUDE.md、どちらも無ければ AGENTS.md を作る）に指示を追記し、スキルを置く。
 * 指示は見出しがあれば足さない。スキルは同じ内容なら何もせず、違えば上書きしない（手で直したものを消さない）。
 */
async function placeAgents(root: string, cwd: string): Promise<string[]> {
  const lines: string[] = [];
  const agentsFile = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(root, f)));
  const target = join(root, agentsFile ?? "AGENTS.md");
  if (existsSync(target) && readFileSync(target, "utf8").includes(AGENTS_MARK)) {
    lines.push(`  AI 向けの使い方は ${relative(cwd, target) || target} に書いてあります（追記しません）`);
  } else {
    await appendFile(target, AGENTS_SNIPPET);
    lines.push(`  AI 向けの使い方を ${relative(cwd, target) || target} に追記しました`);
  }
  const skill = join(root, SKILL_TARGET);
  const source = readFileSync(SKILL_SOURCE, "utf8");
  if (!existsSync(skill)) {
    await mkdir(dirname(skill), { recursive: true });
    await copyFile(SKILL_SOURCE, skill);
    lines.push(`  AI 向けのスキルを ${relative(cwd, skill)} に置きました`);
  } else if (readFileSync(skill, "utf8") === source) {
    lines.push(`  AI 向けのスキル ${relative(cwd, skill)} は最新です`);
  } else {
    lines.push(
      `  ※ ${relative(cwd, skill)} は既にあり、同梱の版と違うので上書きしません。手で見比べて更新してください: ${SKILL_SOURCE}`,
    );
  }
  return lines;
}

export interface InitOptions {
  cwd: string;
  /** 個人設定に登録する名前（既定: リポジトリのフォルダ名） */
  project?: string;
  /** データを置くフォルダ（必須。端末では聞く） */
  dir?: string;
  name?: string;
  description?: string;
  docs?: string;
  instructions?: string;
  agents?: boolean;
  yes?: boolean;
}

/**
 * p3 init。管理したいリポジトリの中で実行する。
 *   - データを置くフォルダ（場所は自由。リポジトリの外を勧める）に project.yaml と requests/ を作る
 *   - 既に作られたフォルダ（他の人が作って共有したもの）を指したら、作らずに参加だけする
 *   - どちらの場合も個人設定に「プロジェクト名 → フォルダ・手元のリポジトリ」を登録する。以後はリポジトリの中なら指定が要らない
 * 端末から実行すると対話式で聞き、--yes か非対話（AI・スクリプト）なら引数と推測した既定値で作る。
 */
export async function init(o: InitOptions): Promise<string> {
  const root = repoRoot(o.cwd);
  const inRepo = !!mainWorktree(o.cwd);
  const user = await loadUserConfig();

  const interactive = !o.yes && process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (q: string, def: string) => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  };

  try {
    if (rl) console.log(`p3 のプロジェクトを作ります（リポジトリ: ${root}）\n（Enter で [ ] 内の既定値）\n`);
    const key = await ask("プロジェクト名（切り替えに使う短い名前）", o.project ?? slugifyName(basename(root)) ?? "project");
    if (!PROJECT_NAME.test(key)) throw new UsageError(`プロジェクト名は英数字と . _ - で: ${key}`);
    const dirRaw = o.dir ?? (await ask("データを置くフォルダ（リポジトリの外を勧めます）", ""));
    if (!dirRaw) throw new UsageError("データを置くフォルダを指定してください。例: p3 init --project myapp --dir ~/p3-data/myapp");
    const dir = resolvePath(o.cwd, dirRaw);

    const registered = user.projects[key];
    if (registered && registered.dir !== dir) throw new UsageError(`プロジェクト名「${key}」は別のフォルダで登録済みです: ${registered.dir}`);
    const register = async () => {
      user.projects[key] = { dir, repos: inRepo ? { ...registered?.repos, main: root } : (registered?.repos ?? {}) };
      await saveUserConfig(user);
    };

    const agentsFile = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(root, f)));
    const askAgents = async () =>
      o.agents ??
      (rl ? /^y/i.test(await ask(`${agentsFile ?? "AGENTS.md"} と .claude/skills/ に AI 向けの p3 の使い方を置きますか (y/n)`, agentsFile ? "y" : "n")) : false);

    // 既に作られたフォルダなら参加だけ
    if (existsSync(join(dir, "project.yaml"))) {
      if (registered && (!inRepo || registered.repos.main === root)) throw new UsageError(`${key}（${dir}）は登録済みです（設定の変更は p3 config）`);
      const addAgents = await askAgents();
      await register();
      return [
        `参加しました: ${key} → ${dir}`,
        inRepo ? `  リポジトリ  ${root}` : "",
        ...(addAgents ? await placeAgents(root, o.cwd) : []),
        "",
        "次に: p3 request ls  /  p3 serve",
      ]
        .filter((l, i) => l || i > 1)
        .join("\n");
    }

    // 既定値: git とリポジトリの中身から推測する
    const docsFound = DOC_CANDIDATES.filter((d) => existsSync(join(root, d)));
    const name = o.name ?? key;
    const description = await ask("何を作っているプロジェクトか（Preflight の前提になります）", o.description ?? "");
    const docs = splitList(await ask("ドキュメントのパス（カンマ区切り。Preflight で最初に読みます）", o.docs ?? docsFound.join(", ")));
    const instructions = await ask("Preflight で重視する観点・制約（任意）", o.instructions ?? "");
    const addAgents = await askAgents();

    const cfg: ProjectConfig = {
      name,
      description,
      // 手元のリポジトリの場所は個人設定に持つ。共有するデータには、リポジトリの中に置く（.pcube/）ときの相対パスだけ書く
      repo: dir.startsWith(`${root}/`) ? relative(dir, root) : "",
      docs,
      milestones: [],
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      preflight: { instructions },
    };
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeProjectFile(join(dir, "project.yaml"), cfg);
    await register();

    const agentLines = addAgents ? await placeAgents(root, o.cwd) : [];
    return [
      `作りました: ${key} → ${dir}`,
      inRepo ? `  リポジトリ    ${root}` : "",
      `  ドキュメント  ${cfg.docs.join(", ") || "（なし）"}`,
      `  個人設定      ${userConfigPath()} に登録しました`,
      ...agentLines,
      "",
      "次に: p3 request new \"<やりたいこと>\" --body \"...\"  →  p3 preflight <要望ID>  →  p3 serve",
      cfg.description ? "" : "※ description が空です。p3 config set description=\"...\" で設定してください（Preflight の精度に効きます）",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n")
      .trimEnd();
  } finally {
    rl?.close();
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
        ? rows.map((r) => `${r.current ? "*" : " "} ${r.name.padEnd(w)}  ${r.dir}${r.repos.main ? `  （リポジトリ ${r.repos.main}）` : ""}`).join("\n")
        : "登録済みのプロジェクトはありません。管理したいリポジトリの中で p3 init --project <名前> --dir <フォルダ>",
    };
  }
  if (sub === "add") {
    if (!name || !dirRaw) throw new UsageError("p3 project add <名前> <フォルダ> [--repo <リポジトリ>]");
    if (!PROJECT_NAME.test(name)) throw new UsageError(`プロジェクト名は英数字と . _ - で: ${name}`);
    const dir = resolvePath(cwd, dirRaw);
    if (!existsSync(join(dir, "project.yaml"))) throw new UsageError(`${dir} はまだ p3 のプロジェクトではありません。作るときは管理したいリポジトリの中で p3 init`);
    if (user.projects[name] && user.projects[name].dir !== dir) throw new UsageError(`「${name}」は別のフォルダで登録済みです: ${user.projects[name].dir}`);
    const repo = o.repo ? resolvePath(cwd, o.repo) : mainWorktree(cwd);
    user.projects[name] = { dir, repos: repo ? { ...user.projects[name]?.repos, main: repo } : (user.projects[name]?.repos ?? {}) };
    await saveUserConfig(user);
    return { data: { name, ...user.projects[name] }, text: `登録しました: ${name} → ${dir}${repo ? `（リポジトリ ${repo}）` : ""}` };
  }
  if (sub === "rm") {
    if (!name || !user.projects[name]) throw new UsageError(`登録されていません: ${name ?? ""}`);
    delete user.projects[name];
    await saveUserConfig(user);
    return { data: { name }, text: `登録を外しました: ${name}（データのフォルダはそのまま）` };
  }
  throw new UsageError("p3 project [ls | add <名前> <フォルダ> | rm <名前>]");
}

/** 入力されたパス。対話式の入力ではシェルが ~ を展開しないので、ここで展開する */
export const resolvePath = (cwd: string, p: string) => resolve(cwd, p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const slugifyName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "") || undefined;

const CONFIG_KEYS = ["name", "description", "docs", "branchPattern", "worktreeDir", "instructions", "repo"] as const;

/** pcube config [set key=value ...] */
export async function config(ws: Workspace, args: string[]): Promise<{ data: unknown; text: string }> {
  if (args[0] === "set") {
    const patch: Partial<ProjectConfig> = {};
    for (const pair of args.slice(1)) {
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq) as (typeof CONFIG_KEYS)[number];
      const value = pair.slice(eq + 1).trim();
      if (eq < 1 || !CONFIG_KEYS.includes(key)) throw new UsageError(`設定できるキー: ${CONFIG_KEYS.join(", ")}`);
      if (key === "docs") patch.docs = splitList(value);
      else if (key === "instructions") patch.preflight = { instructions: value };
      else if (key === "branchPattern" && !value.includes("{id}")) throw new UsageError("branchPattern には {id} を含めてください");
      else if ((key === "name" || key === "repo" || key === "worktreeDir") && !value) throw new UsageError(`${key} は空にできません`);
      else patch[key] = value;
    }
    if (!Object.keys(patch).length) throw new UsageError("pcube config set キー=値 ...");
    const next = await ws.saveProject(patch);
    const keys = args.slice(1).map((p) => p.slice(0, p.indexOf("=")));
    return { data: next, text: `更新しました: ${keys.join(", ")}` };
  }
  const p = ws.project;
  const text = [
    `name           ${p.name}`,
    `description    ${p.description || "（なし）"}`,
    `repo           ${ws.repoRoot}${p.repo ? `  (project.yaml: ${p.repo})` : "  (個人設定)"}`,
    `docs           ${p.docs.join(", ") || "（なし）"}`,
    `milestones     ${p.milestones.map((m) => `${m.id}${m.due ? `(${m.due})` : ""}${m.done ? "[済]" : ""}`).join(", ") || "（なし）"}`,
    `branchPattern  ${p.branchPattern}`,
    `worktreeDir    ${p.worktreeDir}`,
    `instructions   ${p.preflight.instructions || "（なし）"}`,
    "",
    `ファイル: ${join(ws.dataDir, "project.yaml")}`,
  ].join("\n");
  return { data: p, text };
}

function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
