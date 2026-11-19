import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * 参照先のフォルダで git の履歴が使えるか。コンテナには参照先のフォルダだけを読むだけでマウントするので、
 * 履歴の本体（.git）がフォルダの中にあるときだけ使える。浅い clone は途中までしか無い
 */
export function gitHistory(local: string): NonNullable<RefScope["history"]> {
  const dotGit = join(local, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    // 上に .git があれば、リポジトリの中のサブフォルダ（履歴の本体はマウントの外）
    for (let d = dirname(resolve(local)); d !== dirname(d); d = dirname(d)) {
      if (existsSync(join(d, ".git"))) return { status: "unavailable", reason: "リポジトリの中のサブフォルダなので、履歴の本体（.git）がマウントの外にあります" };
    }
    return { status: "unavailable", reason: "git のリポジトリではありません" };
  }
  if (st.isFile()) {
    // git の作業ツリー（worktree）・サブモジュール: .git は本体の場所を指すファイル
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    const gitdir = m ? resolve(local, m[1].trim()) : undefined;
    const inside = gitdir && !relative(local, gitdir).startsWith("..") && !isAbsolute(relative(local, gitdir));
    if (!inside) return { status: "unavailable", reason: "git の作業ツリーなので、履歴の本体がマウントの外にあります（メインのチェックアウトを参照先にすると使えます）" };
    return { status: "ok" };
  }
  if (existsSync(join(dotGit, "shallow"))) return { status: "shallow", reason: "浅い clone なので、履歴は途中までです" };
  return { status: "ok" };
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
  return {
    name: r.name,
    mount: r.mount,
    role: r.role,
    readFirst: r.readFirst,
    status: r.status,
    ...(reason ? { reason } : {}),
    ...(r.status === "ok" && r.local ? { history: gitHistory(r.local) } : {}),
  };
}
