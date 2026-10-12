import { statSync } from "node:fs";
import { mountNames, type RefScope, type RepoRef } from "../shared/repos.ts";
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
}

/** 共有の定義ごとに、個人設定の repos.<名前>（このマシンのパス）を合わせる。手元の対応が無い名前は unregistered */
export function resolveRefs(project: ProjectConfig, opts: { localRepos?: Record<string, string> }): ResolvedRef[] {
  const local = opts.localRepos ?? {};
  const mounts = mountNames(project.repos.map((r) => r.name));
  return project.repos.map((r, i) => {
    const path = local[r.name];
    const base = { ...r, mount: mounts[i] };
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
