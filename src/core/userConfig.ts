import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { isTheme, type Theme } from "../shared/types.ts";
import { withFileLock, writeFileAtomic } from "./store/fsutil.ts";

/**
 * 個人設定（このマシン・この人だけのもの。共有しない）。
 *
 *   ~/.config/infodb-p3/config.yaml
 *
 *   projects:
 *     myapp:                       # プロジェクト名 → データを置くフォルダ（場所は自由）
 *       dir: /home/me/p3-data/myapp
 *       repos:                     # 手元のリポジトリの場所（マシンごとに違うのでプロジェクトのデータには書かない）
 *         main: /home/me/src/myapp
 *     other:
 *       dir: /home/me/p3-data/other
 *   ui:
 *     theme: system                # 画面の表示（system / light / dark）
 *   codex: { ... }                 # マシンごとの設定（Codex・Preflight・serve。→ machineSettings.ts）
 *   preflight: { ... }
 *   serve: { ... }
 *
 * 操作するプロジェクトは、ここに登録した内容と「今いる場所」から決める（環境変数では切り替えない）。
 * ChatGPT の接続（トークン）はここに置かない（同じフォルダの chatgpt.json）。
 */
export interface UserProject {
  /** データを置くフォルダ（project.yaml と requests/ がある場所） */
  dir: string;
  /** 手元のリポジトリの場所（リポジトリの名前 → 絶対パス）。今は main の1つ */
  repos: Record<string, string>;
}

export type { Theme };

export interface UserConfig {
  projects: Record<string, UserProject>;
  ui: { theme: Theme };
  /** マシンごとの設定。書かれたままの値（読むときに machineSettings.ts で確かめる）。保存では書き換えない */
  settings: Partial<Record<SettingsSection, Record<string, unknown>>>;
}

export const SETTINGS_SECTIONS = ["codex", "preflight", "serve"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 個人設定のファイル。XDG_CONFIG_HOME があればそれに従う（設定ファイルの置き場所を決めるだけで、プロジェクトの切り替えには使わない） */
export function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "infodb-p3", "config.yaml");
}

/** Preflight の記録（共有）に残す文から、個人設定のファイルのパス（このマシンのもの）を外す */
export function hideConfigPath(e: unknown): string {
  const text = (e as Error)?.message ?? String(e);
  const path = (e as { configPath?: string })?.configPath ?? userConfigPath();
  return text.split(path).join("個人設定（config.yaml）");
}

/** 個人設定を読めない・壊れている。ファイルは変えていない */
export class UserConfigError extends Error {}

/** ファイルが無ければ空。権限や I/O の失敗は、無いのと区別してエラーにする */
async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw new UserConfigError(`個人設定を読めません: ${path}（${code ?? (e as Error).message}）。ファイルの権限と種類を確かめてください`);
  }
}

function parse(text: string, path: string): YAML.Document {
  const doc = text.trim() ? YAML.parseDocument(text) : new YAML.Document({});
  if (doc.errors.length) {
    const e = doc.errors[0];
    const at = e.linePos?.[0] ? `${e.linePos[0].line} 行目: ` : "";
    throw new UserConfigError(`個人設定の YAML が壊れています: ${path}（${at}${e.message.split("\n")[0]}）。直してからやり直してください（ファイルは変えていません）`);
  }
  if (!text.trim()) doc.commentBefore = " infodb p3 の個人設定（このマシン・この人だけ。共有しない）";
  return doc;
}

export async function loadUserConfig(path = userConfigPath()): Promise<UserConfig> {
  return normalizeUserConfig(asRecord(parse(await readText(path), path).toJS()));
}

/**
 * マシンごとの設定（codex / preflight / serve）のために、個人設定を厳密に読む（Preflight を始めるたび・エンジンの状態を見るたび）。
 * ファイルが無ければ空（既定値）。読めない・壊れた YAML・ファイル全体や項目の形が違うときは、空にせずエラーにする。
 */
export async function loadUserSettings(path = userConfigPath()): Promise<Pick<UserConfig, "settings">> {
  const js = parse(await readText(path), path).toJS() as unknown;
  if (js !== null && js !== undefined && (typeof js !== "object" || Array.isArray(js))) {
    throw new UserConfigError(`個人設定の形が違います: ${path}（「項目: 値」の対応で書いてください）`);
  }
  const d = (js ?? {}) as Record<string, unknown>;
  const settings: UserConfig["settings"] = {};
  for (const s of SETTINGS_SECTIONS) {
    const v = d[s];
    if (v === undefined || v === null) continue;
    if (typeof v !== "object" || Array.isArray(v)) throw new UserConfigError(`個人設定の ${s} の形が違います: ${path}（「項目: 値」の対応で書いてください）`);
    settings[s] = v as Record<string, unknown>;
  }
  return { settings };
}

/** 一覧に入れられなかった登録（名前の形・dir が無いなど）。normalizeUserConfig は黙って外すので、プロジェクトを跨ぐ serve の一覧で知らせる */
export interface InvalidProjectEntry {
  name: string;
  reason: string;
}

/**
 * プロジェクトを跨ぐ serve のために、個人設定の projects を診断つきで読む。読めない・壊れた YAML は UserConfigError
 * （登録0件とは区別する）。projects の形が違う・名前や dir が不正な登録は invalid に理由を付けて返し、ほかの登録は使えるようにする
 */
export async function inspectUserProjects(path = userConfigPath()): Promise<{ projects: Record<string, UserProject>; invalid: InvalidProjectEntry[] }> {
  const d = asRecord(parse(await readText(path), path).toJS());
  const invalid: InvalidProjectEntry[] = [];
  if (d.projects !== undefined && d.projects !== null && (typeof d.projects !== "object" || Array.isArray(d.projects))) {
    throw new UserConfigError(`個人設定の projects の形が違います: ${path}（「名前: { dir: フォルダ }」の対応で書いてください）`);
  }
  for (const [name, v] of Object.entries(asRecord(d.projects))) {
    const p = typeof v === "string" ? { dir: v } : v;
    if (!PROJECT_NAME.test(name)) invalid.push({ name, reason: "名前に使えない文字があります（英数字で始まり、英数字と . _ -）" });
    else if (!p || typeof p !== "object" || Array.isArray(p)) invalid.push({ name, reason: "登録の形が違います（dir: <データのフォルダ>）" });
    else if (typeof (p as Record<string, unknown>).dir !== "string" || !(p as Record<string, unknown>).dir) invalid.push({ name, reason: "dir（データのフォルダ）がありません" });
  }
  return { projects: normalizeUserConfig(d).projects, invalid };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * 個人設定を書き換える。ロックの中で最新のファイルを読み、change で対象の項目だけを変えて、まとめて書く。
 * 別のプロセス（CLI・serve）が同時に別の項目を変えても、互いに消し合わない。コメントと、ここで扱わない項目は残す。
 * 壊れた YAML や読めないファイルは、書かずにエラーにする。change は今の内容（cfg）を見て、変えてよいか確かめてもよい。
 */
export async function updateUserConfig<T>(change: (doc: YAML.Document, cfg: UserConfig) => T | Promise<T>, path = userConfigPath()): Promise<T> {
  return withFileLock(
    `${path}.lock`,
    async () => {
      const doc = parse(await readText(path), path);
      const result = await change(doc, normalizeUserConfig(asRecord(doc.toJS())));
      await writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
      return result;
    },
    { busyMessage: `個人設定の更新を待ちきれませんでした（別のプロセスが更新中です。${path}.lock が残っていれば消してください）` },
  );
}

/** プロジェクト1つの登録を書く（null で外す）。ほかのプロジェクトと項目は変えない */
export function setProjectNode(doc: YAML.Document, name: string, p: UserProject | null) {
  if (p === null) {
    doc.deleteIn(["projects", name]);
    return;
  }
  if (!doc.has("projects") || !YAML.isMap(doc.get("projects"))) doc.set("projects", doc.createNode({}));
  doc.setIn(["projects", name], doc.createNode(Object.keys(p.repos).length ? { dir: p.dir, repos: p.repos } : { dir: p.dir }));
}

/** 画面のテーマを書く。ui のほかの項目は残す */
export function setThemeNode(doc: YAML.Document, theme: Theme) {
  if (!doc.has("ui") || !YAML.isMap(doc.get("ui"))) doc.set("ui", doc.createNode({}));
  doc.setIn(["ui", "theme"], theme);
}

export function normalizeUserConfig(d: Record<string, unknown>): UserConfig {
  const projects: Record<string, UserProject> = {};
  const raw = d.projects && typeof d.projects === "object" ? (d.projects as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(raw)) {
    const p = (typeof v === "string" ? { dir: v } : (v ?? {})) as Record<string, unknown>;
    if (!PROJECT_NAME.test(name) || typeof p.dir !== "string" || !p.dir) continue;
    const repos = p.repos && typeof p.repos === "object" ? (p.repos as Record<string, unknown>) : {};
    projects[name] = {
      dir: resolve(p.dir),
      repos: Object.fromEntries(Object.entries(repos).filter(([, r]) => typeof r === "string" && r).map(([k, r]) => [k, resolve(r as string)])),
    };
  }
  // 書かれたテーマが読めないときは system として扱う（画面は起動できるように。新しく書くときは CLI・API が確かめる）
  const ui = asRecord(d.ui);
  const theme: Theme = isTheme(ui.theme) ? ui.theme : "system";
  const settings: UserConfig["settings"] = {};
  for (const s of SETTINGS_SECTIONS) {
    const v = d[s];
    if (v && typeof v === "object" && !Array.isArray(v)) settings[s] = v as Record<string, unknown>;
  }
  return { projects, ui: { theme }, settings };
}

/**
 * 個人設定の projects と ui.theme を、渡した内容に置き換える（テストや一括の書き換え用）。
 * いつもの操作は updateUserConfig で対象の項目だけを変える（同時に別の項目を変えても消し合わないように）
 */
export async function saveUserConfig(cfg: UserConfig, path = userConfigPath()): Promise<void> {
  await updateUserConfig((doc, now) => {
    for (const name of Object.keys(now.projects)) if (!cfg.projects[name]) setProjectNode(doc, name, null);
    for (const [name, p] of Object.entries(cfg.projects)) setProjectNode(doc, name, p);
    if (cfg.ui.theme !== "system" || doc.has("ui")) setThemeNode(doc, cfg.ui.theme);
  }, path);
}
