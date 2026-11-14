import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chatgptAccount } from "../src/core/chatgpt.ts";
import { CodexWorkspaceEngine, type HostMount } from "../src/core/preflight/codexEngine.ts";
import type { HostPathProbe, InspectedContainer } from "../src/core/preflight/hostPaths.ts";
import { RenderError, renderHtml } from "../src/core/preflight/render.ts";
import type { ResolvedRef } from "../src/core/repoRefs.ts";
import { makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

const ID = "c".repeat(64);
const FAKE_RUN = fileURLToPath(new URL("./fixtures/fake-docker-run.mjs", import.meta.url));
const FAKE_RENDER = fileURLToPath(new URL("./fixtures/fake-render-docker.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/p3.mjs", import.meta.url));

const line = (n: number, root: string, at: string, type = "ext4") => `${n} 1 8:48 ${root} ${at} rw - ${type} /dev/sdd rw`;

/**
 * DevContainer の中（ホスト名 dev。コンテナの名前とは別）として振る舞う probe。binds はこのマシンのパス → ホストのパス、
 * volumes はこのマシンのパス（volume）
 */
function devcontainer(binds: Record<string, string>, volumes: string[] = []): HostPathProbe {
  const entries = [...Object.entries(binds).map(([d, s]) => ({ Type: "bind", Source: s, Destination: d })), ...volumes.map((d) => ({ Type: "volume", Source: `/var/lib/docker/volumes/x/_data`, Destination: d }))];
  const mountinfo = [
    line(1, "/", "/", "overlay"),
    ...entries.map((m, i) => line(i + 2, m.Source, m.Destination)),
    line(90, `/var/lib/docker/containers/${ID}/hostname`, "/etc/hostname"),
  ].join("\n");
  const inspected: InspectedContainer = { Id: ID, Config: { Hostname: "dev" }, Mounts: entries };
  return {
    mountinfo: () => mountinfo,
    cgroup: () => null,
    dockerenv: () => true,
    hostname: () => "dev",
    realpath: (p) => p,
    inspect: async (id) => (id === ID ? inspected : null),
  };
}

/** 偽の app-server（すぐ終わる）。command に渡ったマウントを記録する */
function engine(probe: HostPathProbe, pathMap: [string, string][] = []) {
  const seen: { repos: HostMount[]; data: string | null }[] = [];
  const codex = new CodexWorkspaceEngine({
    authVolume: "vol",
    account: chatgptAccount(join(tempDir(), "none.json")),
    pathMap,
    ensureImage: false,
    hostProbe: probe,
    command: (m) => {
      seen.push({ repos: m.repos, data: m.data });
      return [process.execPath, FAKE_RUN, "unknown"];
    },
  });
  return { codex, seen };
}

async function preflight(codex: CodexWorkspaceEngine, dataDir: string) {
  const ctx = await openTestProject(dataDir, { codex });
  const req = await newRequest(ctx, { title: "x", status: "draft" });
  const { id } = await ctx.preflight.start(req.id);
  const run = (await ctx.preflight.wait(req.id, id))!;
  const saved = readFileSync(join(ctx.ws.preflight.runDir(req.id, id), "run.json"), "utf8");
  return { run, saved, log: run.log.map((l) => `${l.kind}: ${l.text}`).join("\n") };
}

describe("Preflight と ask のマウントに自動で決めたパスを使う", () => {
  it("pathMap 無しの DevContainer で、全部の参照先とデータを別々の bind から決め、共有の記録には由来だけを残す", async () => {
    const repo = await makeRepo();
    const probe = devcontainer({ [repo.root]: `/HOSTA${repo.root}`, [repo.dataDir]: `/HOSTB${repo.dataDir}` });
    const { codex, seen } = engine(probe);
    const { saved, log } = await preflight(codex, repo.dataDir);
    expect(seen).toEqual([{ repos: [{ name: "main", host: `/HOSTA${repo.root}`, container: "/workspace/main" }], data: `/HOSTB${repo.dataDir}` }]);
    expect(log).toContain("参照先 main → コンテナ /workspace/main（自動（p3 が動いているコンテナのマウントから））");
    expect(log).toContain("データ → コンテナ /data（自動（p3 が動いているコンテナのマウントから））");
    for (const secret of [repo.root, "/HOSTA", "/HOSTB", ID, ID.slice(0, 12)]) {
      expect(saved).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
  });

  it("1つでも決まらなければ Codex のコンテナを起こさず、理由と次にすること・確かめ方を残す（パスは残さない）", async () => {
    const repo = await makeRepo();
    // データだけ volume の下
    const { codex, seen } = engine(devcontainer({ [repo.root]: `/HOSTA${repo.root}` }, [repo.dataDir]));
    const { run, saved, log } = await preflight(codex, repo.dataDir);
    expect(seen).toEqual([]);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Preflightでマウントするフォルダが Docker のホストのどこにあるか決められないので、コンテナを起こしません");
    expect(run.error).toContain("データ: このフォルダはホストのフォルダではないマウント（volume）の下にあります");
    expect(run.error).toContain("次にすること: このフォルダを、ホストのフォルダをマウント（bind）した場所の下へ移してください");
    expect(run.error).toContain("確かめる: このマシンで p3 user-config paths <このマシンのパス>");
    expect(run.error).not.toContain("参照先 main:"); // 決まったものは理由に出さない
    for (const secret of [repo.root, "/HOSTA", ID]) {
      expect(saved).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
  });

  it("手で書いた対応がコンテナのマウントと食い違えば、起こさずに直すか外すよう案内する", async () => {
    const repo = await makeRepo();
    const { codex, seen } = engine(devcontainer({ [repo.root]: `/HOSTA${repo.root}` }), [[repo.root, "/somewhere/else"]]);
    const { run } = await preflight(codex, repo.dataDir);
    expect(seen).toEqual([]);
    expect(run.error).toContain("手で書いた対応（codex.pathMap）と、p3 が自分のコンテナのマウントから求めたホストのパスが違います");
    expect(run.error).toContain("codex.pathMap-=");
  });

  it("参照先を読む ask も同じ決め方で、決まらなければ起こさない", async () => {
    const root = tempDir();
    const ref = { name: "app", status: "ok", local: root, mount: "app" } as unknown as ResolvedRef;
    const ok = engine(devcontainer({ [root]: `/HOSTA${root}` }));
    await ok.codex.ask({ instructions: "i", prompt: "p", label: "レビュー", refs: [ref] }, () => {}, new AbortController().signal).catch(() => undefined);
    expect(ok.seen).toEqual([{ repos: [{ name: "app", host: `/HOSTA${root}`, container: "/workspace/app" }], data: null }]);

    const ng = engine(devcontainer({}, [root]));
    await expect(ng.codex.ask({ instructions: "i", prompt: "p", label: "レビュー", refs: [ref] }, () => {}, new AbortController().signal)).rejects.toThrow(
      /レビューでマウントするフォルダが Docker のホストのどこにあるか決められない/,
    );
    expect(ng.seen).toEqual([]);
  });
});

describe("描画のマウントに自動で決めたパスを使う", () => {
  function fakeDocker() {
    const dir = tempDir();
    const log = join(dir, "docker.log");
    const docker = join(dir, "docker");
    writeFileSync(docker, `#!/bin/sh\nFAKE_DOCKER_LOG=${log} exec "${process.execPath}" "${FAKE_RENDER}" "$@"\n`);
    chmodSync(docker, 0o755);
    const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
    return { docker, calls };
  }
  const job = { id: "U1", html: "<p>a</p>", width: 800 };

  it("実際にマウントする一時の in / out を自分のコンテナの bind から決めて描く", async () => {
    const { docker, calls } = fakeDocker();
    const work = tempDir();
    const [r] = await renderHtml([job], work, join(work, "out"), { docker, image: "img", hostProbe: devcontainer({ [work]: `/HOST${work}` }) });
    expect(r).toMatchObject({ id: "U1", ok: true });
    const run = calls().find((c) => c[0] === "run")!;
    expect(run.find((a) => a.includes("dst=/in"))).toMatch(new RegExp(`^type=bind,src=/HOST${work}/\\.render-[0-9a-f]+/in,dst=/in,readonly$`));
    expect(run.find((a) => a.includes("dst=/out,") || a.endsWith("dst=/out"))).toMatch(new RegExp(`^type=bind,src=/HOST${work}/\\.render-[0-9a-f]+/out,dst=/out$`));
  });

  it("決まらなければ描画のコンテナを起こさず RenderError（paths）", async () => {
    const { docker, calls } = fakeDocker();
    const work = tempDir();
    const e = await renderHtml([job], work, join(work, "out"), { docker, image: "img", hostProbe: devcontainer({}, [work]) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e).toMatchObject({ step: "paths" });
    expect((e as Error).message).toContain("描画の原稿: このフォルダはホストのフォルダではないマウント（volume）の下にあります");
    expect((e as Error).message).not.toContain(work);
    expect(calls().filter((c) => c[0] === "run")).toEqual([]);
    // 一時のフォルダは片付ける
    expect(readdirSync(work).filter((f) => f.startsWith(".render-"))).toEqual([]);
  });
});

describe("p3 user-config paths（このマシンで確かめる）", () => {
  function p3(args: string[], env: Record<string, string>) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("P3_")));
    return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...base, ...env } });
  }
  function snapshot(dir: string) {
    const files: Record<string, string> = {};
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else files[relative(dir, f)] = `${statSync(f).mtimeMs}:${readFileSync(f, "utf8")}`;
      }
    };
    walk(dir);
    return files;
  }

  it("対象ごとの行き先と決め方を出し、個人設定とデータは変えず、Docker は呼ばない（コンテナの外）", () => {
    const config = tempDir();
    mkdirSync(join(config, "infodb-p3"));
    writeFileSync(join(config, "infodb-p3", "config.yaml"), "codex:\n  pathMap:\n    /srv: /mnt/srv\n");
    const repo = tempDir();
    const bin = tempDir();
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho called >> "${bin}/called"\nexit 1\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const before = { config: snapshot(config), repo: snapshot(repo) };
    const env = { XDG_CONFIG_HOME: config, P3_HOST_PATHS: "direct", PATH: `${bin}:${process.env.PATH ?? ""}` };
    const text = p3(["user-config", "paths", repo, "/srv/data"], env);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("p3 が動いている場所: コンテナの外");
    expect(text.stdout).toContain(`${repo}\n  → ${repo}  codex.pathMap の対応なし`);
    expect(text.stdout).toContain("/srv/data\n  → /mnt/srv/data  codex.pathMap の対応あり");
    const json = JSON.parse(p3(["user-config", "paths", "/srv/data", "--json"], env).stdout);
    expect(json).toMatchObject({ ok: true, environment: { kind: "direct" }, paths: [{ ok: true, local: "/srv/data", host: "/mnt/srv/data", origin: "manual" }] });
    expect({ config: snapshot(config), repo: snapshot(repo) }).toEqual(before);
    expect(existsSync(join(bin, "called"))).toBe(false);
    expect(p3(["user-config", "paths"], env).status).toBe(1);
  });
});
