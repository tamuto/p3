import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoNameProblem, type CodeMapEntry, type RepoRef } from "../shared/repos.ts";
import { writeRepoEntry } from "./store/projectFile.ts";
import type { Workspace } from "./store/workspace.ts";
import { setProjectNode, updateUserConfig } from "./userConfig.ts";

/**
 * 参照先の登録・変更・削除（CLI の p3 repo と設定画面で共通）。
 *   共有の定義は project.yaml の repos（その1件だけを書く。コメント・ほかの項目は残す）
 *   このマシンのパスは個人設定の projects.<プロジェクト>.repos.<名前>（共有しない）
 */
export class RepoAdminError extends Error {}

/** 共有の定義のうち、変えてよい項目 */
export type RepoPatch = Partial<Pick<RepoRef, "role" | "readFirst" | "writable" | "map">>;

const file = (ws: Workspace) => join(ws.dataDir, "project.yaml");

function cleanMap(map: CodeMapEntry[]): CodeMapEntry[] {
  return map
    .map((m) => ({ path: m.path.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, ""), role: m.role.trim(), ...(m.entry?.trim() ? { entry: m.entry.trim() } : {}) }))
    .filter((m) => m.path);
}

export async function addRepo(ws: Workspace, name: string, patch: RepoPatch = {}): Promise<RepoRef> {
  const problem = repoNameProblem(name);
  if (problem) throw new RepoAdminError(`参照先の名前: ${problem}`);
  if (ws.project.repos.some((r) => r.name === name)) throw new RepoAdminError(`「${name}」は既にあります`);
  const entry: RepoRef = { name, role: patch.role?.trim() ?? "", readFirst: !!patch.readFirst, writable: !!patch.writable, map: cleanMap(patch.map ?? []) };
  await writeRepoEntry(file(ws), name, entry);
  await ws.refreshProject();
  return entry;
}

export async function updateRepo(ws: Workspace, name: string, patch: RepoPatch): Promise<RepoRef> {
  const cur = ws.project.repos.find((r) => r.name === name);
  if (!cur) throw new RepoAdminError(`「${name}」はありません`);
  const next: RepoRef = {
    ...cur,
    ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
    ...(patch.readFirst !== undefined ? { readFirst: patch.readFirst } : {}),
    ...(patch.writable !== undefined ? { writable: patch.writable } : {}),
    ...(patch.map !== undefined ? { map: cleanMap(patch.map) } : {}),
  };
  await writeRepoEntry(file(ws), name, next);
  await ws.refreshProject();
  return next;
}

/** 共有の定義を消す（ほかの人の Preflight でも読まなくなる。フォルダは消さない）。このマシンのパスも外す */
export async function removeRepo(ws: Workspace, projectName: string | undefined, name: string) {
  if (!ws.project.repos.some((r) => r.name === name)) throw new RepoAdminError(`「${name}」はありません`);
  await writeRepoEntry(file(ws), name, null);
  if (projectName) await setLocalRepoPath(ws, projectName, name, null).catch(() => undefined);
  await ws.refreshProject();
}

/** このマシンのパスとして使えるか（フォルダであること。git でなくてよい） */
export function checkFolder(path: string) {
  if (!existsSync(path)) throw new RepoAdminError(`パスがありません: ${path}`);
  if (!statSync(path).isDirectory()) throw new RepoAdminError(`フォルダではありません: ${path}`);
}

/** このマシンのパスを登録する（null で外す）。フォルダであること（git でなくてよい）。共有の定義は変えない */
export async function setLocalRepoPath(ws: Workspace, projectName: string | undefined, name: string, path: string | null) {
  if (!projectName) throw new RepoAdminError("このプロジェクトは個人設定に登録されていません。先に p3 project add <名前> <フォルダ> で登録してください");
  if (path !== null) {
    if (!ws.project.repos.some((r) => r.name === name)) throw new RepoAdminError(`「${name}」は参照先にありません（先に共有の定義を足してください）`);
    checkFolder(path);
  }
  await updateUserConfig((doc, now) => {
    const prev = now.projects[projectName];
    if (!prev) throw new RepoAdminError(`プロジェクト「${projectName}」は個人設定に登録されていません`);
    const repos = { ...prev.repos };
    if (path === null) delete repos[name];
    else repos[name] = path;
    setProjectNode(doc, projectName, { dir: prev.dir, repos });
  });
  ws.setLocalRepo(name, path);
}
