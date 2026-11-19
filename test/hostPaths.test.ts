import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";
import { DockerAbortError } from "../packages/tasks/src/core/preflight/docker.ts";
import {
  containerIdCandidates,
  deepestMount,
  parseMountinfo,
  resolveHostPaths,
  systemProbe,
  type HostPathProbe,
  type InspectedContainer,
} from "../packages/tasks/src/core/preflight/hostPaths.ts";

const ID = "a95d4275f95622266b6a45190d6bafc4c99db8843605f1de17a397313f3dedfe";
const OTHER = "b".repeat(64);

/** mountinfo の1行（id 親 major:minor root 場所 オプション - 種類 元 オプション） */
const line = (n: number, root: string, at: string, type = "ext4", src = "/dev/sdd") => `${n} 1 8:48 ${root} ${at} rw,relatime - ${type} ${src} rw`;

/** DevContainer（ホスト名 denv。コンテナの名前とも ID とも違う）の mountinfo */
const MOUNTINFO = [
  line(1, "/", "/", "overlay", "overlay"),
  line(2, "/", "/proc", "proc", "proc"),
  line(3, "/root/workspaces", "/workspaces"),
  line(4, "/", "/mnt/assets", "nfs", "192.168.3.5:/mnt/usb/assets"),
  line(5, "/var/lib/docker/volumes/serena/_data", "/root/.serena"),
  line(6, "/var/lib/docker/volumes/cache/_data", "/workspaces/app/node_modules"),
  line(7, "/", "/workspaces/app/tmp", "tmpfs", "tmpfs"),
  line(8, "/root/my\\040work", "/my\\040work"),
  line(9, `/var/lib/docker/containers/${ID}/hostname`, "/etc/hostname"),
  line(10, `/var/lib/docker/containers/${ID}/hosts`, "/etc/hosts"),
  line(11, `/var/lib/docker/containers/${ID}/resolv.conf`, "/etc/resolv.conf"),
].join("\n");

const INSPECT: InspectedContainer = {
  Id: ID,
  Config: { Hostname: "denv" },
  Mounts: [
    { Type: "bind", Source: "/root/workspaces", Destination: "/workspaces" },
    { Type: "bind", Source: "/mnt/usb/assets", Destination: "/mnt/assets" },
    { Type: "volume", Source: "/var/lib/docker/volumes/serena/_data", Destination: "/root/.serena" },
    { Type: "volume", Source: "/var/lib/docker/volumes/cache/_data", Destination: "/workspaces/app/node_modules" },
    { Type: "bind", Source: "/root/my work", Destination: "/my work" },
  ],
};

function probe(over: Partial<HostPathProbe> & { containers?: InspectedContainer[]; links?: Record<string, string> } = {}): HostPathProbe & { asked: string[] } {
  const asked: string[] = [];
  const containers = over.containers ?? [INSPECT];
  return {
    asked,
    mountinfo: () => MOUNTINFO,
    cgroup: () => "0::/\n",
    dockerenv: () => true,
    hostname: () => "denv",
    realpath: (p) => {
      for (const [from, to] of Object.entries(over.links ?? {})) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
      return p;
    },
    inspect: async (id) => {
      asked.push(id);
      return containers.find((c) => c.Id === id) ?? null;
    },
    ...over,
  };
}

const hosts = (r: Awaited<ReturnType<typeof resolveHostPaths>>) => r.paths.map((p) => (p.ok ? `${p.origin}:${p.host}` : `stop:${p.reason}`));

describe("マウントするパスを Docker のホストのパスに決める（自分のコンテナのマウントから）", () => {
  it("ホスト名がコンテナの名前と違っても mountinfo の ID を docker inspect で確かめ、別々の bind の下の参照先とデータを求める", async () => {
    const p = probe();
    const r = await resolveHostPaths(["/workspaces/app", "/mnt/assets/p3/data"], { pathMap: [], probe: p });
    expect(r.ok).toBe(true);
    expect(r.environment).toEqual({ kind: "container", containerId: ID });
    expect(hosts(r)).toEqual(["auto:/root/workspaces/app", "auto:/mnt/usb/assets/p3/data"]);
    expect(r.paths[0]).toMatchObject({ destination: "/workspaces" });
    expect(p.asked).toEqual([ID]);
  });

  it("手で書いた対応は前から順の境界一致で自動より先に使い、当たらない対象だけ自動で補う", async () => {
    const r = await resolveHostPaths(["/workspaces/app", "/mnt/assets/p3"], {
      pathMap: [
        ["/work", "/nope"], // 境界が合わない（/workspaces には当たらない）
        ["/workspaces", "/root/workspaces"],
        ["/workspaces/app", "/never"], // 前の対応が先に当たる
      ],
      probe: probe(),
    });
    expect(hosts(r)).toEqual(["manual:/root/workspaces/app", "auto:/mnt/usb/assets/p3"]);
    expect(r.paths[0]).toMatchObject({ rule: ["/workspaces", "/root/workspaces"], verified: true });
  });

  it("手で書いた対応が自分のコンテナのマウントと食い違えば、上書きせず止める", async () => {
    const r = await resolveHostPaths(["/workspaces/app"], { pathMap: [["/workspaces", "/home/me/workspaces"]], probe: probe() });
    expect(r.ok).toBe(false);
    expect(r.paths[0]).toMatchObject({ ok: false, reason: "conflict" });
    expect((r.paths[0] as { next: string }).next).toContain("codex.pathMap-=");
  });

  it("入れ子の volume・tmpfs・コンテナの層・bind でないマウントは止め、親の bind や元のパスに戻らない", async () => {
    const r = await resolveHostPaths(["/workspaces/app/node_modules/x", "/workspaces/app/tmp/in", "/tmp/render", "/root/.serena", "/workspaces/app/src"], {
      pathMap: [],
      probe: probe(),
    });
    expect(hosts(r)).toEqual(["stop:not-bind", "stop:not-bind", "stop:container-layer", "stop:not-bind", "auto:/root/workspaces/app/src"]);
    expect(r.ok).toBe(false);
    for (const p of r.paths.slice(0, 4)) {
      expect(p.ok).toBe(false);
      expect((p as { next: string }).next).toMatch(/bind/);
    }
  });

  it("自分の ID が分からない・接続先に無い・候補が複数・ホスト名が合わない・inspect の失敗は止める（手で書いた対応が当たる対象はそれで進める）", async () => {
    const cases: [string, HostPathProbe, string][] = [
      ["self-unknown", probe({ mountinfo: () => line(1, "/", "/", "overlay"), dockerenv: () => true }), "self-unknown"],
      ["self-not-found", probe({ containers: [] }), "self-not-found"],
      [
        "self-ambiguous",
        probe({
          mountinfo: () => `${MOUNTINFO}\n${line(12, `/var/lib/docker/containers/${OTHER}/hosts`, "/etc/hosts")}`,
          containers: [INSPECT, { ...INSPECT, Id: OTHER }],
        }),
        "self-ambiguous",
      ],
      ["self-mismatch", probe({ hostname: () => "other" }), "self-mismatch"],
      [
        "inspect-failed",
        probe({
          inspect: async () => {
            throw new Error("Cannot connect to the Docker daemon");
          },
        }),
        "inspect-failed",
      ],
    ];
    for (const [name, p, reason] of cases) {
      const r = await resolveHostPaths(["/workspaces/app", "/mnt/assets/p3"], { pathMap: [["/mnt/assets", "/mnt/usb/assets"]], probe: p });
      expect(r.environment, name).toMatchObject({ kind: "container-unknown", reason });
      expect(r.paths[0], name).toMatchObject({ ok: false, reason });
      expect(r.paths[1], name).toMatchObject({ ok: true, origin: "manual", host: "/mnt/usb/assets/p3", verified: false });
      expect(r.ok, name).toBe(false);
    }
  });

  it("候補が複数でも、接続先のデーモンにあるのが1つならそれに決める（候補の先頭を選ぶのではない）", async () => {
    const p = probe({ mountinfo: () => `${line(12, `/var/lib/docker/containers/${OTHER}/hosts`, "/etc/hosts")}\n${MOUNTINFO}` });
    const r = await resolveHostPaths(["/workspaces/app"], { pathMap: [], probe: p });
    expect(r.environment).toEqual({ kind: "container", containerId: ID });
    expect(p.asked).toEqual([OTHER, ID]);
  });

  it("コンテナの外（ID の候補も /.dockerenv も無い）なら Docker に聞かずに変換しない。手で書いた対応は今までどおり当てる", async () => {
    const p = probe({ mountinfo: () => line(1, "/", "/", "ext4"), cgroup: () => "0::/user.slice\n", dockerenv: () => false });
    const r = await resolveHostPaths(["/home/me/app", "/srv/data"], { pathMap: [["/srv", "/mnt/srv"]], probe: p });
    expect(r.ok).toBe(true);
    expect(r.environment).toEqual({ kind: "direct" });
    expect(hosts(r)).toEqual(["direct:/home/me/app", "manual:/mnt/srv/data"]);
    expect(p.asked).toEqual([]);
  });

  it("ルートの境界・似た前置き・空白・mountinfo のエスケープ・シンボリックリンクを区別する", async () => {
    const p = probe({ links: { "/workspaces/link": "/mnt/assets/real" } });
    const r = await resolveHostPaths(["/workspaces", "/workspaces2/app", "/my work/repo", "/workspaces/link/sub"], { pathMap: [], probe: p });
    expect(hosts(r)).toEqual(["auto:/root/workspaces", "stop:container-layer", "auto:/root/my work/repo", "auto:/mnt/usb/assets/real/sub"]);
  });

  it("cgroup v1 の docker の行も ID の候補にする。/etc/hostname 以外のマウントの ID は候補にしない", () => {
    expect(containerIdCandidates(line(1, `/var/lib/docker/containers/${OTHER}/data`, "/data"), `12:memory:/docker/${ID}\n`)).toEqual([ID]);
    expect(containerIdCandidates(line(1, `/var/lib/containers/storage/overlay-containers/${ID}/userdata/hostname`, "/etc/hostname"), null)).toEqual([ID]);
  });

  it("一番深いマウントを選び、同じ場所に重なっていれば後のもの", () => {
    const mounts = parseMountinfo([line(1, "/", "/"), line(2, "/a", "/w"), line(3, "/b", "/w", "tmpfs"), line(4, "/c", "/w/x")].join("\n"));
    expect(deepestMount(mounts, "/w/y")?.fsType).toBe("tmpfs");
    expect(deepestMount(mounts, "/w/x/z")?.root).toBe("/c");
    expect(deepestMount(mounts, "/wx")?.mountPoint).toBe("/");
  });
});

describe("docker inspect の問い合わせ（実際の CLI の形）", () => {
  /** 呼ばれた引数を残し、指定どおりに振る舞う偽の docker */
  function fakeDocker(body: string) {
    const dir = tempDir("p3-hostpaths-docker-");
    const log = join(dir, "calls");
    const bin = join(dir, "docker");
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\n${body}\n`);
    chmodSync(bin, 0o755);
    return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n") };
  }

  it("inspect だけを配列の引数で呼び、マウントするコマンドは出さない。無いコンテナは null", async () => {
    const d = fakeDocker(`case "$*" in *${ID}*) echo '${JSON.stringify(INSPECT)}';; *) echo "Error: No such container: $5" >&2; exit 1;; esac`);
    const sys = systemProbe(d.bin, 5_000);
    expect(await sys.inspect(ID)).toMatchObject({ Id: ID, Config: { Hostname: "denv" } });
    expect(await sys.inspect(OTHER)).toBeNull();
    expect(d.calls()).toEqual([`inspect --type container --format {{json .}} ${ID}`, `inspect --type container --format {{json .}} ${OTHER}`]);
  });

  it("時間切れは有限の時間で inspect-failed になり、取消は投げる", async () => {
    const d = fakeDocker("exec sleep 30");
    const p = probe({ inspect: systemProbe(d.bin, 300).inspect });
    const t = Date.now();
    const r = await resolveHostPaths(["/workspaces/app"], { pathMap: [], probe: p });
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(r.paths[0]).toMatchObject({ ok: false, reason: "inspect-failed" });
    expect((r.paths[0] as { detail: string }).detail).toContain("秒で終わらない");

    const ac = new AbortController();
    const q = probe({ inspect: systemProbe(d.bin, 30_000).inspect });
    setTimeout(() => ac.abort(), 200);
    await expect(resolveHostPaths(["/workspaces/app"], { pathMap: [], probe: q, signal: ac.signal })).rejects.toBeInstanceOf(DockerAbortError);
    expect(d.calls().every((c) => c.startsWith("inspect "))).toBe(true);
  });

  it("docker が無ければ inspect-failed（docker コマンドがありません）", async () => {
    const p = probe({ inspect: systemProbe(join(tempDir("p3-hostpaths-none-"), "docker")).inspect });
    const r = await resolveHostPaths(["/workspaces/app"], { pathMap: [], probe: p });
    expect(r.paths[0]).toMatchObject({ ok: false, reason: "inspect-failed" });
    expect((r.paths[0] as { detail: string }).detail).toContain("docker コマンドがありません");
  });

  it("実際の realpath は、無いところは在るところまで辿って残りを足す", () => {
    const root = tempDir("p3-hostpaths-real-");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const sys = systemProbe();
    expect(sys.realpath(join(root, "link", "a", "b"))).toBe(join(root, "real", "a", "b"));
    expect(sys.realpath(join(root, "link"))).toBe(join(root, "real"));
  });
});
