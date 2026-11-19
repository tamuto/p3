import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * AI エージェント向けの作業の手順（`p3 guide`）。原本はこの CLI と一緒に配る guide.md の1つ。
 * 置いたスキルや AGENTS.md の節は入口だけにして、手順の本文は実行中の CLI から読ませる（CLI が新しければ手順も新しい）。
 * プロジェクトを決める前に扱い、データ・個人設定・置いたファイルを読まず変えない。Codex・Docker・npm へも問い合わせない。
 */

/** guide の JSON の形の版（項目を変えたら上げる） */
export const GUIDE_SCHEMA_VERSION = 1;
/**
 * 入口（置いたスキル・節）の決まりの版。起動のしかた・読み込みの約束など、入口に書くことを変えたときだけ上げる。
 * 手順の本文（guide.md）を直しただけでは上げない
 */
export const ENTRY_VERSION = 1;

/** 手順の原本（ソースでは src/cli/guide.md、配布物では lib/cli/guide.md。scripts/build-cli.mjs が写す） */
export const GUIDE_SOURCE = fileURLToPath(new URL("./guide.md", import.meta.url));
/** この CLI のパッケージ（src/cli・lib/cli のどちらからも2つ上） */
const PACKAGE_JSON = new URL("../../package.json", import.meta.url);

/** 実行中のパッケージの版。最新かどうかの判断には使わない */
export function cliVersion(): string {
  const v = (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version?: unknown }).version;
  return typeof v === "string" ? v : "0.0.0";
}

export interface GuideResult {
  schemaVersion: number;
  cliVersion: string;
  entryVersion: number;
  guide: string;
}

/** 毎回原本を読む（写しを持たない） */
export function guide(): GuideResult {
  return { schemaVersion: GUIDE_SCHEMA_VERSION, cliVersion: cliVersion(), entryVersion: ENTRY_VERSION, guide: readFileSync(GUIDE_SOURCE, "utf8") };
}
