import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, vi } from "vitest";
import { gitInit, tempDir } from "./helpers.ts";
import { parseFrontmatter, stringifyFrontmatter } from "../packages/tasks/src/core/store/frontmatter.ts";

/**
 * CLI を別のプロセスで動かすテスト（test/cli*.test.ts）の共通の準備。
 * 読み込んだテストファイルごとに、個人設定（~/.config/infodb-p3）の場所をテストごとに分ける（下の beforeEach）。
 * ファイルの中のケースは順に動く。ファイルの間は Vitest が並べて動かすので、ケースどうしで場所や状態を共有しない。
 */

// 1件で CLI を数十回起こすケースがあり、ほかのテストファイルと並べて動かすと CPU を取り合って1件が 20 秒（vitest.config.ts の既定）を
// 超えうる。CLI のテストファイルだけ待つ時間を延ばす（確かめる中身は変えない）
vi.setConfig({ testTimeout: 60_000 });

export const BIN = fileURLToPath(new URL("../packages/p3/bin/p3.mjs", import.meta.url));

/** 今のテストの個人設定の場所（XDG_CONFIG_HOME）。テストごとに新しい一時フォルダ */
export let CONFIG_HOME = "";
beforeEach(() => {
  newConfigHome();
});

/** テストの途中で個人設定を空の別の場所に替える（別の人・別のマシンの想定）。以後の p3() の既定もそこを使う */
export function newConfigHome() {
  CONFIG_HOME = tempDir("p3-config-");
  return CONFIG_HOME;
}

/** CLI を別プロセスで動かす。このマシンの P3_* の環境変数（Codex の設定など）は効かないようにする */
export function p3(cwd: string, args: string[], env: Record<string, string> = {}, configHome = CONFIG_HOME, input?: string) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...base, XDG_CONFIG_HOME: configHome, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

/** git のリポジトリ（docs/index.md・README.md・AGENTS.md 入り） */
export async function repo() {
  const root = tempDir("p3-cli-");
  gitInit(root);
  await mkdir(join(root, "docs"));
  writeFileSync(join(root, "docs", "index.md"), "# docs\n");
  writeFileSync(join(root, "README.md"), "# app\n");
  writeFileSync(join(root, "AGENTS.md"), "# rules\n");
  return root;
}

/** 初期化して要望を1つ作る */
export async function initialized() {
  const root = await repo();
  const r = p3(root, ["init", "--yes", "--description", "在庫管理", "--dir", ".p3", "--repo-name", "app"]);
  expect(r.code, r.err).toBe(0);
  const req = p3(root, ["request", "new", "通知機能", "--body", "- 送信基盤\n- 設定画面\n- 再送", "--json"]).json();
  return { root, rid: req.id as string };
}

/** タスクの関係をファイルに書く（関係は Preflight のタスク化だけが張るので、CLI には張る操作が無い） */
export function relate(root: string, rid: string, tid: string, relations: { type: string; target: string; note?: string; origin?: string }[]) {
  const file = join(root, ".p3", "requests", rid, "tasks", `${tid}.md`);
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  writeFileSync(file, stringifyFrontmatter({ ...data, relations: [...((data.relations as unknown[]) ?? []), ...relations.map((r) => ({ origin: "preflight", ...r }))] }, body));
}

/** 個人設定の場所を変えて、この中で init / join を直接呼ぶ（対話の問いを渡すため）。出力は捨てる */
export async function withConfigHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

export const relativeFrom = (from: string, to: string) => relative(from, to);

/** フォルダの中身（相対パス → 内容）。変わっていないことを比べる */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) files[join(f.parentPath, f.name).slice(dir.length)] = readFileSync(join(f.parentPath, f.name), "base64");
  }
  return files;
}
