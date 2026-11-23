import { userInfo } from "node:os";
import { join, relative, resolve } from "node:path";
import { REQUEST_ID } from "../../../shared/refs.ts";
import type { P3Context } from "../../../core/context.ts";
import { resolveRequestId } from "../../../core/ops.ts";
import { repoNameProblem } from "../../../shared/repos.ts";
import { addRepo, checkFolder, RepoAdminError, removeRepo, setLocalRepoPath, updateRepo, type RepoPatch } from "../core/repoAdmin.ts";
import { requestWorkstreams } from "../../../shared/workTarget.ts";
import type { ProjectPatch, Workspace } from "../../../core/store/workspace.ts";
import { sortMilestones } from "../../../shared/milestoneOrder.ts";
import { git, resolvePath, UsageError } from "@infodb/p3-shared/node/usage.ts";

/**
 * tasks のプロジェクトの設定と作業の文脈（CLI）: 変更者・今いる参照先・今の要望の判定、p3 config・p3 repo（project.yaml の共有の定義と
 * このマシンのパス）。プロジェクトの登録・参加・AI 向けの入口は入口の project.ts
 */

/**
 * CLI の変更者。明示（--actor / P3_ACTOR。AI は ai:<名前>）→ human:<git の user.name> → OS のユーザー名。
 */
export function resolveActor(explicit: string | undefined, cwd: string): string {
  if (explicit) return explicit;
  return `human:${git(cwd, "config", "user.name") ?? process.env.USER ?? userInfo().username}`;
}

/** 今いる場所が、どの参照先（リポジトリ・フォルダ）か。参照先の中か、その git のリポジトリの作業ツリーの中なら当たる */
export function locateHere(ctx: P3Context, cwd: string): { repos: string[]; branch?: string } {
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
 * 今の要望。明示（--req / P3_REQUEST）→ 今いる参照先のブランチ（その参照先の割当だけと照らす）→
 * ブランチ名に要望 ID が入っている（detached HEAD などで決まらなければ --req で指定してもらう）。
 * パスに要望 ID が入っているだけでは決めない。候補が複数なら --req を案内する。
 * AI が要望の作業ツリーで作業していれば、`p3 new "..."` だけでその要望のタスクになる。
 */
export function currentRequest(ctx: P3Context, explicit: string | undefined, cwd: string): string | undefined {
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


const CONFIG_KEYS = ["name", "description", "branchPattern", "instructions"] as const;

/** p3 config [set key=value ...] */
export async function config(ws: Workspace, args: string[]): Promise<{ data: unknown; text: string }> {
  if (args[0] === "set") {
    const patch: ProjectPatch = {};
    for (const pair of args.slice(1)) {
      const eq = pair.indexOf("=");
      const key = pair.slice(0, eq) as (typeof CONFIG_KEYS)[number];
      const value = pair.slice(eq + 1).trim();
      if ((key as string) === "preflight.runner") {
        throw new UsageError("preflight.runner（Preflight の担当）はなくなりました。Codex にサインインしたマシンでは p3 preflight で、そうでなければ手元の AI エージェントに頼んで評価します（p3 whoami の Preflight の行）");
      }
      if (eq < 1 || !CONFIG_KEYS.includes(key)) throw new UsageError(`設定できるキー: ${CONFIG_KEYS.join(", ")}`);
      if (key === "instructions") patch.preflight = { ...patch.preflight, instructions: value };
      else if (key === "branchPattern" && !value.includes("{id}")) throw new UsageError("branchPattern には {id} を含めてください");
      else if (key === "name" && !value) throw new UsageError(`${key} は空にできません`);
      else patch[key] = value;
    }
    if (!Object.keys(patch).length) throw new UsageError("p3 config set キー=値 ...");
    const next = await ws.saveProject(patch);
    const keys = args.slice(1).map((p) => p.slice(0, p.indexOf("=")));
    return { data: next, text: `更新しました: ${keys.join(", ")}` };
  }
  const p = ws.project;
  const text = [
    `name           ${p.name}`,
    `description    ${p.description || "（なし）"}`,
    `repos          ${p.repos.map((r) => r.name).join(", ") || "（なし）"}  (p3 repo ls)`,
    `milestones     ${sortMilestones(p.milestones).map((m) => `${m.id}${m.due ? `(${m.due})` : ""}${m.done ? "[済]" : ""}`).join(", ") || "（なし）"}`,
    `branchPattern  ${p.branchPattern}`,
    `instructions   ${p.preflight.instructions || "（なし）"}`,
    "",
    `ファイル: ${join(ws.dataDir, "project.yaml")}`,
  ].join("\n");
  return { data: p, text };
}

export function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/**
 * p3 repo: Preflight が読む参照先（リポジトリ・フォルダ）。共有の定義（project.yaml の repos）と、このマシンのパス
 * （個人設定の projects.<プロジェクト>.repos）を分けて扱う。
 *
 *   ls                               一覧（このマシンのパスが無いものは登録の仕方を出す）
 *   add <名前> [<パス>] [キー=値 ...]  共有の定義を足す（パスを渡せばこのマシンのパスも登録する）
 *   set <名前> キー=値 ...            共有の定義を変える（role readFirst writable）
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
  const usage = "p3 repo [ls | add <名前> [<パス>] [role=… readFirst=true writable=true] | set <名前> キー=値 … | path <名前> <パス> | rm <名前> [--local]]";

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
      } else throw new UsageError(`変えられるキー: role readFirst writable（主なフォルダ map は設定画面か project.yaml で）`);
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
          r.map.length ? `\n    主なフォルダ: ${r.map.map((m) => (m.entry ? `${m.path}（入口 ${m.entry}）` : m.path)).join(", ")}` : ""
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
    if (!rest.length) throw new UsageError("キー=値 を指定してください（role readFirst writable）");
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
