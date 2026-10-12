import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { evidenceLines, scopeLines } from "../src/shared/scopeView.ts";
import { PreflightScope } from "../src/web/components/PreflightScope.tsx";

const scope = [
  { name: "allesc", mount: "allesc", role: "本体", readFirst: true, status: "ok" as const },
  { name: "infra", mount: "infra", role: "基盤", readFirst: false, status: "unregistered" as const, reason: "このマシンのパスが登録されていません（p3 repo path infra <パス>）" },
];
const evidence = [
  { claim: "入口は main.ts", kind: "verified" as const, repo: "allesc", file: "src/main.ts", location: "L10" },
  { claim: "基盤は変えなくてよいはず", kind: "assumed" as const, repo: "infra", file: "x.tf", note: "参照先 infra はこの評価で見ていません" },
];

describe("調べた範囲と根拠の見せ方", () => {
  it("CLI: 読んだ・見ていない・確かめた・推測・以前の評価（記録なし）を分ける", () => {
    expect(scopeLines(scope)).toEqual([
      "調べた範囲:",
      "  ✓ allesc（本体）  /workspace/allesc",
      "  ✕ infra（基盤）  このマシンのパスが登録されていません（p3 repo path infra <パス>）",
    ]);
    expect(scopeLines(undefined)).toEqual(["調べた範囲: 記録なし（以前の評価）"]);
    expect(evidenceLines(evidence)).toEqual([
      "判断の根拠:",
      "  確かめた  allesc:src/main.ts L10 — 入口は main.ts",
      "  推測      基盤は変えなくてよいはず（infra:x.tf）  ※参照先 infra はこの評価で見ていません",
    ]);
    expect(evidenceLines(undefined)).toEqual(["判断の根拠: 記録なし（以前の評価）"]);
    expect(evidenceLines([])).toEqual(["判断の根拠: なし"]);
  });

  it("画面: 見ていない参照先は登録の仕方を出し、地図は今の設定から。以前の評価は記録なし", () => {
    const repos = [{ name: "allesc", role: "本体", readFirst: true, writable: true, map: [{ path: "src/server", role: "API", entry: "src/server/main.ts" }] }];
    const html = renderToStaticMarkup(createElement(PreflightScope, { scope, repos, evidence }));
    expect(html).toContain("見ていない（このマシンのパスが未登録）");
    expect(html.match(/p3 repo path infra &lt;パス&gt;/g)).toHaveLength(1);
    expect(html).toContain("コードの地図（今の設定）");
    expect(html).toContain("src/server/main.ts");
    expect(html).toContain("確かめた");
    expect(html).toContain("※ 参照先 infra はこの評価で見ていません");
    const old = renderToStaticMarkup(createElement(PreflightScope, { repos: [], evidence: undefined }));
    expect(old.match(/記録なし（以前の評価）/g)).toHaveLength(2);
  });
});
