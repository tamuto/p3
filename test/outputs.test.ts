import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { apiRoutes } from "../src/server/api/routes.ts";
import { Workspace } from "../src/server/store/workspace.ts";
import { Outputs } from "../src/web/components/Outputs.tsx";
import { outputHref } from "../src/web/lib/outputs.ts";
import { makeProject, newRequest, newTask } from "./helpers.ts";

describe("成果物のリンク", () => {
  it("項目全体が絶対の http(s) URL のときだけリンクにする（前後の空白は判定で除く）", () => {
    expect(outputHref("https://github.com/tamuto/pcube/pull/15")).toBe("https://github.com/tamuto/pcube/pull/15");
    expect(outputHref("  http://example.com/a?b=c#d  ")).toBe("http://example.com/a?b=c#d");
    expect(outputHref("HTTPS://Example.com/x")).toBe("https://example.com/x");
    for (const v of [
      "",
      "docs/design.md",
      "/abs/path/README.md",
      "PR は https://github.com/x/y/pull/1 です", // 文章の中の URL は拾わない
      "https://example.com/a b",
      "https://",
      "http//example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "<a href=\"https://x\">x</a>",
      "[PR](https://example.com)",
    ])
      expect([v, outputHref(v)]).toEqual([v, null]);
  });

  it("表示: URL は別のタブで開くリンク、文章・パス・HTML 風の文字はそのまま文字。重複も並べる", () => {
    const html = renderToStaticMarkup(
      createElement(Outputs, {
        outputs: ["https://github.com/x/y/pull/1", "設計は docs/design.md にまとめた", "docs/design.md", "<b>太字</b>", "javascript:alert(1)", "https://github.com/x/y/pull/1"],
      }),
    );
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    expect(anchors).toHaveLength(2);
    for (const a of anchors) {
      expect(a).toContain('href="https://github.com/x/y/pull/1"');
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(html).toContain("↗ github.com/x/y/pull/1");
    expect(html).toContain("設計は docs/design.md にまとめた");
    expect(html).toContain("&lt;b&gt;太字&lt;/b&gt;");
    expect(html).not.toContain('href="javascript');
    expect((html.match(/<li/g) ?? []).length).toBe(6);
    expect(renderToStaticMarkup(createElement(Outputs, { outputs: [] }))).toBe('<ul class="mt-2 space-y-1"></ul>');
  });
});

describe("成果物の保存（文字列の配列のまま）", () => {
  it("1つの文字列で書かれた既存のファイルも配列として読み、URL と文章の混在は API・ファイルを往復しても変わらない", async () => {
    const p = await makeProject();
    const r = await newRequest(p.ctx, { title: "要望" });
    const t = await newTask(p.ctx, r.id, { title: "タスク" });
    const file = join(p.dataDir, "requests", r.id, "tasks", `${t.id}.md`);
    await writeFile(file, (await readFile(file, "utf8")).replace(/^rev:/m, "outputs: https://example.com/pull/9\nrev:"));
    await p.ctx.ws.reloadAll();
    expect(p.ctx.ws.tasksOf(r.id).get(t.id)!.outputs).toEqual(["https://example.com/pull/9"]);

    const app = apiRoutes(p.ctx);
    const mixed = ["https://example.com/pull/9", "ブランチ req/x を push 済み（PR はこれから）", "docs/x.md", "docs/x.md", " 前後に空白 "];
    const res = await app.request(`/requests/${r.id}/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outputs: mixed, rev: p.ctx.ws.tasksOf(r.id).get(t.id)!.rev }),
    });
    expect(res.status).toBe(200);
    const fresh = new Workspace(p.dataDir);
    await fresh.load();
    expect(fresh.tasksOf(r.id).get(t.id)!.outputs).toEqual(mixed);
  });
});
