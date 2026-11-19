import { useSyncExternalStore } from "react";
import { createThemeController, type ThemeController } from "./theme.ts";

/** このページのテーマ（1つだけ。main.tsx が描画の前に作る） */
let controller: ThemeController | undefined;

export function themeController(): ThemeController {
  controller ??= createThemeController(document.documentElement, window.matchMedia?.("(prefers-color-scheme: dark)"));
  return controller;
}

/** 今のテーマ（system / light / dark）。設定画面などで使う */
export function useTheme() {
  const c = themeController();
  return useSyncExternalStore(c.subscribe, c.get);
}
