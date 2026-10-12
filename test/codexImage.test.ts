import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodexImageError, ensureCodexImage, updateCodexImage } from "../src/core/preflight/codexImage.ts";
import { tempDir } from "./helpers.ts";

const FAKE_DOCKER = fileURLToPath(new URL("./fixtures/fake-docker.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));
const DAY = 86_400_000;

/** PATH に置く偽の docker（このテストの node で fake-docker.mjs を動かす）と、その状態・記録のファイル */
function fakeDocker(opts: { createdAgoMs?: number; version?: string; scenario?: string } = {}) {
  const dir = tempDir("p3-docker-");
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_DOCKER}" "$@"\n`);
  chmodSync(docker, 0o755);
  const state = join(dir, "state.json");
  const log = join(dir, "log.jsonl");
  if (opts.createdAgoMs !== undefined) {
    writeFileSync(state, JSON.stringify({ created: new Date(Date.now() - opts.createdAgoMs).toISOString(), version: opts.version ?? "codex-cli 1.0.0" }));
  }
  const env = { FAKE_DOCKER_STATE: state, FAKE_DOCKER_LOG: log, FAKE_DOCKER_SCENARIO: opts.scenario ?? "", FAKE_DOCKER_VERSION: "codex-cli 2.0.0" };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);
  const builds = () => calls().filter((a) => a[0] === "build");
  return { dir, docker, env, calls, builds };
}

/** 偽の docker の環境変数をこのプロセスに置いて動かす（ライブラリは子プロセスに環境を引き継ぐ） */
async function withEnv<T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> {
  const keep = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await f();
  } finally {
    process.env = keep;
  }
}

describe("Codex のイメージ", () => {
  it("いつもの Preflight は、1日以内に作ったイメージを作り直さない（1日より古ければ作り直す）", async () => {
    const fresh = fakeDocker({ createdAgoMs: 60_000 });
    expect(await withEnv(fresh.env, () => ensureCodexImage({ docker: fresh.docker }))).toBe("codex-cli 1.0.0");
    expect(fresh.builds()).toEqual([]);

    const old = fakeDocker({ createdAgoMs: 2 * DAY });
    expect(await withEnv(old.env, () => ensureCodexImage({ docker: old.docker }))).toBe("codex-cli 2.0.0");
    expect(old.builds()).toHaveLength(1);
  });

  it("update は作ったばかりのイメージでも作り直し、Codex を入れる段からやり直させる", async () => {
    const d = fakeDocker({ createdAgoMs: 1000 });
    const progress: string[] = [];
    const r = await withEnv(d.env, () => updateCodexImage({ docker: d.docker, onProgress: (t) => progress.push(t) }));
    expect(r).toMatchObject({ image: "llmcs-codex-workspace:local", version: "codex-cli 2.0.0", previous: "codex-cli 1.0.0" });
    expect(r.createdAt).toBeTruthy();
    expect(d.builds()).toHaveLength(1);
    // 毎回違う CODEX_REFRESH を渡すので、Codex を入れる段はキャッシュを使わない
    expect(d.builds()[0]).toEqual(expect.arrayContaining(["--build-arg", expect.stringMatching(/^CODEX_REFRESH=\d{4}-/)]));
    expect(progress.join("\n")).toContain("作り直しています");
  });

  it("イメージが無ければ、前の版を読みに行かずに作る", async () => {
    const d = fakeDocker();
    const r = await withEnv(d.env, () => updateCodexImage({ docker: d.docker }));
    expect(r).toMatchObject({ version: "codex-cli 2.0.0", previous: null });
    expect(d.calls().filter((a) => a[0] === "run")).toHaveLength(1); // 作った後の版の確認だけ
  });

  it("失敗した段と次にすることを返す", async () => {
    const fail = async (opts: Parameters<typeof fakeDocker>[0], docker?: string) => {
      const d = fakeDocker(opts);
      return withEnv(d.env, () => updateCodexImage({ docker: docker ?? d.docker })).then(
        () => undefined,
        (e: unknown) => e as CodexImageError,
      );
    };
    expect(await fail({}, join(tempDir(), "no-docker"))).toMatchObject({ step: "docker", message: expect.stringContaining("見つかりません") });
    expect(await fail({ scenario: "nodaemon" })).toMatchObject({ step: "daemon", detail: expect.stringContaining("Cannot connect") });
    expect(await fail({ createdAgoMs: 0, scenario: "buildfail" })).toMatchObject({ step: "build", message: expect.stringContaining("ネットワーク") });
    expect(await fail({ createdAgoMs: 0, scenario: "versionfail" })).toMatchObject({ step: "version" });
  });
});

describe("p3 codex update", () => {
  /** 偽の docker だけが見える PATH で、未登録・未認証の個人設定のまま動かす */
  function p3(args: string[], d: ReturnType<typeof fakeDocker>) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: tempDir("p3-nowhere-"),
      encoding: "utf8",
      env: { ...base, ...d.env, PATH: `${d.dir}:/usr/bin:/bin`, XDG_CONFIG_HOME: tempDir("p3-config-") },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it("プロジェクト・認証が無くても動き、--json の stdout は結果だけ", () => {
    const d = fakeDocker({ createdAgoMs: 1000 });
    const r = p3(["codex", "update", "--json"], d);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, version: "codex-cli 2.0.0", previous: "codex-cli 1.0.0" });
    expect(r.err).toContain("作り直しています");
    expect(d.builds()).toHaveLength(1);
  });

  it("表示は入った版と前の版", () => {
    const r = p3(["codex", "update"], fakeDocker({ createdAgoMs: 1000 }));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Codex を更新しました: codex-cli 2.0.0（codex-cli 1.0.0 から）");
  });

  it("個人設定でイメージの自動更新を止めていても、明示の update は作り直す", () => {
    const d = fakeDocker({ createdAgoMs: 1000 });
    const r = spawnSync(process.execPath, [BIN, "codex", "update", "--json"], {
      cwd: tempDir(),
      encoding: "utf8",
      env: { ...process.env, ...d.env, PATH: `${d.dir}:/usr/bin:/bin`, P3_CODEX_ENSURE_IMAGE: "0", XDG_CONFIG_HOME: tempDir() },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(d.builds()).toHaveLength(1);
  });

  it("失敗は終了コード 1 と次にすること", () => {
    const r = p3(["codex", "update", "--json"], fakeDocker({ scenario: "nodaemon" }));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, step: "daemon", error: expect.stringContaining("Docker を起動") });
    const text = p3(["codex", "update"], fakeDocker({ createdAgoMs: 0, scenario: "buildfail" }));
    expect(text.code).toBe(1);
    expect(text.out).toContain("更新できませんでした");
  });

  it("サブコマンドが無ければ使い方", () => {
    const r = p3(["codex"], fakeDocker());
    expect(r.code).toBe(1);
    expect(r.err).toContain("p3 codex update");
  });
});
