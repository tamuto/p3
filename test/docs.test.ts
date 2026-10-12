import { existsSync } from "node:fs";
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

  it("アンカーの作り方は GitHub と同じ", () => {
    expect(slug("タグ・期限・マイルストーン")).toBe("タグ期限マイルストーン");
    expect(slug("5. パスの対応を書く（DevContainer のときだけ）")).toBe("5-パスの対応を書くdevcontainer-のときだけ");
    expect(slug("`codex-workspace` の依存")).toBe("codex-workspace-の依存");
  });
});
