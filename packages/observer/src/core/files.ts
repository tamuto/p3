import { existsSync, realpathSync, statSync } from "node:fs";
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
