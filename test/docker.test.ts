import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Docker のイメージの約束（Dockerfile・.dockerignore）。実際にビルドして動かすのは scripts/verify-docker.mjs */
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const dockerfile = read("Dockerfile");
const pkg = JSON.parse(read("package.json")) as { packageManager: string; engines: { node: string } };
const lines = dockerfile.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
const directive = (name: string) => lines.filter((l) => l.startsWith(`${name} `)).map((l) => l.slice(name.length + 1).trim());

describe("Dockerfile", () => {
  it("既定はプロジェクトを跨ぐ serve で、コマンドを明示すれば置き換わる（exec の形で、SIGTERM を node が受ける）", () => {
    expect(directive("ENTRYPOINT")).toEqual(['["p3"]']);
    expect(directive("CMD")).toEqual(['["serve", "--all-projects", "--host", "0.0.0.0"]']);
    expect(directive("EXPOSE")).toEqual(["4310"]);
  });

  it("Node はメジャー版に追従し（同じメジャーの更新は作り直すと入る）、ほかのベースは版を固定する。実行は engines を満たす Node、ビルドは packageManager と同じ pnpm", () => {
    const froms = directive("FROM");
    const nodes = froms.filter((f) => f.startsWith("node:"));
    // ビルドは Node 24、実行は Node 22。どちらも bookworm-slim で、マイナー・パッチは書かない（書くとセキュリティリリースが入らない）
    expect(nodes).toEqual(["node:24-bookworm-slim AS build", "node:22-bookworm-slim"]);
    for (const f of froms.filter((x) => !x.startsWith("node:"))) expect(f, f).toMatch(/^[\w./-]+:\d+\.\d+\.\d+[\w.-]*( AS \w[\w-]*)?$/);
    expect(froms.find((f) => f.startsWith("docker:"))).toMatch(/^docker:\d+\.\d+\.\d+-cli AS docker-cli$/);
    const runtime = froms.at(-1)!;
    const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)?.[1]);
    expect(Number(/^node:(\d+)-/.exec(runtime)?.[1])).toBeGreaterThanOrEqual(min);
    expect(dockerfile).toContain(`npm install -g ${pkg.packageManager}`);
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("pnpm install --prod --frozen-lockfile");
  });

  it("Docker Hub の tamuto/p3 として、版と出どころのラベル・ヘルスチェックを持つ", () => {
    expect(dockerfile).toContain("ARG P3_VERSION=dev");
    expect(dockerfile).toContain('org.opencontainers.image.version="${P3_VERSION}"');
    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/tamuto/p3"');
    expect(dockerfile).toContain('org.opencontainers.image.licenses="MIT"');
    expect(dockerfile).toMatch(/HEALTHCHECK [^\n]*\\\n[^\n]*\/api\/mode/);
    // 公開の手順は版を渡して amd64 だけを作る（arm64 は確かめるマシンが無いので対応しない）
    const publishing = read("docs/publishing.md");
    expect(publishing).toContain("docker buildx build --pull --platform linux/amd64 --build-arg P3_VERSION=$V");
    expect(/--platform (\S+)/.exec(publishing)?.[1]).toBe("linux/amd64");
    expect(publishing).toContain("-t tamuto/p3:$V -t tamuto/p3:latest");
  });

  it("root で動かし、個人設定の場所を変えない（開発コンテナと同じマウントで共有できる）。Docker の CLI と buildx・git を入れ、デーモンは入れない", () => {
    expect(directive("USER")).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/XDG_CONFIG_HOME|DOCKER_CONFIG|^VOLUME/m);
    expect(directive("WORKDIR").at(-1)).toBe("/root");
    expect(dockerfile).toContain("/usr/local/bin/docker /usr/local/bin/docker");
    expect(dockerfile).toContain("cli-plugins/docker-buildx");
    expect(dockerfile).not.toMatch(/dockerd|docker\.io|docker-ce\b/);
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bgit\b/);
  });

  it(".dockerignore で、git・依存・ビルドの出力・データ・個人設定・認証・開発用のものを入れない", () => {
    const ignored = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const p of [".git", "node_modules", "dist", ".p3", ".p3-demo", ".env", ".env.*", "**/auth.json", "**/chatgpt.json", "**/config.yaml", ".claude", ".serena", "test"]) {
      expect(ignored, p).toContain(p);
    }
    // 配る中身（package.json の files）に要るものは除かない
    for (const p of ["src", "bin", "skills", "docs", "pnpm-lock.yaml"]) expect(ignored).not.toContain(p);
  });
});
