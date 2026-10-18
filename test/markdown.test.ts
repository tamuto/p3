import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProposedTask } from "../src/shared/types.ts";
import { Markdown } from "../src/web/components/Markdown.tsx";
import { DraftDetail } from "../src/web/components/request/DraftDetail.tsx";
import { markdownHref, selectedDraft } from "../src/web/lib/markdown.ts";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
/** 要素を除いた文字だけ（描画された文が読めるか） */
const textOf = (h: string) => h.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

describe("読むだけの Markdown（タスク案の本文）", () => {
  it("見出し・入れ子の箇条書き・番号付き・強調・コード・引用・区切り線を要素として描く", () => {
    const h = html(
      [
        "## 作業内容",
        "",
        "カードから **全文** を開く。対象は `src/web/x.tsx`。",
        "",
        "1. 詳細ビューを作る",
        "   - 採否を保つ",
        "   - 本文の形式を保つ",
        "2. 文書を直す",
        "",
        "```bash",
        "pnpm vitest run",
        "pnpm check",
        "```",
        "",
        "> 引用",
        "",
        "---",
      ].join("\n"),
    );
    expect(h).toMatch(/<h3[^>]*>作業内容<\/h3>/);
    expect(h).toMatch(/<strong[^>]*>全文<\/strong>/);
    expect(h).toMatch(/<code[^>]*>src\/web\/x\.tsx<\/code>/);
    expect(h.replace(/\n/g, "")).toMatch(/<ol[^>]*><li>詳細ビューを作る<ul[^>]*><li>採否を保つ<\/li><li>本文の形式を保つ<\/li><\/ul><\/li><li>文書を直す<\/li><\/ol>/);
    expect(h).toMatch(/<pre[^>]*><code[^>]*>pnpm vitest run\npnpm check\n<\/code><\/pre>/);
    expect(h).toMatch(/<blockquote[^>]*>\s*<p[^>]*>引用<\/p>\s*<\/blockquote>/);
    expect(h).toContain("<hr");
    expect(h).not.toContain("##");
    expect(h).not.toContain("**");
  });

  it("GFM の表とチェックリスト（読むだけ）を描く", () => {
    const h = html(["| 確認 | 期待 |", "| --- | --- |", "| 見出し | 区別できる |", "", "- [x] 済み", "- [ ] まだ"].join("\n"));
    expect(h.replace(/\n/g, "")).toMatch(/<table[^>]*><thead><tr><th[^>]*>確認<\/th><th[^>]*>期待<\/th><\/tr><\/thead><tbody><tr><td[^>]*>見出し<\/td><td[^>]*>区別できる<\/td><\/tr><\/tbody><\/table>/);
    const boxes = h.match(/<input[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b).toContain('type="checkbox"');
      expect(b).toContain("disabled");
    }
    expect(boxes[0]).toContain("checked");
    expect(boxes[1]).not.toContain("checked");
  });

  it("生の HTML は要素にせず、書かれたとおりの文字で見せる", () => {
    const h = html('前<script>alert(1)</script>後\n\n<div onclick="x()">箱</div>\n\n<img src="https://example.com/a.png" onerror="x()">');
    expect(h).not.toMatch(/<script|<div onclick|<img/);
    expect(textOf(h)).toContain("<script>alert(1)</script>");
    expect(textOf(h)).toContain('<div onclick="x()">箱</div>');
  });

  it("リンクは絶対の http(s) URL だけ（別のタブ・noopener noreferrer）。ほかは文字で出す。画像は取らずに代替テキスト", () => {
    const h = html(
      [
        "[公式](https://example.com/docs)",
        "[js](javascript:alert(1))",
        "[data](data:text/html,x)",
        "[file](file:///etc/passwd)",
        "[相対](docs/design.md)",
        "[アンカー](#top)",
        "![画面](https://example.com/shot.png)",
      ].join("\n\n"),
    );
    const links = h.match(/<a [^>]*>/g) ?? [];
    expect(links).toEqual(['<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer" class="break-all text-indigo-600 underline dark:text-indigo-400">']);
    expect(h).not.toMatch(/href="(javascript|data|file):|href="docs\/|href="#top"/);
    expect(h).toContain('<span title="javascript:alert(1)">js</span>'); // 元の値は文字（title）で見せるだけ
    for (const label of ["js", "data", "file", "相対", "アンカー"]) expect(textOf(h)).toContain(label);
    expect(h).not.toContain("<img");
    expect(textOf(h)).toContain("画像: 画面");
    expect(markdownHref(" https://example.com ")).toBe("https://example.com/");
    expect(markdownHref("javascript:alert(1)")).toBeNull();
  });
});

const draft = (p: Partial<ProposedTask> = {}): ProposedTask =>
  ({ key: "D1", title: "詳細を読めるようにする", description: "## 作業内容\n\n- 全文", include: true, dependsOn: [], supersedes: [], areas: [], repo: null, ...p });

describe("タスク案の詳細（ダイアログ）", () => {
  const render = (d: ProposedTask | null, repos: { name: string; writable?: boolean }[] = []) =>
    renderToStaticMarkup(createElement(DraftDetail, { dialog: { current: null }, draft: d, project: { repos } as never, onClose: () => {} }));

  it("案のキー・題・採否・作業先・依存先・置き換え先・領域と、本文を全文描く。閉じるボタンがある", () => {
    const h = render(
      draft({
        include: false,
        repo: "app",
        dependsOn: ["D1"],
        key: "D2",
        supersedes: ["T004"],
        areas: ["src/web/components/request/very/long/path/Drafts.tsx"],
        description: "## 判断の根拠\n\n- 根拠\n\n## 未確認\n\n- 未確認のこと",
      }),
      [{ name: "app", writable: true }],
    );
    expect(h).toMatch(/<dialog[^>]*aria-labelledby="draft-detail-title"/);
    expect(h).toMatch(/<h2 id="draft-detail-title"[^>]*><span[^>]*>D2<\/span>詳細を読めるようにする<\/h2>/);
    expect(h).toMatch(/<button[^>]*>閉じる<\/button>/);
    expect(textOf(h)).toContain("不採用");
    expect(textOf(h)).toContain("作業先app");
    expect(textOf(h)).toContain("依存先D1");
    expect(textOf(h)).toContain("T004");
    expect(h).toContain("src/web/components/request/very/long/path/Drafts.tsx");
    expect(h).toMatch(/<h3[^>]*>判断の根拠<\/h3>/);
    expect(h).toMatch(/<h3[^>]*>未確認<\/h3>/);
  });

  it("本文が空なら「本文なし」。参照先が無ければ作業先を出さない。案が無ければ中身を描かない", () => {
    const h = render(draft({ description: "  \n" }));
    expect(textOf(h)).toContain("本文なし");
    expect(textOf(h)).not.toContain("作業先");
    expect(textOf(h)).toContain("依存先なし");
    expect(render(null)).not.toContain("閉じる");
  });
});

describe("開いている案の選び方", () => {
  const run = (id: string, drafts: ProposedTask[]) => ({ id, drafts });

  it("run と案のキーの組で選ぶ。run が違う・案が無くなったら閉じる（null）。更新されたら最新を返す", () => {
    const sel = { runId: "PF-1", key: "D1" };
    expect(selectedDraft(null, run("PF-1", [draft()]))).toBeNull();
    expect(selectedDraft(sel, run("PF-1", [draft()]))?.title).toBe("詳細を読めるようにする");
    // 同じキーの別の run の案は取り違えない
    expect(selectedDraft(sel, run("PF-2", [draft({ description: "別の run" })]))).toBeNull();
    expect(selectedDraft(sel, run("PF-1", [draft({ key: "D2" })]))).toBeNull();
    // 外で取り直して題・本文・採否が変わったら、その内容
    expect(selectedDraft(sel, run("PF-1", [draft({ title: "直した題", description: "新しい本文", include: false })]))).toMatchObject({ title: "直した題", description: "新しい本文", include: false });
  });
});
