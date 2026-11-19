import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * パッケージの境界（docs/architecture.md「パッケージの構成」）。
 *   入口 @infodb/p3（packages/p3）: 起動・CLI の振り分け・init / join / agents・serve の組み立て・画面の外枠。tasks と kit を読める
 *   @infodb/p3-tasks（packages/tasks）: 今の p3 の機能。kit だけを読める（入口を読まない。入口からは値と関数で受け取る）
 *   @infodb/p3-observer（packages/observer）: 観測基盤（準備中）。kit だけを読める。製品どうし（tasks ⇔ observer）は読まない
 *   @infodb/p3-kit（packages/kit）: 入口と製品が使う最小限の共通処理。何も読まない
 * パッケージの間はパッケージ名（@infodb/p3-tasks/... ）で読み、相対パスで別のパッケージのファイルを指さない。読むパッケージは manifest に書く
 */
const PACKAGES = fileURLToPath(new URL("../packages/", import.meta.url));
type Pkg = "p3" | "tasks" | "observer" | "kit";
/** 製品（入口が知っていて組み込むもの） */
const PRODUCTS = ["tasks", "observer"] as const;
const DIRS: Record<Pkg, string> = { p3: join(PACKAGES, "p3"), tasks: join(PACKAGES, "tasks"), observer: join(PACKAGES, "observer"), kit: join(PACKAGES, "kit") };
const NAME: Record<Pkg, string> = { p3: "@infodb/p3", tasks: "@infodb/p3-tasks", observer: "@infodb/p3-observer", kit: "@infodb/p3-kit" };
const ALLOWED: Record<Pkg, Pkg[]> = { p3: ["p3", ...PRODUCTS, "kit"], tasks: ["tasks", "kit"], observer: ["observer", "kit"], kit: ["kit"] };
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
  it("入口 → 製品（tasks・observer）→ kit の一方向だけ。逆向き・製品の間・相対パスでの迂回は無い", () => {
    const { uses, violations } = scan();
    expect(violations).toEqual([]);
    expect(uses).toEqual(["observer→kit", "p3→kit", "p3→tasks", "tasks→kit"]);
    // 製品どうしは読まない（連携が要るなら kit の小さな約束事を通す）
    expect(uses.filter((u) => u === "tasks→observer" || u === "observer→tasks")).toEqual([]);
  });

  it("製品の間の直接の読み込みと、相対パスでの迂回を見つける（確かめ方そのもの）", () => {
    const check = (from: Pkg, file: string, spec: string) => {
      const to = spec.startsWith(".") ? pkgOfPath(resolve(dirname(file), spec)) : pkgOfName(spec);
      return to !== undefined && to !== from && !ALLOWED[from].includes(to);
    };
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "@infodb/p3-tasks/core/context.ts")).toBe(true);
    expect(check("tasks", join(DIRS.tasks, "src", "core", "x.ts"), "@infodb/p3-observer/core/status.ts")).toBe(true);
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "../../../tasks/src/core/context.ts")).toBe(true);
    expect(check("observer", join(DIRS.observer, "src", "core", "x.ts"), "@infodb/p3-kit/appInfo.ts")).toBe(false);
  });

  it("読むパッケージを manifest に workspace の参照で書き、読まないパッケージは書かない", () => {
    const { uses } = scan();
    for (const pkg of PKGS) {
      expect(manifest(pkg).name).toBe(NAME[pkg]);
      const reads = uses.filter((u) => u.startsWith(`${pkg}→`)).map((u) => u.split("→")[1]);
      expect(PKGS.filter((p) => p !== pkg && declaredRange(pkg, p)).sort(), pkg).toEqual(reads.sort());
      for (const p of reads as Pkg[]) expect(declaredRange(pkg, p)).toBe("workspace:*");
    }
    // 配布するのは入口だけ。kit・製品は同梱する（公開しない）。入口の実行時の依存に workspace のパッケージを書かない
    expect([manifest("kit").private, manifest("tasks").private, manifest("observer").private, manifest("p3").private]).toEqual([true, true, true, undefined]);
    expect(Object.keys(manifest("p3").dependencies ?? {}).filter((d) => d.startsWith("@infodb/p3"))).toEqual([]);
  });

  it("kit の処理はどれも入口か製品から使われている（使い手の無いものを先回りして置かない）", () => {
    const users = new Map<string, Set<Pkg>>(files(join(DIRS.kit, "src")).map((f) => [relative(join(DIRS.kit, "src"), f), new Set()]));
    for (const from of ["p3", ...PRODUCTS] as const)
      for (const file of sources(from))
        for (const spec of specifiers(readFileSync(file, "utf8")))
          if (spec.startsWith(`${NAME.kit}/`)) users.get(spec.slice(NAME.kit.length + 1))?.add(from);
    expect([...users].filter(([, s]) => s.size === 0).map(([f]) => f)).toEqual([]);
    // CLI の使い方の誤り・パス・git の小物と、動いている版（製品に共通の版）は、入口と製品が使う
    expect([...users.get("usage.ts")!].sort()).toEqual(["observer", "p3", "tasks"]);
    expect([...users.get("appInfo.ts")!].sort()).toEqual(["observer", "p3", "tasks"]);
  });

  it("workspace のパッケージは入口・製品・kit だけ（増やすときはこの境界の一覧に足す）", () => {
    expect(readdirSync(PACKAGES).sort()).toEqual(["kit", "observer", "p3", "tasks"]);
  });

  it("確かめ方そのものが、型だけ・再 export・動的 import も拾う", () => {
    expect(specifiers(`import type { A } from "@infodb/p3/cli/main.ts";\nexport { b } from "../../tasks/src/x.ts";\nconst m = await import("@infodb/p3-kit/usage.ts");`)).toEqual([
      "@infodb/p3/cli/main.ts",
      "../../tasks/src/x.ts",
      "@infodb/p3-kit/usage.ts",
    ]);
  });
});
