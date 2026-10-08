import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { REQUEST_ID } from "../shared/refs.ts";
import type { ProjectConfig } from "../shared/types.ts";
import type { PcubeContext } from "../server/context.ts";
import { resolveRequestId } from "../server/ops.ts";
import { DATA_DIR_NAME } from "../server/store/locate.ts";
import { writeProjectFile } from "../server/store/projectFile.ts";
import type { Workspace } from "../server/store/workspace.ts";

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

export const AGENTS_SNIPPET = `
## タスク管理（pcube）

- 作業の単位は要望（\`.pcube/requests/<要望ID>/\`）。タスクは \`pcube\` CLI で操作し、\`--json\` で結果を読むこと
- 変更するときは環境変数 \`PCUBE_ACTOR=ai:<エージェント名>\` を付ける
- 要望の作業ツリーの中では要望の指定を省ける（それ以外では \`--req <要望ID>\`）
- 着手するときは \`pcube move T003 doing\`、終えたら \`pcube move T003 done --output <PR の URL など>\`
- 作業中に新しく必要になった作業は \`pcube new "<タイトル>" --body "..."\` でタスクにする（人への質問はタスクにしない）
- 関係と影響範囲は \`pcube show T003 --json\` で確認し、\`pcube link T004 depends_on T003\` で張る
`;

export interface InitOptions {
  cwd: string;
  dir?: string;
  name?: string;
  description?: string;
  docs?: string;
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
  if (existsSync(join(dir, "project.yaml"))) throw new UsageError(`${dir} は既に初期化されています（変更は pcube config）`);

  // 既定値: git とリポジトリの中身から推測する
  const docsFound = DOC_CANDIDATES.filter((d) => existsSync(join(root, d)));
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
    const instructions = await ask("Preflight で重視する観点・制約（任意）", o.instructions ?? "");
    const addAgents =
      o.agents ?? (rl ? /^y/i.test(await ask(`${agentsFile ?? "AGENTS.md"} に AI 向けの pcube の使い方を追記しますか (y/n)`, agentsFile ? "y" : "n")) : false);

    const cfg: ProjectConfig = {
      name,
      description,
      repo: relative(dir, root) || ".",
      docs,
      milestones: [],
      branchPattern: "req/{id}-{slug}",
      worktreeDir: ".worktrees",
      preflight: { instructions },
    };
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
      addAgents ? `  AI 向けの使い方を ${relative(o.cwd, target)} に追記しました` : "",
      "",
      "次に: pcube request new \"<やりたいこと>\" --body \"...\"  →  pcube preflight <要望ID>  →  pcube serve",
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
