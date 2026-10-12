import { THEMES } from "../shared/types.ts";
import { describeSettings, parseSettingChange, SETTING_KEY_LIST, SettingsInputError, writeMachineSettings, type SettingChange } from "../server/machineSettingsEdit.ts";
import { loadUserConfig, UserConfigError, userConfigPath } from "../server/userConfig.ts";
import { readTheme, ThemeInputError, writeTheme } from "../server/userTheme.ts";
import { UsageError } from "./project.ts";

const USAGE = [
  "p3 user-config                                   個人設定の値と出どころ（環境変数 / 個人設定 / 既定）",
  `p3 user-config set キー=値 ...                    ui.theme=${THEMES.join("|")} / ${SETTING_KEY_LIST.filter((k) => k !== "codex.pathMap").join(" ")}（キー= で消す）`,
  "p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker デーモンから見たパス>   パスの対応を足す",
  "p3 user-config set codex.pathMap-=<このマシンのパス>                                パスの対応を外す（codex.pathMap= で全部）",
].join("\n");

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
