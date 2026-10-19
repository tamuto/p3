// UI テストの前に1回: 画面のビルドがあるか（無ければ失敗）、Chromium を起動できるか（無ければ飛ばす）を決めてテストに渡す
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { INSTALL_HINT, probeChromium, type ChromiumProbe } from "./chromium.ts";

declare module "vitest" {
  export interface ProvidedContext {
    chromium: ChromiumProbe;
    /** ブラウザに渡す fontconfig（日本語を Noto Sans CJK JP で描く）。フォントが無ければ null（このマシンの既定のフォントで描く） */
    fontconfig: string | null;
  }
}

export const FONTCONFIG = fileURLToPath(new URL("../../scripts/fonts-ja.conf", import.meta.url));

/** Noto Sans CJK JP があれば、使い方の動画と同じ fontconfig を使う（寸法を日本語のフォントで測る） */
export function jaFontconfig(list = () => execFileSync("fc-list", ["Noto Sans CJK JP", "family"], { encoding: "utf8" })): string | null {
  try {
    return list().trim() ? FONTCONFIG : null;
  } catch {
    return null;
  }
}

export const BUILT_INDEX = fileURLToPath(new URL("../../dist/web/index.html", import.meta.url));

/** ビルドは Chromium の有無によらず要る（pnpm check はビルドの後に UI テストを流す） */
export function checkBuilt(index = BUILT_INDEX) {
  if (!existsSync(index)) throw new Error(`画面のビルドがありません（${index}）。先に pnpm build を実行してください`);
}

export default async function setup(project: TestProject) {
  checkBuilt();
  const probe = await probeChromium();
  if (!probe.available) {
    console.warn(`\n⚠ UI テストを飛ばします: ${probe.reason}\n  入れるには: ${INSTALL_HINT}\n`);
  }
  project.provide("chromium", probe);
  const fontconfig = jaFontconfig();
  if (probe.available && !fontconfig) {
    console.warn("\n⚠ 日本語のフォント Noto Sans CJK JP が無いので、このマシンの既定のフォントで描いて測ります（例: sudo apt-get install fonts-noto-cjk）\n");
  }
  project.provide("fontconfig", fontconfig);
}
