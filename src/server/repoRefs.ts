import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { effectiveRepos, LEGACY_REPO, mountNames, type RefScope, type RepoRef } from "../shared/repos.ts";
import type { ProjectConfig } from "../shared/types.ts";

/**
 * 参照先（共有の定義）と、このマシンのパス（個人設定）を合わせたもの。
 *
 *   ok           手元のパスがあり、フォルダとして読める
 *   unregistered 手元のパスが登録されていない（p3 repo path <名前> <パス> で登録する）
 *   missing      登録したパスが無い
 *   notdir       登録したパスがフォルダではない
 *
 * git のリポジトリでなくてもよい（フォルダだけ・リポジトリの中のサブフォルダも可）。
 */
export interface ResolvedRef extends RepoRef {
  /** コンテナの中の名前（/workspace/<mount>） */
  mount: string;
  status: "ok" | "unregistered" | "missing" | "notdir";
  /** このマシンのパス（共有の記録には残さない） */
  local?: string;
  /** 見られないときの理由 */
  reason?: string;
  /** 共有の repos が無い今までのプロジェクトの、ただ1つの参照先 */
  legacy?: boolean;
}

/**
 * 解決の順（名前ごと）: 個人設定の repos.<名前> → （共有の repos が無いときだけ）今までのリポジトリ
 * （個人設定の repos.main・その最初の項目 → project.yaml の repo）。共有の repos があるのに手元の対応が無い名前は unregistered。
 */
export function resolveRefs(project: ProjectConfig, opts: { dataDir: string; localRepos?: Record<string, string>; repoOverride?: string }): ResolvedRef[] {
  const local = opts.localRepos ?? {};
  const legacy = !project.repos.length;
  const repos = effectiveRepos(project.repos);
  const mounts = mountNames(repos.map((r) => r.name));
  return repos.map((r, i) => {
    let path = local[r.name];
    if (!path && legacy) {
      path = opts.repoOverride ?? local[LEGACY_REPO] ?? Object.values(local)[0];
      if (!path && project.repo) path = isAbsolute(project.repo) ? project.repo : resolve(opts.dataDir, project.repo);
    }
    const base = { ...r, mount: mounts[i], ...(legacy ? { legacy: true } : {}) };
    if (!path) return { ...base, status: "unregistered" as const, reason: "このマシンのパスが登録されていません" };
    try {
      const st = statSync(path);
      if (!st.isDirectory()) return { ...base, status: "notdir" as const, local: path, reason: `フォルダではありません: ${path}` };
    } catch {
      return { ...base, status: "missing" as const, local: path, reason: `登録したパスがありません: ${path}` };
    }
    return { ...base, status: "ok" as const, local: path };
  });
}

export function refScope(r: ResolvedRef): RefScope {
  const reason =
    r.status === "unregistered"
      ? `このマシンのパスが登録されていません（p3 repo path ${r.name} <パス>）`
      : r.status === "missing"
        ? "登録したパスがありません"
        : r.status === "notdir"
          ? "登録したパスがフォルダではありません"
          : undefined;
  return { name: r.name, mount: r.mount, role: r.role, readFirst: r.readFirst, status: r.status, ...(reason ? { reason } : {}) };
}
