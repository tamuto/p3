import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 層と依存の向き（docs/architecture.md「規則の置き場所」）。入口（packages/p3）と tasks（packages/tasks）の src は同じ層に分ける。
 * パッケージの間の向き（入口 → tasks → kit）は test/packageBoundary.test.ts。ここではパッケージ名で読み込んだ先も層で照らす。
 *   shared: 型と判定。何も読み込まない（node: も外のパッケージも。画面からも読む）
 *   core:   中核（保存の層・規則・requestOps・Preflight など）。shared と kit だけ。HTTP（hono）は使わない
 *   server: HTTP の API と配信。core・shared・kit
 *   cli:    CLI。core・shared・kit（serve の起動の server/server.ts だけ server を読む）
 *   web:    画面。shared だけ（node: も使わない）
 *   kit:    入口と製品が使う最小限の共通処理（packages/kit/src。node: は使ってよい。画面からは読まない）
 */
const PACKAGES = fileURLToPath(new URL("../packages/", import.meta.url));
const SRCS = { p3: join(PACKAGES, "p3/src"), tasks: join(PACKAGES, "tasks/src"), kit: join(PACKAGES, "kit/src") };
const NAMES: Record<string, keyof typeof SRCS> = { "@infodb/p3-tasks": "tasks", "@infodb/p3-kit": "kit" };
type Layer = "shared" | "core" | "server" | "cli" | "web" | "kit";
const LAYERS: Layer[] = ["shared", "core", "server", "cli", "web"];

const ALLOWED: Record<Layer, Layer[]> = {
  shared: ["shared"],
  core: ["core", "shared", "kit"],
  server: ["server", "core", "shared", "kit"],
  cli: ["cli", "core", "shared", "kit"],
  web: ["web", "shared"],
  kit: ["kit"],
};

/** コンテナの中で動くファイル（P3 のプロセスでは読み込まない） */
const CONTAINER_ONLY = ["core/preflight/render-image/"];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith(".gen.ts") ? [p] : [];
  });
}

function specifiers(text: string): string[] {
  const re = /(?:^|\s)(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** ファイル（絶対パス）のパッケージと、その src の中の相対パス */
function locate(abs: string): { pkg: keyof typeof SRCS; rel: string } | undefined {
  for (const [pkg, src] of Object.entries(SRCS) as [keyof typeof SRCS, string][]) {
    const rel = relative(src, abs);
    if (!rel.startsWith("..")) return { pkg, rel };
  }
  return undefined;
}

const layerOf = (loc: { pkg: keyof typeof SRCS; rel: string } | undefined): Layer | undefined =>
  !loc ? undefined : loc.pkg === "kit" ? "kit" : LAYERS.find((l) => loc.rel.startsWith(`${l}/`));

/** パッケージ名の指定（@infodb/p3-tasks/core/x.ts）を、そのパッケージの src の中のファイルにする */
function bareTarget(spec: string): string | undefined {
  const name = spec.split("/").slice(0, 2).join("/");
  const pkg = NAMES[name];
  return pkg ? join(SRCS[pkg], spec.slice(name.length + 1)) : undefined;
}

/** 層ごとの違反（読み込んだファイル → 読み込んだもの） */
function violations(): string[] {
  const out: string[] = [];
  for (const src of Object.values(SRCS))
    for (const file of files(src)) {
      const loc = locate(file)!;
      const rel = `${loc.pkg}/${loc.rel}`;
      const from = layerOf(loc);
      if (!from || CONTAINER_ONLY.some((p) => loc.rel.startsWith(p))) continue;
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const internal = spec.startsWith(".") ? resolve(dirname(file), spec) : bareTarget(spec);
        if (internal) {
          const tloc = locate(internal);
          const to = layerOf(tloc);
          if (!to || !tloc) continue;
          const targetRel = `${tloc.pkg}/${tloc.rel}`;
          // CLI が serve を起動するところだけ server を読む
          if (from === "cli" && targetRel === "p3/server/server.ts") continue;
          if (!ALLOWED[from].includes(to)) out.push(`${rel} → ${targetRel}（${from} は ${to} を読み込まない）`);
          continue;
        }
        const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        if (from === "shared") out.push(`${rel} → ${spec}（shared は外のものを読み込まない）`);
        else if (from === "web" && spec.startsWith("node:")) out.push(`${rel} → ${spec}（画面は node: を使わない）`);
        else if (from === "core" && (pkg === "hono" || pkg === "@hono/node-server")) out.push(`${rel} → ${spec}（core は HTTP の層を使わない）`);
      }
    }
  return out;
}

describe("層と依存の向き", () => {
  it("どの層も、読み込んでよい層だけを読み込む", () => {
    expect(violations()).toEqual([]);
  });

  it("server は HTTP の API と配信だけ（中核は core）", () => {
    for (const src of [SRCS.p3, SRCS.tasks]) {
      const server = files(join(src, "server")).map((f) => relative(join(src, "server"), f));
      expect(server.filter((f) => !f.startsWith("api/") && f !== "server.ts")).toEqual([]);
    }
  });

  it("確かめ方そのものが違反を見つける", () => {
    expect(specifiers(`import { a } from "../core/x.ts";\nimport type { B } from "./b.ts";\nconst m = await import("node:fs");\nimport "./side.ts";`)).toEqual([
      "../core/x.ts",
      "./b.ts",
      "node:fs",
      "./side.ts",
    ]);
  });
});
