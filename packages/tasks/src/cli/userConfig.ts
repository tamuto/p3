import { resolve } from "node:path";
import { THEMES } from "../shared/types.ts";
import { resolveMachineSettings } from "../core/machineSettings.ts";
import { originText, resolveHostPaths, type HostPathResolution } from "../core/preflight/hostPaths.ts";
import { describeSettings, parseSettingChange, SETTING_KEY_LIST, SettingsInputError, writeMachineSettings, type SettingChange } from "../core/machineSettingsEdit.ts";
import { loadUserConfig, UserConfigError, userConfigPath } from "../core/userConfig.ts";
import { readTheme, ThemeInputError, writeTheme } from "../core/userTheme.ts";
import { UsageError } from "@infodb/p3-kit/usage.ts";

const USAGE = [
  "p3 user-config                                   個人設定の値と出どころ（環境変数 / 個人設定 / 既定）",
  `p3 user-config set キー=値 ...                    ui.theme=${THEMES.join("|")} / ${SETTING_KEY_LIST.filter((k) => k !== "codex.pathMap").join(" ")}（キー= で消す）`,
  "p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス>   パスの対応を足す",
  "p3 user-config set codex.pathMap-=<このマシンのパス>                                パスの対応を外す（codex.pathMap= で全部）",
  "p3 user-config paths <このマシンのパス> ...       Docker にマウントするときのホストのパスと決め方（変えない）",
].join("\n");

/** 動いている場所の説明（このマシンの CLI の出力だけ。共有の記録には残さない） */
function environmentText(r: HostPathResolution): string {
  const e = r.environment;
  if (e.kind === "direct") return "コンテナの外（パスはそのまま渡します。手で書いた対応があればそれを使います）";
  if (e.kind === "container") return `コンテナの中（自分のコンテナ ${e.containerId.slice(0, 12)} を Docker で確かめました。マウントから決めます）`;
  return `コンテナの中（自分のコンテナを確かめられません: ${e.detail}）`;
}

/**
 * p3 user-config paths: Preflight・描画と同じ設定と決め方で、このマシンのパスが Docker のホストのどこに当たるかを見せる。
 * 読むだけで、個人設定とデータは変えない。実際のパスはこの出力だけに出す
 */
async function pathsCommand(paths: string[], env: Record<string, string | undefined>, path: string): Promise<{ data: unknown; text: string }> {
  if (!paths.length) throw new UsageError("p3 user-config paths <このマシンのパス> ...（例: p3 user-config paths . ~/p3-data/myapp）");
  const user = await loadUserConfig(path).catch((e) => {
    if (e instanceof UserConfigError) throw new UsageError(e.message);
    throw e;
  });
  let pathMap: [string, string][];
  try {
    pathMap = resolveMachineSettings(user, env).codex.pathMap;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const locals = paths.map((p) => resolve(p));
  const r = await resolveHostPaths(locals, { pathMap });
  const lines = [`p3 が動いている場所: ${environmentText(r)}`, ""];
  for (const p of r.paths) {
    lines.push(p.local);
    if (p.ok) lines.push(`  → ${p.host}  ${originText(p, pathMap.length)}${p.origin === "auto" && p.destination ? `（マウント ${p.destination}）` : ""}`);
    else lines.push(`  × 決められません: ${p.detail}`, `    次にすること: ${p.next}`);
  }
  lines.push("", r.ok ? "全部決まりました（Preflight と描画でこのとおりにマウントします）" : "決まらないものがあります。Preflight と描画は、このフォルダを使うときコンテナを起こさずに止まります");
  return { data: r, text: lines.join("\n") };
}

/**
 * p3 user-config [set ...]。個人設定（このマシン・この人）のうち、画面のテーマとマシンごとの設定（codex / preflight / serve）を
 * 見せ・変える。プロジェクトの登録は p3 project、プロジェクトの設定は p3 config。プロジェクトを決める前に動く。
 */
export async function userConfigCommand(args: string[], env: Record<string, string | undefined> = process.env): Promise<{ data: unknown; text: string }> {
  const [sub, ...pairs] = args;
  const path = userConfigPath();
  if (sub === undefined || sub === "ls" || sub === "show") {
    const theme = await readTheme(path);
    const user = await loadUserConfig(path).catch((e) => {
      if (e instanceof UserConfigError) throw new UsageError(e.message);
      throw e;
    });
    const { rows, error } = describeSettings(user, env);
    const width = Math.max(...rows.map((r) => r.key.length), "ui.theme".length) + 2;
    const text = [
      `${"ui.theme".padEnd(width)}${theme}`,
      ...rows.map((r) => `${r.key.padEnd(width)}${r.value}${r.from === "既定" ? "  （既定）" : r.from === "環境変数" ? `  （環境変数 ${r.env}）` : ""}`),
      ...(error ? ["", `読めない値があります: ${error}`] : []),
      "",
      `ファイル: ${path}`,
      "変えるとき: p3 user-config set キー=値（例: p3 user-config set codex.pathMap+=/workspaces=/home/me/workspaces）",
    ].join("\n");
    return { data: { ui: { theme }, settings: rows, ...(error ? { error } : {}), path }, text };
  }
  if (sub === "paths") return pathsCommand(pairs, env, path);
  if (sub !== "set" || !pairs.length) throw new UsageError(USAGE);

  let theme: string | undefined;
  const changes: SettingChange[] = [];
  try {
    for (const pair of pairs) {
      if (pair === "ui.theme" || pair.startsWith("ui.theme=")) theme = pair.slice("ui.theme=".length);
      else changes.push(parseSettingChange(pair));
    }
    // 読めない値があれば何も書かない（テーマも書く前に確かめる）
    if (theme !== undefined && !(THEMES as readonly string[]).includes(theme)) throw new ThemeInputError(`ui.theme は ${THEMES.join(" / ")} のどれか: ${theme}`);
    if (changes.length) await writeMachineSettings(changes, path);
    if (theme !== undefined) await writeTheme(theme, path);
  } catch (e) {
    if (e instanceof SettingsInputError || e instanceof ThemeInputError || e instanceof UserConfigError) throw new UsageError(e.message);
    throw e;
  }
  const keys = pairs.map((p) => p.replace(/^(codex\.pathMap[+-]?)=.*$/s, "$1").replace(/=.*$/s, ""));
  return { data: { changed: keys, path }, text: `個人設定を変えました: ${keys.join(", ")}（${path}）\n効いている値は p3 user-config で確かめられます` };
}
