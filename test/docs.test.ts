import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, headings, links, ROOT, slug } from "./docLinks.ts";

describe("文書のリンク", () => {
  it("README と docs/ の相対リンクの先があり、節のアンカーが見出しにある", () => {
    const broken: string[] = [];
    for (const file of DOCS) {
      for (const { target, anchor } of links(file)) {
        if (!existsSync(join(ROOT, target))) broken.push(`${file} → ${target}（ファイルが無い）`);
        else if (anchor && target.endsWith(".md") && !headings(target).has(anchor)) broken.push(`${file} → ${target}#${anchor}（見出しが無い）`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("README から導入・使い方・開発のガイドへ辿れる", () => {
    const targets = links("README.md").map((l) => l.target);
    for (const f of ["docs/installation.md", "docs/how-to-use.md", "docs/development.md"]) expect(targets).toContain(f);
  });

  it("README から開発の工程と P3 の受け持ちの節へ辿れる", () => {
    const link = links("README.md").find((l) => l.target === "docs/architecture.md" && l.anchor === slug("開発の工程と P3 の受け持ち"));
    expect(link).toBeDefined();
    expect(headings("docs/architecture.md").has(link!.anchor!)).toBe(true);
  });

  it("アンカーの作り方は GitHub と同じ", () => {
    expect(slug("タグ・期限・マイルストーン")).toBe("タグ期限マイルストーン");
    expect(slug("5. パスの対応を書く（DevContainer のときだけ）")).toBe("5-パスの対応を書くdevcontainer-のときだけ");
    expect(slug("`codex-workspace` の依存")).toBe("codex-workspace-の依存");
  });
});

/** 見出し（## の段）から次の同じ段の見出しまで */
function section(file: string, heading: RegExp): string {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## ") && heading.test(l));
  expect(start, `${file} に ${heading} の節が無い`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** 段階 1 以降の準備（ChatGPT の接続・Codex のイメージ・パスの対応・Docker の操作） */
const LATER_SETUP = /chatgpt login|codex update|render update|codex\.pathMap|P3_CODEX_PATH_MAP|docker (version|ps|inspect|run|pull|exec)/i;

describe("導入の段階", () => {
  it("README の最短の手順は3つ以内で、段階 1 以降の準備（Docker・ChatGPT・Preflight）を求めない", () => {
    const quick = section("README.md", /最短の手順/);
    expect(quick.split("\n").filter((l) => /^\d+\. /.test(l)).length).toBeLessThanOrEqual(3);
    expect(quick).not.toMatch(LATER_SETUP);
    expect(quick).not.toMatch(/Docker|ChatGPT|Preflight|Codex/);
    expect(quick).toMatch(/join/);
    expect(quick).toMatch(/serve/);
  });

  it("導入ガイドは段階 0・1・2 の順で、段階 0 に段階 1 以降の準備が入り込まない", () => {
    const text = readFileSync(join(ROOT, "docs/installation.md"), "utf8");
    const order = [/^## 段階 0/m, /^## 段階 1/m, /^## 段階 2/m].map((h) => text.search(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(section("docs/installation.md", /段階 0/)).not.toMatch(LATER_SETUP);
    // 段階 1 以降の準備は段階 1 にある
    expect(section("docs/installation.md", /段階 1/)).toMatch(LATER_SETUP);
  });
});
