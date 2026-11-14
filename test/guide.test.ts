import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitInit, tempDir } from "./helpers.ts";
import { ENTRY_VERSION, GUIDE_SCHEMA_VERSION, GUIDE_SOURCE } from "../src/cli/guide.ts";

const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const source = readFileSync(GUIDE_SOURCE, "utf8");

/** CLI を別プロセスで動かす。このマシンの P3_* と個人設定は使わない */
function p3(cwd: string, args: string[], env: Record<string, string> = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...base, XDG_CONFIG_HOME: tempDir("p3-guide-config-"), ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** フォルダの中のファイルと中身・更新日時（変わっていないことを確かめる） */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === ".git") continue;
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else files[relative(dir, f)] = `${statSync(f).mtimeMs}:${readFileSync(f, "utf8")}`;
    }
  };
  walk(dir);
  return files;
}

describe("p3 guide（AI エージェント向けの作業の手順）", () => {
  it("プロジェクトに登録していない場所でも、JSON で形の版・実行中の版・入口の版・手順の全文を返す", () => {
    const here = tempDir("p3-guide-empty-");
    const r = p3(here, ["guide", "--json"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["cliVersion", "entryVersion", "guide", "schemaVersion"]);
    expect(j).toMatchObject({ schemaVersion: GUIDE_SCHEMA_VERSION, cliVersion: PKG.version, entryVersion: ENTRY_VERSION });
    expect(Number.isInteger(j.entryVersion) && (j.entryVersion as number) > 0).toBe(true);
    // 省かずに原本の全文
    expect(j.guide).toBe(source);
  });

  it("通常の出力は JSON の guide と同じ原本の手順", () => {
    const here = tempDir("p3-guide-text-");
    const text = p3(here, ["guide"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out.trimEnd()).toBe(source.trimEnd());
  });

  it("壊れた個人設定・壊れたプロジェクトの定義の中でも読める", () => {
    const root = tempDir("p3-guide-broken-");
    gitInit(root);
    mkdirSync(join(root, ".p3"));
    writeFileSync(join(root, ".p3", "project.yaml"), "name: [壊れた\n");
    const config = tempDir("p3-guide-badconfig-");
    mkdirSync(join(config, "infodb-p3"));
    writeFileSync(join(config, "infodb-p3", "config.yaml"), "projects: [壊れた\n");
    const r = p3(root, ["guide", "--json"], { XDG_CONFIG_HOME: config });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).guide).toBe(source);
  });

  it("位置引数は断る", () => {
    const r = p3(tempDir("p3-guide-arg-"), ["guide", "claude"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("guide は位置引数を取りません");
  });

  it("実行の前後で入口のファイル・データ・個人設定を変えず、Codex・Docker・npm を呼ばない", () => {
    const root = tempDir("p3-guide-same-");
    gitInit(root);
    mkdirSync(join(root, ".claude", "skills", "p3"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "p3", "SKILL.md"), "# 古い版\n");
    writeFileSync(join(root, "AGENTS.md"), "# 手順\n\n## タスク管理（infodb p3）\n\n- 古い節\n");
    mkdirSync(join(root, ".p3", "requests"), { recursive: true });
    writeFileSync(join(root, ".p3", "project.yaml"), "name: sample\n");
    const config = tempDir("p3-guide-config-keep-");
    mkdirSync(join(config, "infodb-p3"));
    writeFileSync(join(config, "infodb-p3", "config.yaml"), `projects:\n  sample:\n    dir: ${join(root, ".p3")}\n`);
    // 呼ばれたら印を残す偽のコマンドを PATH の先頭に置く
    const bin = tempDir("p3-guide-bin-");
    const marker = join(bin, "called");
    for (const name of ["docker", "codex", "npm", "pnpm", "npx", "pnpx"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> "${marker}"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const before = { repo: snapshot(root), config: snapshot(config) };
    for (const args of [["guide"], ["guide", "--json"]]) {
      const r = p3(root, args, { XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH ?? ""}` });
      expect(r.code, r.err).toBe(0);
    }
    expect({ repo: snapshot(root), config: snapshot(config) }).toEqual(before);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("手順の原本（src/cli/guide.md）", () => {
  it("呼び方は pnpx を先にし、短く書いた p3 は取得したときと同じ呼び方を指すと決める", () => {
    expect(source).toContain("P3_ACTOR=ai:<エージェント名> pnpx @infodb/p3 <コマンド>");
    expect(source).toContain("この手順を取得したときと同じ呼び方");
    expect(source).toMatch(/`pnpm add -g` などで入れたもの）に勝手に切り替えない/);
  });

  it("スキルの frontmatter を含まない（手順の本文だけ）", () => {
    expect(source.startsWith("# ")).toBe(true);
    expect(source).not.toMatch(/^---\n/);
    expect(source).not.toMatch(/^description:/m);
  });
});
