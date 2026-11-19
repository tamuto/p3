import { isTheme, THEMES, type Theme } from "../shared/types.ts";
import { loadUserConfig, setThemeNode, updateUserConfig, userConfigPath } from "./userConfig.ts";

/**
 * 画面のテーマ（個人設定の ui.theme）。保存先はここだけで、CLI（p3 user-config）と画面（/api/user-theme）が使う。
 * このマシン・この人の設定なので、すべてのプロジェクトで共通。
 */

/** 新しく書く値が読めない（CLI は終了コード 1、API は 400） */
export class ThemeInputError extends Error {}

/** 今のテーマ。書いていなければ system、ファイルに読めない値があっても system（画面は起動できるように） */
export async function readTheme(path = userConfigPath()): Promise<Theme> {
  return (await loadUserConfig(path)).ui.theme;
}

/** テーマを書く。ほかの項目（projects・ui のほかのキー・マシンの設定・コメント）は変えない */
export async function writeTheme(value: unknown, path = userConfigPath()): Promise<Theme> {
  if (!isTheme(value)) throw new ThemeInputError(`テーマは ${THEMES.join(" / ")} のどれか: ${String(value)}`);
  await updateUserConfig((doc) => setThemeNode(doc, value), path);
  return value;
}
