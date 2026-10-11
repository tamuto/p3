import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { writeFileAtomic } from "./store/fsutil.ts";

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

export type Theme = "system" | "light" | "dark";

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

export async function loadUserConfig(path = userConfigPath()): Promise<UserConfig> {
  const text = await readFile(path, "utf8").catch(() => "");
  return normalizeUserConfig(text.trim() ? (YAML.parse(text) ?? {}) : {});
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
  const ui = (d.ui ?? {}) as Record<string, unknown>;
  const theme: Theme = ui.theme === "light" || ui.theme === "dark" ? ui.theme : "system";
  const settings: UserConfig["settings"] = {};
  for (const s of SETTINGS_SECTIONS) {
    const v = d[s];
    if (v && typeof v === "object" && !Array.isArray(v)) settings[s] = v as Record<string, unknown>;
  }
  return { projects, ui: { theme }, settings };
}

/** 個人設定を書く。人が書いたコメントと、ここで扱わない項目（codex・preflight・serve など）は残す */
export async function saveUserConfig(cfg: UserConfig, path = userConfigPath()): Promise<void> {
  const text = await readFile(path, "utf8").catch(() => "");
  const doc = text.trim() ? YAML.parseDocument(text) : new YAML.Document({});
  if (!text.trim()) doc.commentBefore = " infodb p3 の個人設定（このマシン・この人だけ。共有しない）";
  const projects = Object.fromEntries(
    Object.entries(cfg.projects).map(([name, p]) => [name, Object.keys(p.repos).length ? { dir: p.dir, repos: p.repos } : { dir: p.dir }]),
  );
  doc.set("projects", doc.createNode(projects));
  if (cfg.ui.theme !== "system" || doc.has("ui")) doc.set("ui", doc.createNode(cfg.ui));
  await writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
}
