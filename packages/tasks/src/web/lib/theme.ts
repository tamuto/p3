import { isTheme, type Theme } from "../../shared/types.ts";

/**
 * 画面のテーマ（個人設定の ui.theme）を html 要素に反映する。
 *
 *   - 最初の描画の前に、index.html の先頭の /api/user-theme.js（同期のスクリプト）が個人設定の値を読んで反映する
 *     （ここと同じ規則。server/api/userThemeRoutes.ts の themeScript）。ちらつかないように CSS より先に読む
 *   - その後はこの controller が持つ。system のときだけ OS の明暗の変化に追従し、固定のテーマでは追従しない
 *   - 反映するもの: data-theme（選んだ値）、class "dark"（Tailwind の dark: が見る）、color-scheme（フォームなどブラウザの部品）
 *
 * localStorage には保存しない（保存先は個人設定だけ）。CLI やほかの serve で変えた値は、ページを読み直すと反映する。
 */

export interface ThemeRoot {
  dataset: { theme?: string };
  classList: { toggle(name: string, force?: boolean): unknown };
  style: { colorScheme: string };
}

export interface MediaQuery {
  matches: boolean;
  addEventListener(type: "change", l: (e: { matches: boolean }) => void): void;
  removeEventListener(type: "change", l: (e: { matches: boolean }) => void): void;
}

export const isDark = (theme: Theme, prefersDark: boolean) => theme === "dark" || (theme === "system" && prefersDark);

export function applyTheme(root: ThemeRoot, theme: Theme, prefersDark: boolean) {
  const dark = isDark(theme, prefersDark);
  root.dataset.theme = theme;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

/** 最初のスクリプトが書いた値。読めなければ（スクリプトが失敗した）system */
export const initialTheme = (root: ThemeRoot): Theme => (isTheme(root.dataset.theme) ? root.dataset.theme : "system");

export interface ThemeController {
  // this を使わない（useSyncExternalStore にそのまま渡す）ので、メソッドでなく関数の項目にする
  get: () => Theme;
  /** 反映する（保存は呼ぶ側が先に済ませる） */
  set: (theme: Theme) => void;
  subscribe: (l: () => void) => () => void;
  /** 止める（OS の明暗の購読をやめる） */
  stop: () => void;
}

/** media は (prefers-color-scheme: dark)。無い環境（テスト・古いブラウザ）では明るいとみなす */
export function createThemeController(root: ThemeRoot, media: MediaQuery | undefined): ThemeController {
  let theme = initialTheme(root);
  const listeners = new Set<() => void>();
  const onMedia = (e: { matches: boolean }) => {
    if (theme === "system") applyTheme(root, theme, e.matches);
  };
  let following = false;
  const follow = (on: boolean) => {
    if (!media || on === following) return;
    if (on) media.addEventListener("change", onMedia);
    else media.removeEventListener("change", onMedia);
    following = on;
  };
  const set = (next: Theme) => {
    theme = next;
    applyTheme(root, theme, media?.matches ?? false);
    follow(theme === "system");
    for (const l of listeners) l();
  };
  set(theme);
  return {
    get: () => theme,
    set,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    stop: () => follow(false),
  };
}
