import { THEMES } from "../shared/types.ts";
import { userConfigPath } from "../server/userConfig.ts";
import { readTheme, ThemeInputError, writeTheme } from "../server/userTheme.ts";
import { UsageError } from "./project.ts";

/**
 * p3 user-config [set ui.theme=<system|light|dark>]。個人設定のうち、このコマンドで扱う項目（今は画面のテーマ）だけを見せ・変える。
 * プロジェクトを決める前に動く（このマシン・この人の設定）。プロジェクトの設定は p3 config。
 */
export async function userConfigCommand(args: string[]): Promise<{ data: unknown; text: string }> {
  const [sub, ...pairs] = args;
  const path = userConfigPath();
  if (sub === undefined || sub === "ls" || sub === "show") {
    const theme = await readTheme(path);
    return { data: { ui: { theme }, path }, text: `ui.theme  ${theme}\n（${path}）` };
  }
  if (sub !== "set" || !pairs.length) throw new UsageError(`p3 user-config [set ui.theme=${THEMES.join("|")}]`);
  let theme: string | undefined;
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq) : pair;
    if (key !== "ui.theme") throw new UsageError(`変更できるキー: ui.theme（${THEMES.join(" / ")}）`);
    theme = pair.slice(eq + 1);
  }
  try {
    const saved = await writeTheme(theme, path);
    return { data: { ui: { theme: saved }, path }, text: `ui.theme を ${saved} にしました（${path}）` };
  } catch (e) {
    if (e instanceof ThemeInputError) throw new UsageError(e.message);
    throw e;
  }
}
