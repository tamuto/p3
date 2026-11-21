import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { FileState } from "../shared/definition.ts";

/**
 * 参照先の中でファイルの有無を照らす（AI の出力とは別に、確かめられる範囲で）。repoPath は参照先の名前 → このマシンのパス（入口・アプリが渡す）。
 * 参照先を読めなければ unverified、参照先の外を指す（シンボリックリンクを含めて）・無いなら planned
 */
export function fileChecker(repoPath: (repo: string) => string | undefined): (repo: string, path: string) => FileState {
  return (repo, path) => {
    const root = repoPath(repo);
    if (!root || !existsSync(root) || !statSync(root).isDirectory()) return "unverified";
    const target = resolve(root, path);
    if (!existsSync(target)) return "planned";
    const inside = relative(realpathSync(root), realpathSync(target));
    return inside.startsWith("..") || resolve(inside) === inside ? "planned" : "exists";
  };
}

/** 参照先の中のファイルの内容の sha256（参照先を読めない・参照先の外・無い・ファイルでないなら undefined。期待の比較基準に使う） */
export function fileHasher(repoPath: (repo: string) => string | undefined): (repo: string, path: string) => string | undefined {
  const state = fileChecker(repoPath);
  return (repo, path) => {
    if (state(repo, path) !== "exists") return undefined;
    const target = resolve(repoPath(repo)!, path);
    if (!statSync(target).isFile()) return undefined;
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  };
}
