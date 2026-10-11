import { useEffect, useMemo, useState } from "react";
import { THEMES, type Theme } from "../../shared/types.ts";
import { api } from "../lib/api.ts";
import { createThemeSaver, type ThemeSaveState } from "../lib/themeSave.ts";
import { themeController } from "../lib/useTheme.ts";
import { Button, cx, Section } from "./ui.tsx";

const LABELS: Record<Theme, string> = { system: "OS に合わせる（既定）", light: "ライト", dark: "ダーク" };

/**
 * 画面のテーマ（個人設定の ui.theme）。このマシンのすべてのプロジェクトで共通で、プロジェクトの設定とは別に、選んだらすぐ保存する。
 * ほかの画面や CLI で変わったら（変更通知の tick）、保存中でなければ取り込む。
 */
export function ThemePanel({ tick }: { tick: number }) {
  const [s, setS] = useState<ThemeSaveState>();
  const saver = useMemo(
    () =>
      createThemeSaver({
        initial: themeController().get(),
        save: async (t) => (await api.saveUserTheme(t)).theme,
        apply: (t) => themeController().set(t),
        onChange: setS,
      }),
    [],
  );
  const state = s ?? saver.state();

  useEffect(() => {
    api.userTheme().then(
      (r) => saver.sync(r.theme),
      () => {}, // 読めなくても、今の表示のまま選べる（保存の失敗は選んだときに知らせる）
    );
  }, [tick, saver]);

  return (
    <Section title="画面のテーマ（個人）">
      <div className="space-y-3 rounded-lg bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <fieldset>
          <legend className="sr-only">画面のテーマ</legend>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((t) => (
              <label
                key={t}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 ring-1",
                  state.selected === t
                    ? "bg-indigo-50 ring-indigo-400 dark:bg-indigo-950 dark:ring-indigo-500"
                    : "ring-slate-200 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800",
                )}
              >
                <input type="radio" name="ui-theme" value={t} checked={state.selected === t} onChange={() => void saver.select(t)} />
                {LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          このマシンの個人設定（<code className="font-mono">ui.theme</code>）に保存し、すべてのプロジェクトの画面で使います。
          CLI では <code className="font-mono">p3 user-config set ui.theme=dark</code>。
        </p>
        <div aria-live="polite" className="text-sm empty:hidden">
          {state.saving && <span className="text-slate-500">保存しています…</span>}
          {state.error && (
            <span className="flex flex-wrap items-center gap-2 text-rose-600 dark:text-rose-400">
              テーマを保存できませんでした: {state.error}
              {state.failed && (
                <Button variant="ghost" onClick={() => void saver.retry()}>
                  もう一度保存する
                </Button>
              )}
            </span>
          )}
        </div>
      </div>
    </Section>
  );
}
