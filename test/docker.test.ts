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

  it("ベースのイメージは版を固定し、実行は engines を満たす Node、ビルドは packageManager と同じ pnpm", () => {
    const froms = directive("FROM");
    for (const f of froms) expect(f, f).toMatch(/^[\w./-]+:\d+\.\d+\.\d+[\w.-]*( AS \w[\w-]*)?$/);
    const runtime = froms.at(-1)!;
    const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)?.[1]);
    expect(Number(/^node:(\d+)\./.exec(runtime)?.[1])).toBeGreaterThanOrEqual(min);
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
    // 公開の手順は版を渡して両方の platform を作る
    const publishing = read("docs/publishing.md");
    expect(publishing).toContain("--platform linux/amd64,linux/arm64 --build-arg P3_VERSION=$V");
    expect(publishing).toContain("-t tamuto/p3:$V -t tamuto/p3:latest");
  });

  it("個人設定は /config に置き、イメージの中では利用者 node で動かす。Docker の CLI と buildx・git を入れ、デーモンは入れない", () => {
    expect(directive("ENV")).toContain("XDG_CONFIG_HOME=/config");
    // 登録の無い UID（--user）でも buildx が書けるところ
    expect(directive("ENV")).toContain("DOCKER_CONFIG=/tmp/.docker");
    expect(directive("VOLUME")).toEqual(['["/config"]']);
    expect(directive("USER")).toEqual(["node"]);
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
