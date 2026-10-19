// UI テストの前に1回: 画面のビルドがあるか（無ければ失敗）、Chromium を起動できるか（無ければ飛ばす）を決めてテストに渡す
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { INSTALL_HINT, probeChromium, type ChromiumProbe } from "./chromium.ts";

declare module "vitest" {
  export interface ProvidedContext {
    chromium: ChromiumProbe;
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
}
