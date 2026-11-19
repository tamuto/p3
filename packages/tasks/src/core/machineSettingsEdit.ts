import YAML from "yaml";
import { DEFAULT_SETTINGS, resolveMachineSettings, SETTING_KEYS, SettingsError, type MachineSettings } from "./machineSettings.ts";
import { normalizeUserConfig, updateUserConfig, userConfigPath, type UserConfig } from "./userConfig.ts";

/**
 * 個人設定のマシンごとの設定（codex / preflight / serve）を変える（p3 user-config set）。
 *
 *   キー=値                 その項目を書く（ensureImage は true / false、port は数で書く）
 *   キー=                   その項目を消す（既定値に戻す）
 *   codex.pathMap+=A=B      パスの対応を1件足す（同じ A があれば置き換える）
 *   codex.pathMap-=A        パスの対応を1件外す
 *   codex.pathMap=          パスの対応を全部外す
 *
 * 書いた後の内容を読むときと同じ規則（resolveMachineSettings）で確かめ、読めなければ書かない。
 * コメントとほかの項目は残す。
 */
export class SettingsInputError extends Error {}

export type SettingKey = keyof typeof SETTING_KEYS;
export const SETTING_KEY_LIST = Object.keys(SETTING_KEYS) as SettingKey[];

export type SettingChange =
  | { kind: "set"; key: SettingKey; value: string }
  | { kind: "unset"; key: SettingKey }
  | { kind: "mapAdd"; local: string; host: string }
  | { kind: "mapRemove"; local: string };

const isKey = (k: string): k is SettingKey => (SETTING_KEY_LIST as string[]).includes(k);

/** 「キー=値」「codex.pathMap+=A=B」「codex.pathMap-=A」を読む */
export function parseSettingChange(pair: string): SettingChange {
  const add = pair.match(/^codex\.pathMap\+=(.*)$/s);
  if (add) {
    const at = add[1].indexOf("=");
    if (at < 1) throw new SettingsInputError(`「${pair}」が読めません。codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス>（例: codex.pathMap+=/workspaces=/home/me/workspaces）`);
    return { kind: "mapAdd", local: add[1].slice(0, at).trim(), host: add[1].slice(at + 1).trim() };
  }
  const remove = pair.match(/^codex\.pathMap-=(.*)$/s);
  if (remove) {
    if (!remove[1].trim()) throw new SettingsInputError("codex.pathMap-=<このマシンのパス> で外す対応を指定してください");
    return { kind: "mapRemove", local: remove[1].trim() };
  }
  const eq = pair.indexOf("=");
  const key = eq > 0 ? pair.slice(0, eq) : pair;
  if (!isKey(key)) throw new SettingsInputError(`変更できるキー: ui.theme ${SETTING_KEY_LIST.join(" ")}`);
  if (eq < 0) throw new SettingsInputError(`${key}=<値> で指定してください（${key}= で消す）`);
  const value = pair.slice(eq + 1).trim();
  if (key === "codex.pathMap" && value) {
    throw new SettingsInputError("パスの対応は1件ずつ codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス> で足し、codex.pathMap-=<このマシンのパス> で外してください（codex.pathMap= で全部外す）");
  }
  return value ? { kind: "set", key, value } : { kind: "unset", key };
}

/** YAML に書く形（読むときと同じ型にそろえる） */
function typed(key: SettingKey, value: string): unknown {
  if (key === "codex.ensureImage") {
    const v = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(v)) return true;
    if (["false", "0", "no", "off"].includes(v)) return false;
    throw new SettingsInputError(`codex.ensureImage は true か false: ${value}`);
  }
  if (key === "serve.port") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new SettingsInputError(`serve.port は 1〜65535 のポート番号: ${value}`);
    return n;
  }
  return value;
}

function ensureMap(doc: YAML.Document, path: string[]) {
  for (let i = 1; i <= path.length; i++) {
    const at = path.slice(0, i);
    if (!YAML.isMap(doc.getIn(at))) doc.setIn(at, doc.createNode({}));
  }
}

/** 空になった項目（codex: {} など）を消す */
function dropEmpty(doc: YAML.Document, path: string[]) {
  for (let i = path.length; i >= 1; i--) {
    const node = doc.getIn(path.slice(0, i));
    if (YAML.isMap(node) && !node.items.length) doc.deleteIn(path.slice(0, i));
  }
}

export function applySettingChange(doc: YAML.Document, c: SettingChange) {
  if (c.kind === "mapAdd") {
    ensureMap(doc, ["codex", "pathMap"]);
    doc.setIn(["codex", "pathMap", c.local], c.host);
  } else if (c.kind === "mapRemove") {
    if (!doc.hasIn(["codex", "pathMap", c.local])) throw new SettingsInputError(`codex.pathMap に「${c.local}」の対応はありません`);
    doc.deleteIn(["codex", "pathMap", c.local]);
    dropEmpty(doc, ["codex", "pathMap"]);
  } else {
    const path = c.key.split(".");
    if (c.kind === "unset") {
      doc.deleteIn(path);
      dropEmpty(doc, path.slice(0, -1));
    } else {
      ensureMap(doc, path.slice(0, -1));
      doc.setIn(path, typed(c.key, c.value));
    }
  }
}

/** 変更をまとめて書く。どれか1つでも読めなければ何も書かない。書いた後の個人設定の値を返す */
export async function writeMachineSettings(changes: SettingChange[], path = userConfigPath()): Promise<MachineSettings> {
  return updateUserConfig((doc) => {
    for (const c of changes) applySettingChange(doc, c);
    try {
      // 環境変数は見ずに、個人設定に書いた値だけで確かめる
      return resolveMachineSettings(normalizeUserConfig(doc.toJS() ?? {}), {});
    } catch (e) {
      if (e instanceof SettingsError) throw new SettingsInputError(`${e.message}（書いていません）`);
      throw e;
    }
  }, path);
}

export interface SettingRow {
  key: SettingKey;
  /** 効いている値（表示用の文字列） */
  value: string;
  /** どこから来たか */
  from: "環境変数" | "個人設定" | "既定";
  env: string;
}

const show = (v: unknown): string => (v === undefined ? "（なし）" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 項目ごとの効いている値と出どころ。読めない値があれば error に理由（行は書かれたままの値で出す） */
export function describeSettings(user: Pick<UserConfig, "settings">, env: Record<string, string | undefined>): { rows: SettingRow[]; resolved?: MachineSettings; error?: string } {
  let resolved: MachineSettings | undefined;
  let error: string | undefined;
  try {
    resolved = resolveMachineSettings(user, env);
  } catch (e) {
    error = (e as Error).message;
  }
  const rows = SETTING_KEY_LIST.map((key): SettingRow => {
    const name = SETTING_KEYS[key];
    const [section, field] = key.split(".") as [keyof UserConfig["settings"], string];
    const written = user.settings[section]?.[field];
    // 空の環境変数は個人設定を使わずに既定値に戻す（resolveMachineSettings と同じ）
    const from: SettingRow["from"] =
      env[name] !== undefined ? (env[name] === "" ? "既定" : "環境変数") : written !== undefined && written !== null && written !== "" ? "個人設定" : "既定";
    const effective = resolved ? (resolved as unknown as Record<string, Record<string, unknown>>)[section][field] : from === "環境変数" ? env[name] : written;
    const def = (DEFAULT_SETTINGS as unknown as Record<string, Record<string, unknown>>)[section][field];
    let value: string;
    if (key === "codex.pathMap") {
      const pairs = (Array.isArray(effective) ? effective : []) as [string, string][];
      value = pairs.length ? pairs.map(([l, h]) => `${l} → ${h}`).join(", ") : resolved ? "（なし）" : show(effective);
    } else value = show(effective ?? def);
    return { key, value, from, env: name };
  });
  return { rows, resolved, error };
}
