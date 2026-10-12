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
import { writeProjectFile, writeRepoEntry } from "../server/store/projectFile.ts";
import { repoNameProblem } from "../shared/repos.ts";
import { addRepo, checkFolder, RepoAdminError, removeRepo, setLocalRepoPath, updateRepo, type RepoPatch } from "../server/repoAdmin.ts";
import { Workspace as WorkspaceStore } from "../server/store/workspace.ts";
import { requestWorkstreams } from "../shared/workTarget.ts";
import type { Workspace } from "../server/store/workspace.ts";
import { loadUserConfig, PROJECT_NAME, setProjectNode, updateUserConfig, userConfigPath } from "../server/userConfig.ts";

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

/** 今いる場所が、どの参照先（リポジトリ・フォルダ）か。参照先の中か、その git のリポジトリの作業ツリーの中なら当たる */
export function locateHere(ctx: PcubeContext, cwd: string): { repos: string[]; branch?: string } {
  const here = resolve(cwd);
  const common = git(here, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const repos = ctx.ws
    .refs()
    .filter((r) => r.status === "ok" && r.local)
    .filter((r) => {
      if (inside(here, r.local!)) return true;
      // 要望の作業ツリーの中: 参照先と同じ git のリポジトリで、作業ツリーの中の同じ場所（サブフォルダなら同じ相対位置）より下
      if (!common) return false;
      const theirs = git(r.local!, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (theirs !== common) return false;
      const top = git(here, "rev-parse", "--show-toplevel");
      const theirTop = git(r.local!, "rev-parse", "--show-toplevel");
      return !!top && !!theirTop && inside(here, join(top, relative(theirTop, r.local!)));
    })
    .map((r) => r.name);
  const branch = common ? git(here, "symbolic-ref", "--quiet", "--short", "HEAD") : undefined;
  return { repos, branch };
}

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * 今の要望。明示（--req / PCUBE_REQUEST）→ 今いる参照先のブランチ（その参照先の割当だけと照らす）→
 * ブランチ名に要望 ID が入っている（detached HEAD などで決まらなければ --req で指定してもらう）。
 * パスに要望 ID が入っているだけでは決めない。候補が複数なら --req を案内する。
 * AI が要望の作業ツリーで作業していれば、`pcube new "..."` だけでその要望のタスクになる。
 */
export function currentRequest(ctx: PcubeContext, explicit: string | undefined, cwd: string): string | undefined {
  if (explicit) {
    const id = resolveRequestId(ctx, explicit);
    if (!id) throw new UsageError(`要望が見つかりません: ${explicit}`);
    return id;
  }
  const { repos: hereRepos, branch } = locateHere(ctx, cwd);
  const requests = ctx.ws.requests.list();
  const pick = (ids: string[], why: string) => {
    const uniq = [...new Set(ids)];
    if (uniq.length > 1) throw new UsageError(`${why}が複数の要望に当たります: ${uniq.join(", ")}。--req <要望ID> で指定してください`);
    return uniq[0];
  };
  if (branch) {
    // 今いる参照先の割当だけと照らす（別のリポジトリの同じ名前のブランチと取り違えない）。参照先の外なら全部と照らす
    const byBranch = requests
      .filter((r) => Object.entries(requestWorkstreams(r)).some(([name, w]) => w.branch === branch && (!hereRepos.length || hereRepos.includes(name))))
      .map((r) => r.id);
    const hit = pick(byBranch, `ブランチ ${branch} `);
    if (hit) return hit;
  }
  if (branch) {
    const m = new RegExp(REQUEST_ID.source.slice(1, -1)).exec(branch);
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
- 着手する前に、\`--brief --json\` の \`work\`（作業先のリポジトリとブランチ）を見て、そのリポジトリでブランチに入る（作業先なしなら移動しない）
- 着手するときは \`p3 move T003 doing\`、終えたら \`p3 move T003 done --output <PR の URL など>\`。複数のリポジトリにまたがるときは最後のタスクに \`--repo-output <参照先>=<PR の URL>\` で全部の PR を残す
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
  /** このリポジトリの参照先の名前（既定はフォルダ名） */
  repoName?: string;
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
    // このリポジトリを参照先として登録する名前（新しく作るときは本体として共有の定義も書く。参加するときは同じ名前の参照先か、
    // 参照先が1つならそれ。決まらなければ登録せず p3 repo path を案内する）
    const joining = existsSync(join(dir, "project.yaml"));
    const shared = joining ? (await (async () => { const ws = new WorkspaceStore(dir); await ws.load(); return ws.project.repos; })()) : [];
    const derived = o.repoName ?? slugifyName(basename(root)) ?? "app";
    const refName = joining ? (shared.find((r) => r.name === derived) ?? (shared.length === 1 ? shared[0] : undefined))?.name : derived;
    if (!joining && repoNameProblem(refName!)) throw new UsageError(`参照先の名前: ${repoNameProblem(refName!)}（--repo-name で指定してください）`);
    // 最新の個人設定の上で、このプロジェクトの登録だけを書く（聞いている間にほかで変わっていても消さない）
    const register = () =>
      updateUserConfig((doc, now) => {
        const prev = now.projects[key];
        if (prev && prev.dir !== dir) throw new UsageError(`プロジェクト名「${key}」は別のフォルダで登録済みです: ${prev.dir}`);
        setProjectNode(doc, key, { dir, repos: refName ? { ...prev?.repos, [refName]: root } : (prev?.repos ?? {}) });
      });

    const agentsFile = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(root, f)));
    const askAgents = async () =>
      o.agents ??
      (rl ? /^y/i.test(await ask(`${agentsFile ?? "AGENTS.md"} と .claude/skills/ に AI 向けの p3 の使い方を置きますか (y/n)`, agentsFile ? "y" : "n")) : false);

    // 既に作られたフォルダなら参加だけ
    if (joining) {
      if (registered && (!refName || registered.repos[refName] === root)) throw new UsageError(`${key}（${dir}）は登録済みです（設定の変更は p3 config）`);
      const addAgents = await askAgents();
      await register();
      return [
        `参加しました: ${key} → ${dir}`,
        refName
          ? `  参照先 ${refName}  ${root}`
          : `  このリポジトリを参照先として登録していません。p3 repo ls で名前を確かめ、p3 repo path <名前> ${root} で登録してください`,
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
      // このリポジトリを本体の参照先にする（このマシンのパスは個人設定に持ち、共有するデータには書かない）
      repos: [{ name: refName!, role: "本体", readFirst: true, writable: true, map: [] }],
      docs,
      milestones: [],
      branchPattern: "req/{id}-{slug}",
      preflight: { instructions },
    };
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeProjectFile(join(dir, "project.yaml"), cfg);
    await writeRepoEntry(join(dir, "project.yaml"), refName!, cfg.repos[0]);
    await register();

    const agentLines = addAgents ? await placeAgents(root, o.cwd) : [];
    return [
      `作りました: ${key} → ${dir}`,
      `  参照先        ${refName}（本体） → ${root}`,
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
        ? rows.map((r) => `${r.current ? "*" : " "} ${r.name.padEnd(w)}  ${r.dir}${Object.keys(r.repos).length ? `  （参照先 ${Object.keys(r.repos).join(", ")}）` : ""}`).join("\n")
        : "登録済みのプロジェクトはありません。管理したいリポジトリの中で p3 init --project <名前> --dir <フォルダ>",
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

/** 入力されたパス。対話式の入力ではシェルが ~ を展開しないので、ここで展開する */
export const resolvePath = (cwd: string, p: string) => resolve(cwd, p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const slugifyName = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "") || undefined;

const CONFIG_KEYS = ["name", "description", "docs", "branchPattern", "instructions"] as const;

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
      else if (key === "name" && !value) throw new UsageError(`${key} は空にできません`);
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
    `repos          ${p.repos.map((r) => r.name).join(", ") || "（なし）"}  (p3 repo ls)`,
    `docs           ${p.docs.join(", ") || "（なし）"}`,
    `milestones     ${p.milestones.map((m) => `${m.id}${m.due ? `(${m.due})` : ""}${m.done ? "[済]" : ""}`).join(", ") || "（なし）"}`,
    `branchPattern  ${p.branchPattern}`,
    `instructions   ${p.preflight.instructions || "（なし）"}`,
    "",
    `ファイル: ${join(ws.dataDir, "project.yaml")}`,
  ].join("\n");
  return { data: p, text };
}

function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * p3 repo: Preflight が読む参照先（リポジトリ・フォルダ）。共有の定義（project.yaml の repos）と、このマシンのパス
 * （個人設定の projects.<プロジェクト>.repos）を分けて扱う。
 *
 *   ls                               一覧（このマシンのパスが無いものは登録の仕方を出す）
 *   add <名前> [<パス>] [キー=値 ...]  共有の定義を足す（パスを渡せばこのマシンのパスも登録する）
 *   set <名前> キー=値 ...            共有の定義を変える（role readFirst writable mapFile）
 *   path <名前> <パス>               このマシンのパスだけを登録する（ほかの人が足した参照先に）
 *   rm <名前> [--local]              共有の定義とこのマシンのパスを消す（--local はこのマシンのパスだけ）
 */
export async function repoCommand(
  ws: Workspace,
  projectName: string | undefined,
  cwd: string,
  args: string[],
  o: { local?: boolean },
): Promise<{ data: unknown; text: string }> {
  const [sub = "ls", name, ...rest] = args;
  const shared = () => ws.project.repos.find((r) => r.name === name);
  const usage = "p3 repo [ls | add <名前> [<パス>] [role=… readFirst=true writable=true mapFile=…] | set <名前> キー=値 … | path <名前> <パス> | rm <名前> [--local]]";

  const pairs = (list: string[]): RepoPatch => {
    const patch: RepoPatch = {};
    for (const pair of list) {
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1).trim();
      if (key === "role") patch.role = value;
      else if (key === "readFirst" || key === "writable") {
        if (!["true", "false"].includes(value)) throw new UsageError(`${key} は true か false`);
        patch[key] = value === "true";
      } else if (key === "mapFile") patch.mapFile = value;
      else throw new UsageError(`変えられるキー: role readFirst writable mapFile（コードの地図 map は設定画面か project.yaml で）`);
    }
    return patch;
  };
  /** 共通の操作の失敗は使い方の誤りとして出す */
  const run = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof RepoAdminError) throw new UsageError(e.message);
      throw e;
    }
  };
  const folder = (raw: string) => resolvePath(cwd, raw);

  if (sub === "ls") {
    const refs = ws.refs();
    const rows = refs.map((r) => ({ ...r, local: r.local ?? null }));
    const text = [
      ...(!refs.length ? ["（参照先はまだありません。足すときは p3 repo add <名前> <パス> role=…）"] : []),
      ...refs.map((r) => {
        const flags = [r.readFirst && "最初に読む", r.writable && "作業先候補"].filter(Boolean).join("・");
        const where =
          r.status === "ok" ? r.local : r.status === "unregistered" ? `未登録 → p3 repo path ${r.name} <このマシンのパス>` : `${r.reason}`;
        return `${r.name}${r.role ? `（${r.role}）` : ""}${flags ? ` [${flags}]` : ""}  /workspace/${r.mount}\n    ${where}${
          r.map.length || r.mapFile ? `\n    地図: ${[...r.map.map((m) => m.path), ...(r.mapFile ? [`${r.mapFile}（Markdown）`] : [])].join(", ")}` : ""
        }`;
      }),
    ].join("\n");
    return { data: rows, text };
  }
  if (!name) throw new UsageError(usage);
  const problem = repoNameProblem(name);
  if (problem && sub !== "rm") throw new UsageError(`参照先の名前: ${problem}`);

  if (sub === "add") {
    const maybePath = rest[0] && !rest[0].includes("=") ? rest[0] : undefined;
    const patch = pairs(maybePath ? rest.slice(1) : rest);
    if (shared()) throw new UsageError(`「${name}」は既にあります。変えるときは p3 repo set ${name} キー=値、このマシンのパスは p3 repo path ${name} <パス>`);
    const path = maybePath ? folder(maybePath) : undefined;
    if (path) await run(async () => checkFolder(path));
    const entry = await run(() => addRepo(ws, name, patch));
    if (path) await run(() => setLocalRepoPath(ws, projectName, name, path));
    return {
      data: { ...entry, local: path ?? null },
      text: `参照先を足しました: ${name}${entry.role ? `（${entry.role}）` : ""}${path ? ` → ${path}` : `（このマシンのパスは未登録: p3 repo path ${name} <パス>）`}`,
    };
  }
  if (sub === "set") {
    if (!shared()) throw new UsageError(`「${name}」はありません。足すときは p3 repo add ${name} <パス>`);
    if (!rest.length) throw new UsageError("キー=値 を指定してください（role readFirst writable mapFile）");
    const next = await run(() => updateRepo(ws, name, pairs(rest)));
    return { data: next, text: `参照先を変えました: ${name}` };
  }
  if (sub === "path") {
    if (!shared()) throw new UsageError(`「${name}」は共有の参照先にありません（p3 repo ls）。足すときは p3 repo add ${name} <パス>`);
    if (!rest[0]) throw new UsageError(`p3 repo path ${name} <このマシンのパス>`);
    const path = folder(rest[0]);
    await run(() => setLocalRepoPath(ws, projectName, name, path));
    return { data: { name, local: path }, text: `このマシンのパスを登録しました: ${name} → ${path}（共有の定義は変えていません）` };
  }
  if (sub === "rm") {
    if (o.local) {
      await run(() => setLocalRepoPath(ws, projectName, name, null));
      return { data: { name, local: null }, text: `このマシンのパスを外しました: ${name}（共有の定義は残しています。ほかの人には影響しません）` };
    }
    if (!shared()) throw new UsageError(`「${name}」は共有の参照先にありません。このマシンのパスだけを外すときは --local`);
    await run(() => removeRepo(ws, projectName, name));
    return { data: { name }, text: `参照先を消しました: ${name}（共有の定義。ほかの人の Preflight でも読まなくなります。ファイルやフォルダは消していません）` };
  }
  throw new UsageError(usage);
}
