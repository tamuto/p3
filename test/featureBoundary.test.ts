import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * tasks の中の機能のまとまり（packages/tasks/src/features/<機能>/{shared,core,cli,server,web}。docs/refactoring.md「モジュール構成」）。
 *   - 機能の shared/（型と判定の純粋な契約）は、どこからでも読める
 *   - 共通の土台の core・shared は、機能の中身を読まない（下の組み立ての場所 ASSEMBLY だけが例外。理由と一緒に列挙する）
 *   - 入口の役の層（cli・server）は、機能の core と同じ層（cli→cli、server→server）を呼んで組み立ててよい。画面（web）は機能の web の部品を組み合わせてよい
 *   - 機能の core が別の機能の core を読むのは禁止（契約は shared/ に置く）。機能どうしの読み込みは循環しない
 * 組み立ての場所を足すときは、理由と一緒にここに書く（何でも読める場所を増やさない）
 */
const SRC = fileURLToPath(new URL("../packages/tasks/src/", import.meta.url));

/** 共通の土台の core のうち、機能の core を読んでよい組み立ての場所（tasks/src からの相対） */
export const ASSEMBLY: Record<string, string> = {
  "core/context.ts": "プロジェクトを開くときに各機能のサービスを作る",
  "core/store/workspace.ts": "保存の入口として各機能の記録のストアを持つ",
  "core/errorOutcome.ts": "エラーから終了コード・HTTP の状態への対応の表",
  "core/requestOps.ts": "変更の手順の中で、完了の記録の参照先・品質基準の取り込みを使い、マイルストーンを消す前に各機能の記録があるかを確かめる",
  "core/ops.ts": "進捗の集計に見直し候補の数を添える",
};

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !e.name.endsWith(".gen.ts") ? [p] : [];
  });
}
function specifiers(text: string): string[] {
  const re = /(?:^|\s)(?:import|export)\s[^"';]*?from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|^\s*import\s*["'](\.[^"']+)["']/gm;
  return [...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]);
}
/** features/<機能>/<中の層>/... なら [機能, 層] */
const featureOf = (rel: string): [string, string] | undefined => {
  const m = /^features\/([^/]+)\/([^/]+)\//.exec(rel);
  return m ? [m[1], m[2]] : undefined;
};

/** ファイルの層（機能の中なら機能の中の層） */
const layerOf = (rel: string) => featureOf(rel)?.[1] ?? rel.split("/")[0];

/** from（tasks/src からの相対）が、機能 g の層 sub のファイルを読んでよいか */
function allowed(from: string, g: string, sub: string): boolean {
  if (featureOf(from)?.[0] === g || sub === "shared") return true;
  const layer = layerOf(from);
  if ((layer === "cli" || layer === "server") && (sub === layer || sub === "core")) return true;
  if (layer === "web" && sub === "web") return true;
  return from in ASSEMBLY || from.startsWith("web/routes/");
}

function scan() {
  const violations: string[] = [];
  const edges = new Set<string>();
  for (const file of files(SRC)) {
    const rel = relative(SRC, file);
    const from = featureOf(rel)?.[0];
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const target = relative(SRC, resolve(dirname(file), spec));
      const to = featureOf(target);
      if (!to) continue;
      const [g, sub] = to;
      if (from && from !== g) edges.add(`${from}→${g}`);
      if (!allowed(rel, g, sub)) violations.push(`${rel} → ${target}（機能 ${g} の ${sub}。この場所からは shared/ を読む）`);
    }
  }
  return { violations, edges: [...edges].sort() };
}

describe("tasks の機能のまとまり", () => {
  it("機能の中身は、その機能自身・組み立ての場所・ルートの宣言だけが読む（ほかは shared/ の契約を読む）", () => {
    expect(scan().violations).toEqual([]);
  });

  it("機能どうしの読み込みは循環しない", () => {
    const { edges } = scan();
    const next = new Map<string, string[]>();
    for (const e of edges) {
      const [a, b] = e.split("→");
      next.set(a, [...(next.get(a) ?? []), b]);
    }
    const cycles: string[] = [];
    const visit = (n: string, path: string[]) => {
      if (path.includes(n)) return void cycles.push([...path.slice(path.indexOf(n)), n].join(" → "));
      for (const m of next.get(n) ?? []) visit(m, [...path, n]);
    };
    for (const n of next.keys()) visit(n, []);
    expect(cycles).toEqual([]);
  });

  it("組み立ての場所の一覧のファイルはどれもある", () => {
    expect(Object.keys(ASSEMBLY).filter((f) => !existsSync(join(SRC, f)))).toEqual([]);
  });
});
