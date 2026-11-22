import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 画面の共通部品と意味の色（docs/development.md「画面の共通部品」）。tasks・observer・アプリのソースとスタイルに、次を書いたら落とす:
 *   素の <button>（buttonCls を付けたものも。Button・IconButton・PlainButton・Segmented・Tabs を使う）/ パレットの色名のユーティリティ（接頭辞・dark: も）/
 *   色名を組み立てるクラス（bg-${tone}-500 など）/ 固定の色の値（rgb()・hsl()・oklch()・"#fff"・bg-[#…]）
 * 色と部品を定義する packages/shared/src/web と生成物（*.gen.ts）は対象の外。どうしても残すものは ALLOWED に箇所と理由を書く
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGETS = ["packages/tasks/src", "packages/observer/src", "packages/app/src"];

/** 許すもの（ファイル・その行に含まれる文字列・理由）。理由の無い項目と、もう当てはまらない項目も落とす */
export const ALLOWED: { file: string; text: string; reason: string }[] = [
  { file: "packages/app/src/web/index.css", text: "rgb(255 255 255 / 0.35)", reason: "推定の期間のバーの模様。塗りの色に重ねる半透明の白の斜線で、テーマで変えない（意味の色ではない）" },
];

const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const UTIL = "bg|text|border(?:-[trblxyse])?|divide|ring|ring-offset|outline|fill|stroke|decoration|placeholder|shadow|inset-shadow|drop-shadow|from|via|to|accent|caret";
const RULES: { name: string; re: RegExp; tsxOnly?: boolean }[] = [
  { name: "素の <button>（共通部品を使う）", re: /<button\b/, tsxOnly: true },
  { name: "パレットの色名（意味の色を使う）", re: new RegExp(String.raw`(?<![\w-])(?:${UTIL})-(?:${PALETTE})(?:-\d{2,3})?(?:\/\d+)?(?![\w-])`) },
  { name: "色名を組み立てるクラス", re: new RegExp(String.raw`(?<![\w-])(?:${UTIL})-\$\{`) },
  { name: "固定の色の値（意味の色を使う）", re: /\b(?:rgba?|hsla?|oklch)\(|["'`]#[0-9a-fA-F]{3,8}["'`]|-\[#[0-9a-fA-F]/ },
];

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** 1つのファイルの指摘（file はリポジトリからの相対パス） */
export function findIssues(file: string, src: string): Finding[] {
  if (file.startsWith("packages/shared/src/web/") || file.endsWith(".gen.ts")) return [];
  return src.split("\n").flatMap((text, i) =>
    RULES.filter((r) => (!r.tsxOnly || file.endsWith(".tsx")) && r.re.test(text)).map((r) => ({ file, line: i + 1, rule: r.name, text: text.trim() })),
  );
}

/** 許可の一覧で外し、残った指摘と、理由の無い・使われていない許可を返す */
export function applyAllowed(findings: Finding[], allowed: typeof ALLOWED) {
  const used = new Set<number>();
  const left = findings.filter((f) => {
    const i = allowed.findIndex((a) => a.file === f.file && f.text.includes(a.text));
    if (i < 0) return true;
    used.add(i);
    return false;
  });
  const bad = allowed.flatMap((a, i) => [...(!a.reason.trim() ? [`理由がありません: ${a.file} ${a.text}`] : []), ...(!used.has(i) ? [`もう当てはまりません: ${a.file} ${a.text}`] : [])]);
  return { left, bad };
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(tsx?|css)$/.test(e.name) ? [p] : [];
  });
}

describe("画面の共通部品と意味の色", () => {
  it("tasks・observer・アプリに素の button・パレットの色名・固定の色を書いていない（残すものは理由つきで許可の一覧）", () => {
    const findings = TARGETS.flatMap((t) => files(join(ROOT, t))).flatMap((p) => findIssues(relative(ROOT, p).replaceAll("\\", "/"), readFileSync(p, "utf8")));
    const { left, bad } = applyAllowed(findings, ALLOWED);
    expect(left.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.text.slice(0, 120)}`)).toEqual([]);
    expect(bad).toEqual([]);
  });

  const rules = (file: string, src: string) => findIssues(file, src).map((f) => f.rule);
  it("接頭辞・条件分岐・組み立て・固定の色を見つけ、意味の色・文言・定義の場所・生成物は通す", () => {
    const f = "packages/tasks/src/web/X.tsx";
    expect(rules(f, `<button onClick={go}>`)).toEqual(["素の <button>（共通部品を使う）"]);
    expect(rules(f, `<Button className={buttonCls("link")}>`)).toEqual([]);
    for (const c of [`"text-slate-500"`, `"dark:hover:bg-slate-800"`, `"aria-selected:text-indigo-700"`, `ok ? "ring-1 ring-rose-300" : ""`, `"bg-amber-50/40"`, `"focus-visible:ring-indigo-500"`, `"text-white bg-red-600"`])
      expect(rules(f, c), c).toEqual(["パレットの色名（意味の色を使う）"]);
    expect(rules(f, "`bg-${tone}-500`")).toEqual(["色名を組み立てるクラス"]);
    for (const c of [`style={{ color: "rgb(1 2 3)" }}`, `color: "#fff"`, `"bg-[#123456]"`]) expect(rules(f, c), c).toEqual(["固定の色の値（意味の色を使う）"]);
    for (const c of [`"text-fg-4 bg-surface border-line"`, `"hover:bg-accent-soft dark:ring-line text-warn-strong"`, `"text-white backdrop:bg-black/60"`, `<p>rose・amber・sky の色の名前</p>`, `href={"#top"}`, `<a href={\`#\${id}\`}>`])
      expect(rules(f, c), c).toEqual([]);
    expect(rules("packages/shared/src/web/ui.tsx", `"bg-indigo-600" <button`)).toEqual([]);
    expect(rules("packages/app/src/web/routeTree.gen.ts", `"text-slate-500"`)).toEqual([]);
    expect(rules("packages/app/src/web/index.css", `@apply bg-slate-50; <button`)).toEqual(["パレットの色名（意味の色を使う）"]);
  });

  it("許可の一覧は個別の箇所だけを外し、理由の無い項目と使われていない項目を知らせる", () => {
    const fs = [...findIssues("a.tsx", `"text-rose-600"`), ...findIssues("b.tsx", `"text-rose-600"`)];
    const r = applyAllowed(fs, [
      { file: "a.tsx", text: "text-rose-600", reason: "例" },
      { file: "c.tsx", text: "x", reason: "" },
    ]);
    expect(r.left.map((f) => f.file)).toEqual(["b.tsx"]);
    expect(r.bad).toEqual(["理由がありません: c.tsx x", "もう当てはまりません: c.tsx x"]);
  });
});
