import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { RepoRef } from "../../shared/repos.ts";
import type { ProjectConfig } from "../../shared/types.ts";
import { writeFileAtomic } from "./fsutil.ts";

/** 設定の保存（画面・p3 config）で書き換える項目。repos は p3 repo だけが項目ごとに書く（writeRepoEntry） */
const ORDER: (keyof ProjectConfig)[] = ["name", "description", "milestones", "branchPattern", "preflight"];
/** ファイルの中の並び */
const RANK: (keyof ProjectConfig)[] = ["name", "description", "repos", "milestones", "branchPattern", "preflight"];

/** project.yaml に書く形。既定値のままの項目や空の項目は省き、人が読み書きしやすく保つ */
function toPlain(cfg: ProjectConfig): Partial<Record<keyof ProjectConfig, unknown>> {
  return {
    name: cfg.name,
    description: cfg.description || undefined,
    milestones: cfg.milestones.length
      ? cfg.milestones.map((m) => Object.fromEntries(Object.entries({ id: m.id, title: m.title, due: m.due, done: m.done || undefined }).filter(([, v]) => v !== undefined)))
      : undefined,
    branchPattern: cfg.branchPattern,
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
  dropLegacy(doc);
  for (const key of ORDER) {
    const value = plain[key];
    if (value === undefined) doc.delete(key);
    else doc.set(key, doc.createNode(value));
  }
  sortKeys(doc);
  await writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
}

/** 以前のプロジェクトの docs（どの保存でも消す）。今は参照先の主なフォルダ（入口）で示す */
function dropLegacy(doc: YAML.Document) {
  doc.delete("docs");
}

/** 後から足した項目も決まった順に並べる（コメントは項目に付いているので一緒に動く） */
function sortKeys(doc: YAML.Document) {
  if (!YAML.isMap(doc.contents)) return;
  const rank = (k: unknown) => {
    const i = RANK.indexOf(String(YAML.isScalar(k) ? k.value : k) as keyof ProjectConfig);
    return i < 0 ? RANK.length : i;
  };
  doc.contents.items.sort((x, y) => rank(x.key) - rank(y.key));
}

/** project.yaml の repos の1件の形（既定のままの項目は省く） */
function repoPlain(r: RepoRef): Record<string, unknown> {
  const map = r.map.length
    ? Object.fromEntries(r.map.map((m) => [m.path, m.entry ? { role: m.role, entry: m.entry } : m.role]))
    : undefined;
  return Object.fromEntries(
    Object.entries({ role: r.role || undefined, readFirst: r.readFirst || undefined, writable: r.writable || undefined, map }).filter(
      ([, v]) => v !== undefined,
    ),
  );
}

/**
 * project.yaml の repos の1件だけを書く（null で消す）。ほかの参照先・項目・コメントは変えない。
 * repos が無ければ作る（名前をキーにした対応で書く）
 */
export async function writeRepoEntry(path: string, name: string, entry: RepoRef | null): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  const doc = text.trim() ? YAML.parseDocument(text) : new YAML.Document({});
  if (doc.errors.length) throw new Error(`project.yaml が壊れています: ${path}（${doc.errors[0].message.split("\n")[0]}）`);
  const repos = doc.get("repos");
  if (repos !== undefined && !YAML.isMap(repos)) {
    throw new Error(`project.yaml の repos は「名前: 定義」の対応で書いてください（今の形では p3 repo で書き換えられません）: ${path}`);
  }
  dropLegacy(doc);
  if (entry === null) {
    doc.deleteIn(["repos", name]);
    if (YAML.isMap(doc.get("repos")) && !(doc.get("repos") as YAML.YAMLMap).items.length) doc.delete("repos");
  } else {
    if (!YAML.isMap(doc.get("repos"))) doc.set("repos", doc.createNode({}));
    const node = doc.getIn(["repos", name]);
    const plain = repoPlain(entry);
    if (YAML.isMap(node)) {
      // 既にあれば項目ごとに書く（人が書いたコメントや、ここで扱わない項目を残す）
      node.delete("mapFile"); // 以前の構成の説明。今は主なフォルダの入口で示す
      for (const key of ["role", "readFirst", "writable", "map"]) {
        if (plain[key] === undefined) node.delete(key);
        else node.set(key, doc.createNode(plain[key]));
      }
    } else doc.setIn(["repos", name], doc.createNode(plain));
  }
  sortKeys(doc);
  await writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
}