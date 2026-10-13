import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

// pnpm lint（oxlint）の設定が、選んだ安全の規則で失敗させること・対象と除外が決めたとおりであることを、実際に動かして確かめる
const root = fileURLToPath(new URL("../", import.meta.url));
const oxlint = join(root, "node_modules", ".bin", "oxlint");
/** pnpm lint の引数（package.json の scripts.lint から取る。ここで書き写さない） */
const lintArgs = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.lint as string).split(/\s+/).slice(1);
const run = (cwd: string, args: string[]) => spawnSync(oxlint, args, { cwd, encoding: "utf8", timeout: 60_000 });

describe("pnpm lint", () => {
  it("採用した規則（Hooks・待たない Promise・Promise の渡し方）の違反で失敗する（型情報も使う）", () => {
    const dir = tempDir("p3-lint-");
    // リポジトリの設定と依存で、tsconfig のある別の場所を検査する（リポジトリの中に違反を置くと pnpm lint が落ちる）
    writeFileSync(join(dir, ".oxlintrc.json"), readFileSync(join(root, ".oxlintrc.json"), "utf8").replace("./node_modules/", `${root}node_modules/`));
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx", module: "ESNext", moduleResolution: "bundler", target: "ES2023", noEmit: true, types: [], skipLibCheck: true, lib: ["ES2023", "DOM"] } }),
    );
    writeFileSync(
      join(dir, "probe.tsx"),
      [
        'import { useEffect, useState } from "react";',
        "async function save(): Promise<void> {}",
        "export function A({ id }: { id: string }) {",
        "  const [n, setN] = useState(0);",
        "  useEffect(() => {",
        "    setN(id.length + n);",
        "  }, [id]);",
        "  if (id) {",
        "    const [x] = useState(0);",
        "    void x;",
        "  }",
        "  save();",
        "  return <button onClick={save}>{n}</button>;",
        "}",
        "",
      ].join("\n"),
    );
    const r = run(dir, ["--type-aware", "-f", "json", "probe.tsx"]);
    expect(r.status, r.stderr).toBe(1);
    const codes = (JSON.parse(r.stdout) as { diagnostics: { code: string; severity: string }[] }).diagnostics.map((d) => d.code).sort();
    expect(codes).toEqual(["react-hooks(exhaustive-deps)", "react-hooks(rules-of-hooks)", "typescript(no-floating-promises)", "typescript(no-misused-promises)"]);
  });

  it("src・scripts・test と設定ファイルを検査し（.mjs も）、生成したルート一覧は除く", () => {
    const r = run(root, ["--debug=files", ...lintArgs.filter((a) => !a.startsWith("-"))]);
    expect(r.status, r.stderr).toBe(0);
    const files = r.stdout.split("\n").filter((l) => /\.(m?[jt]sx?)$/.test(l));
    for (const f of ["src/cli/main.ts", "src/web/routes/__root.tsx", "scripts/demo.ts", "test/lint.test.ts", "test/fixtures/fake-codex.mjs", "vite.config.ts", "vitest.config.ts"]) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain("src/web/routeTree.gen.ts");
    expect(files.filter((f) => /^(bin|dist|node_modules|\.p3-demo)\//.test(f))).toEqual([]);
  });
});
