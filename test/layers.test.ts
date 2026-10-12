import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * src の層と依存の向き（docs/architecture.md「規則の置き場所」）。
 *   shared: 型と判定。何も読み込まない（node: も外のパッケージも。画面からも読む）
 *   core:   中核（保存の層・規則・requestOps・Preflight など）。shared だけ。HTTP（hono）は使わない
 *   server: HTTP の API と配信。core・shared
 *   cli:    CLI。core・shared（serve の起動の server/server.ts だけ server を読む）
 *   web:    画面。shared だけ（node: も使わない）
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
type Layer = "shared" | "core" | "server" | "cli" | "web";
const LAYERS: Layer[] = ["shared", "core", "server", "cli", "web"];

const ALLOWED: Record<Layer, Layer[]> = {
  shared: ["shared"],
  core: ["core", "shared"],
  server: ["server", "core", "shared"],
  cli: ["cli", "core", "shared"],
  web: ["web", "shared"],
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

const layerOf = (abs: string): Layer | undefined => LAYERS.find((l) => relative(SRC, abs).startsWith(`${l}/`));

/** 層ごとの違反（読み込んだファイル → 読み込んだもの） */
function violations(): string[] {
  const out: string[] = [];
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    const from = layerOf(file);
    if (!from || CONTAINER_ONLY.some((p) => rel.startsWith(p))) continue;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const to = layerOf(target);
        if (!to) continue;
        const targetRel = relative(SRC, target);
        // CLI が serve を起動するところだけ server を読む
        if (from === "cli" && targetRel === "server/server.ts") continue;
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

describe("src の層と依存の向き", () => {
  it("どの層も、読み込んでよい層だけを読み込む", () => {
    expect(violations()).toEqual([]);
  });

  it("server は HTTP の API と配信だけ（中核は core）", () => {
    const server = files(join(SRC, "server")).map((f) => relative(join(SRC, "server"), f));
    expect(server.filter((f) => !f.startsWith("api/") && f !== "server.ts")).toEqual([]);
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
