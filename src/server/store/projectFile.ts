import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { ProjectConfig } from "../../shared/types.ts";
import { writeFileAtomic } from "./fsutil.ts";

const ORDER: (keyof ProjectConfig)[] = [
  "name", "description", "repo", "docs", "milestones", "branchPattern", "worktreeDir", "preflight",
];

/** project.yaml に書く形。既定値のままの項目や空の項目は省き、人が読み書きしやすく保つ */
function toPlain(cfg: ProjectConfig): Record<string, unknown> {
  return {
    name: cfg.name,
    description: cfg.description || undefined,
    repo: cfg.repo,
    docs: cfg.docs.length ? cfg.docs : undefined,
    milestones: cfg.milestones.length
      ? cfg.milestones.map((m) => Object.fromEntries(Object.entries({ id: m.id, title: m.title, due: m.due, done: m.done || undefined }).filter(([, v]) => v !== undefined)))
      : undefined,
    branchPattern: cfg.branchPattern,
    worktreeDir: cfg.worktreeDir,
    preflight: cfg.preflight.instructions ? { instructions: cfg.preflight.instructions } : undefined,
  };
}

/**
 * project.yaml を書く。既存のファイルがあれば YAML の文書として更新し、人が書いたコメントを残す。
 */
export async function writeProjectFile(path: string, cfg: ProjectConfig): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  const doc = text.trim() ? YAML.parseDocument(text) : new YAML.Document({});
  const plain = toPlain(cfg);
  doc.delete("statuses"); // 以前は列を設定できた。今は未着手 / 作業中 / 完了で固定
  for (const key of ORDER) {
    const value = plain[key];
    if (value === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(value));
  }
  await writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
}
