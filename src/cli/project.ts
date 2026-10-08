import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_STATUSES, type Member, type ProjectConfig } from "../shared/types.ts";
import { DATA_DIR_NAME } from "../server/store/locate.ts";
import { writeProjectFile } from "../server/store/projectFile.ts";
import type { Workspace } from "../server/store/workspace.ts";
import { table } from "./format.ts";

/** プロジェクトの初期設定・設定変更・メンバー管理（CLI） */

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
 * CLI の変更者。明示（--actor / PCUBE_ACTOR）→ git の user.email が一致するメンバー → OS のユーザー名。
 */
export function resolveActor(ws: Workspace, explicit: string | undefined, cwd: string): string {
  if (explicit) return explicit;
  const email = git(cwd, "config", "user.email");
  const m = email && ws.project.members.find((x) => x.email && x.email.toLowerCase() === email.toLowerCase());
  if (m) return `${m.kind}:${m.id}`;
  return `human:${process.env.USER ?? userInfo().username}`;
}

const DOC_CANDIDATES = ["docs", "doc", "README.md", "ARCHITECTURE.md", "DESIGN.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];

export const AGENTS_SNIPPET = `
## タスク管理（pcube）

- タスクは \`.pcube/\` で管理している。操作は \`pcube\` CLI を使い、\`--json\` で結果を読むこと
- 変更するときは環境変数 \`PCUBE_ACTOR=ai:<エージェント名>\` を付ける
- 着手前に \`pcube find <語句>\` で対象を特定し、\`pcube show <ID> --json\` で関係と影響範囲を確認する
- 状態は \`pcube move <ID> <status>\`、関係は \`pcube link <ID> <種類> <相手>\` で変える
- 他者の変更を上書きしないよう、取得した rev を \`--rev\` に渡す（競合すると終了コード 3）
`;

export interface InitOptions {
  cwd: string;
  dir?: string;
  name?: string;
  description?: string;
  docs?: string;
  members?: string[];
  instructions?: string;
  agents?: boolean;
  yes?: boolean;
}

/**
 * pcube init。リポジトリのルートに .pcube/ を作り、プロジェクトの初期設定を書く。
 * 端末から実行すると対話式で聞き、--yes か非対話（AI・スクリプト）なら引数と推測した既定値で作る。
 */
export async function init(o: InitOptions): Promise<string> {
  const root = repoRoot(o.cwd);
  const dir = o.dir ? join(o.cwd, o.dir) : join(root, DATA_DIR_NAME);
  if (existsSync(join(dir, "project.yaml"))) throw new UsageError(`${dir} は既に初期化されています（変更は pcube config / pcube member）`);

  // 既定値: git とリポジトリの中身から推測する
  const docsFound = DOC_CANDIDATES.filter((d) => existsSync(join(root, d)));
  const gitName = git(root, "config", "user.name");
  const gitEmail = git(root, "config", "user.email");
  const me: Member = {
    id: (gitEmail?.split("@")[0] ?? process.env.USER ?? userInfo().username).replace(/[^A-Za-z0-9._-]/g, ""),
    name: gitName ?? process.env.USER ?? "me",
    email: gitEmail,
    role: "owner",
    kind: "human",
  };
  const agentsFile = ["AGENTS.md", "CLAUDE.md"].find((f) => existsSync(join(root, f)));

  const interactive = !o.yes && process.stdin.isTTY && process.stdout.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (q: string, def: string) => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def;
  };

  try {
    if (rl) console.log(`pcube のプロジェクトを作ります: ${dir}\n（Enter で [ ] 内の既定値）\n`);
    const name = await ask("プロジェクト名", o.name ?? basename(root));
    const description = await ask("何を作っているプロジェクトか（Preflight の前提になります）", o.description ?? "");
    const docs = splitList(await ask("ドキュメントのパス（カンマ区切り。Preflight で最初に読みます）", o.docs ?? docsFound.join(", ")));
    const members = o.members?.length ? o.members.map(parseMember) : [me];
    if (rl) {
      console.log(`メンバー: ${members.map(formatMember).join(", ")}`);
      for (;;) {
        const more = await ask("メンバーを追加（id:表示名:メール、空で終了）", "");
        if (!more) break;
        members.push(parseMember(more));
      }
    }
    const instructions = await ask("Preflight で重視する観点・制約（任意）", o.instructions ?? "");
    const addAgents =
      o.agents ?? (rl ? /^y/i.test(await ask(`${agentsFile ?? "AGENTS.md"} に AI 向けの pcube の使い方を追記しますか (y/n)`, agentsFile ? "y" : "n")) : false);

    const cfg: ProjectConfig = {
      name,
      description,
      repo: relative(dir, root) || ".",
      docs,
      members,
      statuses: DEFAULT_STATUSES,
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      preflight: { instructions },
    };
    await mkdir(join(dir, "tasks"), { recursive: true });
    await mkdir(join(dir, "requests"), { recursive: true });
    await writeProjectFile(join(dir, "project.yaml"), cfg);

    const target = join(root, agentsFile ?? "AGENTS.md");
    if (addAgents && !(existsSync(target) && readFileSync(target, "utf8").includes("タスク管理（pcube）"))) {
      await appendFile(target, AGENTS_SNIPPET);
    }
    return [
      `初期化しました: ${relative(o.cwd, dir) || "."}/project.yaml`,
      `  プロジェクト  ${cfg.name}`,
      `  ドキュメント  ${cfg.docs.join(", ") || "（なし）"}`,
      `  メンバー      ${cfg.members.map(formatMember).join(", ")}`,
      addAgents ? `  AI 向けの使い方を ${relative(o.cwd, target)} に追記しました` : "",
      "",
      "次に: pcube new request \"<やりたいこと>\" --body \"...\"  →  pcube preflight 1  →  pcube serve",
      cfg.description ? "" : "※ description が空です。pcube config set description=\"...\" で設定してください（Preflight の精度に効きます）",
    ]
      .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
      .join("\n")
      .trimEnd();
  } finally {
    rl?.close();
  }
}

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
    `repo           ${p.repo}  (${ws.repoRoot})`,
    `docs           ${p.docs.join(", ") || "（なし）"}`,
    `members        ${p.members.map(formatMember).join(", ") || "（なし）"}`,
    `statuses       ${p.statuses.map((s) => `${s.id}${s.done ? "(完了)" : ""}`).join(" → ")}`,
    `branchPattern  ${p.branchPattern}`,
    `worktreeDir    ${p.worktreeDir}`,
    `instructions   ${p.preflight.instructions || "（なし）"}`,
    "",
    `ファイル: ${join(ws.dataDir, "project.yaml")}`,
  ].join("\n");
  return { data: p, text };
}

/** pcube member [add <id> --name --email --role --ai | rm <id>] */
export async function member(
  ws: Workspace,
  args: string[],
  o: { name?: string; email?: string; role?: string; ai?: boolean },
): Promise<{ data: unknown; text: string }> {
  const [sub, id] = args;
  const members = ws.project.members;
  if (sub === "add") {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError("pcube member add <id>（英数字と . _ -）");
    const existing = members.find((m) => m.id === id);
    const next: Member = {
      id,
      name: o.name ?? existing?.name ?? id,
      email: o.email ?? existing?.email,
      role: o.role ?? existing?.role,
      kind: o.ai ? "ai" : (existing?.kind ?? "human"),
    };
    const list = existing ? members.map((m) => (m.id === id ? next : m)) : [...members, next];
    await ws.saveProject({ members: list });
    return { data: next, text: `${existing ? "更新" : "追加"}しました: ${formatMember(next)}` };
  }
  if (sub === "rm" || sub === "remove") {
    if (!members.some((m) => m.id === id)) throw new UsageError(`メンバーがいません: ${id}`);
    const assigned = ws.tasks.list().filter((t) => t.assignee === id);
    await ws.saveProject({ members: members.filter((m) => m.id !== id) });
    return {
      data: { removed: id, assigned: assigned.map((t) => t.id) },
      text: `外しました: ${id}${assigned.length ? `（担当中のタスク: ${assigned.map((t) => t.id).join(", ")}）` : ""}`,
    };
  }
  if (sub && sub !== "ls" && sub !== "list") throw new UsageError("pcube member [ls | add <id> | rm <id>]");
  const counts = (mid: string) => ws.tasks.list().filter((t) => t.assignee === mid).length;
  return {
    data: members,
    text: members.length
      ? table(members.map((m) => [m.id, m.name, m.kind === "ai" ? "AI" : "", m.role ?? "", m.email ?? "", `担当 ${counts(m.id)}`]))
      : "メンバーはいません（pcube member add <id> --name 表示名 --email メール）",
  };
}

function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** "id:表示名:メール" */
function parseMember(s: string): Member {
  const [id, name, email] = s.split(":").map((x) => x.trim());
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError(`メンバーは id:表示名:メール の形で（id は英数字）: ${s}`);
  return { id, name: name || id, email: email || undefined, kind: "human" };
}

function formatMember(m: Member) {
  return `${m.name}(${m.id}${m.kind === "ai" ? ", AI" : ""})`;
}
