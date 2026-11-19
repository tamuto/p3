import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 複数パッケージの構成（B 案。docs/architecture.md「パッケージの構成」）に移す前の、今の src/ の中の境界。
 *   入口（p3）: 起動・CLI の振り分け・init / join / agents・serve の組み立て・画面の外枠。製品（tasks）と kit を読める
 *   tasks:     今の p3 の機能。kit だけを読める（入口を読まない。入口からは値と関数で受け取る）
 *   kit:       入口と製品が使う最小限の共通処理。何も読まない
 * 載っていないファイルは tasks。移したときはパッケージの間の検査（同じ向き）に置き換える
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

export const ENTRY_FILES = [
  "cli/main.ts",
  "cli/help.ts",
  "cli/guide.ts",
  "cli/agentsStatus.ts",
  "cli/project.ts",
  "server/server.ts",
  "server/api/projectsRoutes.ts",
  "core/projectRegistry.ts",
  "web/main.tsx",
  "web/Boot.tsx",
  "web/App.tsx",
  "web/router.tsx",
  "web/routes/__root.tsx",
  "web/components/ProjectSwitcher.tsx",
  "web/components/ProjectChooser.tsx",
];
export const KIT_FILES = ["core/store/fsutil.ts", "core/store/frontmatter.ts", "cli/usage.ts"];

type Pkg = "p3" | "tasks" | "kit";
const ALLOWED: Record<Pkg, Pkg[]> = { p3: ["p3", "tasks", "kit"], tasks: ["tasks", "kit"], kit: ["kit"] };
const pkgOf = (rel: string): Pkg => (ENTRY_FILES.includes(rel) ? "p3" : KIT_FILES.includes(rel) ? "kit" : "tasks");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith(".gen.ts") ? [p] : [];
  });
}

/** 相対の import・export・動的 import・型だけの import（型も向きに入れる） */
function relativeSpecifiers(text: string): string[] {
  const re = /(?:^|\s)(?:import|export)\s[^"';]*?from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|^\s*import\s*["'](\.[^"']+)["']/gm;
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

describe("パッケージの境界（今の src/ の中）", () => {
  it("入口 → tasks → kit の一方向だけ。tasks は入口を、kit はほかを読まない", () => {
    const out: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      const from = pkgOf(rel);
      for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
        const target = relative(SRC, resolve(dirname(file), spec));
        if (target.startsWith("..")) continue;
        const to = pkgOf(target);
        if (!ALLOWED[from].includes(to)) out.push(`${rel}（${from}）→ ${target}（${to}）`);
      }
    }
    expect(out).toEqual([]);
  });

  it("一覧のファイルはどれもある（移した・消したら一覧も直す）", () => {
    const all = new Set(files(SRC).map((f) => relative(SRC, f)));
    expect([...ENTRY_FILES, ...KIT_FILES].filter((f) => !all.has(f))).toEqual([]);
  });

  it("kit の処理はどれも入口か tasks から使われている（使い手の無いものを先回りして置かない。使い手の見込みは docs/architecture.md）", () => {
    const users = new Map<string, Set<Pkg>>(KIT_FILES.map((f) => [f, new Set()]));
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
        const target = relative(SRC, resolve(dirname(file), spec));
        if (users.has(target) && pkgOf(rel) !== "kit") users.get(target)!.add(pkgOf(rel));
      }
    }
    expect([...users].filter(([, s]) => s.size === 0).map(([f]) => f)).toEqual([]);
    // CLI の使い方の誤り・パス・git の小物は、入口と tasks の両方が使う
    expect([...users.get("cli/usage.ts")!].sort()).toEqual(["p3", "tasks"]);
  });
});
