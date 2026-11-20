import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");

/** workspace の manifest（ルートは開発用。配布するのは packages/p3 の @infodb/p3）。packages/ の下は全部（足したパッケージも漏らさない） */
const PACKAGE_DIRS = readdirSync(new URL("packages/", root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const MANIFESTS = ["package.json", ...PACKAGE_DIRS.map((d) => `packages/${d}/package.json`)];
/** 同梱して公開しないパッケージ（入口のほか全部） */
const BUNDLED = MANIFESTS.filter((m) => m !== "package.json" && m !== "packages/p3/package.json");

describe("依存の指定", () => {
  it("llmcs の部品（codex-workspace・chatgpt-plan）は公開版の範囲で指定し、手元のフォルダへのリンクを残さない。workspace の参照は自分たちのパッケージだけ", () => {
    const pkg = JSON.parse(read("packages/p3/package.json"));
    expect(pkg.dependencies["@infodb/codex-workspace"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@infodb/chatgpt-plan"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@llmcs/codex-workspace"]).toBeUndefined();
    for (const m of MANIFESTS) {
      const j = JSON.parse(read(m));
      const all = Object.entries({ ...j.dependencies, ...j.devDependencies }) as [string, string][];
      expect(all.filter(([, v]) => /^(link|file|portal):/.test(v)), m).toEqual([]);
      expect(all.filter(([k, v]) => v.startsWith("workspace:") && !/^@infodb\/p3-(app|tasks|observer|shared)$/.test(k)), m).toEqual([]);
    }
    // lockfile のリンクは workspace の自分たちのパッケージ（入口 → アプリ・機能・shared、アプリ → 機能・shared、機能 → shared）だけ（手元の llmcs などを指さない）
    const lockLinks = [...read("pnpm-lock.yaml").matchAll(/\b(?:link|file):(\.\.?\/[^\s'"]*)/g)].map((m) => m[1]);
    expect(lockLinks.filter((l) => !/^\.\.\/(app|tasks|observer|shared)$/.test(l))).toEqual([]);
  });

  it("公開から日の浅い版を待たずに入れる例外は、自分たちが公開した @infodb の部品の版を固定したものだけ", () => {
    const ws = parse(read("pnpm-workspace.yaml")) as { minimumReleaseAgeExclude?: string[]; packages?: string[] };
    for (const e of ws.minimumReleaseAgeExclude ?? []) expect(e).toMatch(/^@infodb\/[a-z0-9-]+@\d+\.\d+\.\d+$/);
    expect(ws.packages).toEqual(["packages/*"]);
  });
});

describe("npm で配る中身（manifest）", () => {
  const pkg = JSON.parse(read("packages/p3/package.json"));
  const root = JSON.parse(read("package.json"));

  it("公開できる manifest（スコープ付きの公開・Node の版・bin）。ルートと同梱するパッケージは公開しない", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe("@infodb/p3");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.license).toBe("MIT");
    expect(pkg.engines.node).toBe(">=24");
    expect(pkg.bin).toEqual({ p3: "bin/p3.mjs" });
    expect(pkg.files).toEqual(["bin", "lib", "dist/web", "skills", "docs"]);
    // 利用者が入れるときにビルドや Docker を動かさない（入口の manifest にスクリプトを書かない。ビルドはルートの pnpm build）
    expect(pkg.scripts).toBeUndefined();
    expect(root.scripts.build).toBe("vite build && node scripts/build-cli.mjs --require-web");
    for (const m of ["package.json", ...BUNDLED]) expect(JSON.parse(read(m)).private, m).toBe(true);
    // 同じ版で出す（アプリ・機能・shared は同梱するので、版は入口とそろえる。製品ごとに版やタグを分けない）。observer も含めて全部の manifest
    expect(PACKAGE_DIRS).toEqual(["app", "observer", "p3", "shared", "tasks"]);
    for (const m of MANIFESTS) expect(JSON.parse(read(m)).version, m).toBe(pkg.version);
  });

  it("実行に要るものだけを実行時の依存にする（画面はビルドして配るので React などは開発用。同梱するパッケージは書かない）", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@hono/node-server", "@infodb/chatgpt-plan", "@infodb/codex-workspace", "hono", "yaml", "zod"]);
    // 同梱するパッケージの実行時の依存は、入口の依存に同じ範囲で入っている
    for (const m of BUNDLED) {
      for (const [k, v] of Object.entries((JSON.parse(read(m)).dependencies ?? {}) as Record<string, string>)) {
        if (k.startsWith("@infodb/p3-")) continue;
        expect(pkg.dependencies[k], `${m} の ${k}`).toBe(v);
      }
    }
  });
});
