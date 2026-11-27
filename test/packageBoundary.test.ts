import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * パッケージの境界（docs/architecture.md「パッケージの構成」）。依存は 入口 → アプリ／機能／shared、アプリ → 機能／shared、tasks → observer、機能 → shared の一方向。
 *   入口 @infodb/p3（packages/p3）: CLI の起動・振り分けと入口だけの処理（init / join / agents・guide）。配布の窓口
 *   @infodb/p3-app（packages/app）: serve の組み立て・画面の外枠・プロジェクトの登録・機能をつなぐアダプター
 *   @infodb/p3-tasks（packages/tasks）・@infodb/p3-observer（packages/observer）: 機能。自分のページ・コマンド・API・データを持つ。
 *     機能の間は tasks → observer の一方向だけ（tasks が要望・タスクの操作のその場で観測のシステムの項目に値を書く。observer は tasks を読まない）
 *   @infodb/p3-shared（packages/shared）: 横断する処理（src/node は Node だけ、src/web は画面）。何も読まない
 * パッケージの間はパッケージ名（@infodb/p3-tasks/... ）で読み、相対パスで別のパッケージのファイルを指さない。読むパッケージは manifest に書く
 */
const PACKAGES = fileURLToPath(new URL("../packages/", import.meta.url));
type Pkg = "p3" | "app" | "tasks" | "observer" | "shared";
/** 機能（アプリが載せるもの） */
const FEATURES = ["tasks", "observer"] as const;
const DIRS = Object.fromEntries((["p3", "app", "tasks", "observer", "shared"] as const).map((p) => [p, join(PACKAGES, p)])) as Record<Pkg, string>;
const NAME: Record<Pkg, string> = { p3: "@infodb/p3", app: "@infodb/p3-app", tasks: "@infodb/p3-tasks", observer: "@infodb/p3-observer", shared: "@infodb/p3-shared" };
const ALLOWED: Record<Pkg, Pkg[]> = { p3: ["p3", "app", ...FEATURES, "shared"], app: ["app", ...FEATURES, "shared"], tasks: ["tasks", "observer", "shared"], observer: ["observer", "shared"], shared: ["shared"] };
const PKGS = Object.keys(DIRS) as Pkg[];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith(".gen.ts") ? [p] : [];
  });
}
/** パッケージのソース（src と、入口の bin） */
const sources = (pkg: Pkg) => [...files(join(DIRS[pkg], "src")), ...files(join(DIRS[pkg], "bin"))];

/** import・export ... from・動的 import・副作用の import（型だけの import も含む） */
function specifiers(text: string): string[] {
  const re = /(?:^|\s)(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const pkgOfPath = (abs: string): Pkg | undefined => PKGS.find((p) => !relative(DIRS[p], abs).startsWith(".."));
const pkgOfName = (spec: string): Pkg | undefined => PKGS.find((p) => spec === NAME[p] || spec.startsWith(`${NAME[p]}/`));

/** パッケージの間の読み込み（"p3→tasks" の形）と違反 */
function scan() {
  const uses = new Set<string>();
  const violations: string[] = [];
  for (const from of PKGS)
    for (const file of sources(from)) {
      const rel = relative(PACKAGES, file);
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".")) {
          const to = pkgOfPath(resolve(dirname(file), spec));
          if (to !== from) violations.push(`${rel} → ${spec}（相対パスで別のパッケージを指さない。${to ? NAME[to] : "パッケージの外"} はパッケージ名で読む）`);
          continue;
        }
        const to = pkgOfName(spec);
        if (!to) continue;
        if (to === from) violations.push(`${rel} → ${spec}（自分のパッケージは相対パスで読む）`);
        else if (!ALLOWED[from].includes(to)) violations.push(`${rel} → ${spec}（${NAME[from]} は ${NAME[to]} を読まない）`);
        uses.add(`${from}→${to}`);
      }
    }
  return { uses: [...uses].sort(), violations };
}

interface Manifest {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const manifest = (pkg: Pkg) => JSON.parse(readFileSync(join(DIRS[pkg], "package.json"), "utf8")) as Manifest;
const declaredRange = (pkg: Pkg, dep: Pkg) => manifest(pkg).dependencies?.[NAME[dep]] ?? manifest(pkg).devDependencies?.[NAME[dep]];

describe("パッケージの境界", () => {
  it("入口 → アプリ → 機能 → shared の一方向だけ。機能の間は tasks → observer だけ。逆向き・相対パスでの迂回は無い", () => {
    const { uses, violations } = scan();
    expect(violations).toEqual([]);
    expect(uses).toEqual(["app→observer", "app→shared", "app→tasks", "observer→shared", "p3→app", "p3→observer", "p3→shared", "p3→tasks", "tasks→observer", "tasks→shared"]);
    // observer は tasks を読まない（読み合いの循環を作らない）
    expect(uses.filter((u) => u === "observer→tasks")).toEqual([]);
  });

  it("機能の間・共通層から上への読み込みと、相対パスでの迂回を見つける（確かめ方そのもの）", () => {
    const check = (from: Pkg, file: string, spec: string) => {
      const to = spec.startsWith(".") ? pkgOfPath(resolve(dirname(file), spec)) : pkgOfName(spec);
      return to !== undefined && to !== from && !ALLOWED[from].includes(to);
    };
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "@infodb/p3-tasks/core/context.ts")).toBe(true);
    expect(check("tasks", join(DIRS.tasks, "src", "core", "x.ts"), "@infodb/p3-observer/core/metricStore.ts")).toBe(false);
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "../../../tasks/src/core/context.ts")).toBe(true);
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "@infodb/p3-shared/node/appInfo.ts")).toBe(false);
    expect(check("shared", join(DIRS.shared, "src", "node", "x.ts"), "@infodb/p3-tasks/core/context.ts")).toBe(true);
    expect(check("tasks", join(DIRS.tasks, "src", "core", "x.ts"), "@infodb/p3-app/server/server.ts")).toBe(true);
  });

  it("読むパッケージを manifest に workspace の参照で書き、読まないパッケージは書かない", () => {
    const { uses } = scan();
    for (const pkg of PKGS) {
      expect(manifest(pkg).name).toBe(NAME[pkg]);
      const reads = uses.filter((u) => u.startsWith(`${pkg}→`)).map((u) => u.split("→")[1]);
      expect(PKGS.filter((p) => p !== pkg && declaredRange(pkg, p)).sort(), pkg).toEqual(reads.sort());
      for (const p of reads as Pkg[]) expect(declaredRange(pkg, p)).toBe("workspace:*");
    }
    // 配布するのは入口だけ。ほかは同梱する（公開しない）。入口の実行時の依存に workspace のパッケージを書かない
    expect(PKGS.map((p) => manifest(p).private)).toEqual([undefined, true, true, true, true]);
    expect(Object.keys(manifest("p3").dependencies ?? {}).filter((d) => d.startsWith("@infodb/p3"))).toEqual([]);
  });

  it("shared の処理はどれも使われている（使い手の無いものを先回りして置かない）", () => {
    const users = new Map<string, Set<Pkg>>(files(join(DIRS.shared, "src")).map((f) => [relative(join(DIRS.shared, "src"), f), new Set()]));
    for (const from of PKGS.filter((p) => p !== "shared"))
      for (const file of sources(from))
        for (const spec of specifiers(readFileSync(file, "utf8")))
          if (spec.startsWith(`${NAME.shared}/`)) users.get(spec.slice(NAME.shared.length + 1))?.add(from);
    expect([...users].filter(([, s]) => s.size === 0).map(([f]) => f)).toEqual([]);
  });

  it("workspace のパッケージは入口・アプリ・機能・shared だけ（増やすときはこの境界の一覧に足す）", () => {
    expect(readdirSync(PACKAGES).sort()).toEqual(["app", "observer", "p3", "shared", "tasks"]);
  });

  it("確かめ方そのものが、型だけ・再 export・動的 import も拾う", () => {
    expect(specifiers(`import type { A } from "@infodb/p3/cli/main.ts";\nexport { b } from "../../tasks/src/x.ts";\nconst m = await import("@infodb/p3-shared/node/usage.ts");`)).toEqual([
      "@infodb/p3/cli/main.ts",
      "../../tasks/src/x.ts",
      "@infodb/p3-shared/node/usage.ts",
    ]);
  });
});
