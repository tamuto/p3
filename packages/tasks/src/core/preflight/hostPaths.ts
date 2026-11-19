import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { DOCKER_LIMITS, DockerAbortError, DockerCommandError, dockerExec } from "./docker.ts";

/**
 * Docker のコンテナにマウントするパス（このマシンのパス）を、Docker のデーモンから見たパスに決める（261115-d0n30）。
 *
 * - p3 がコンテナの外で動いている: そのまま渡す（direct。Docker Desktop・WSL・リモートの Docker でも今までどおり）
 * - p3 がコンテナの中で動いている: 自分のコンテナを確かめ、そのマウント（bind）からホストのパスを求める（auto）
 *   - 自分のコンテナの ID は、このマシンの /proc/self/mountinfo（Docker が /etc/hostname などを置くマウント）から得て、
 *     同じ接続先（DOCKER_HOST・DOCKER_CONTEXT・選んでいる context。docker の CLI にそのまま任せる）の docker inspect で確かめる。
 *     ホスト名だけ・候補の先頭だけでは決めない。見つけたコンテナの bind の Source と、このマシンの mountinfo のマウントの元が
 *     合わなければ自分と扱わない（Compose の network_mode: service:X・--network container:X では /etc/hostname などが共有元 X の
 *     ものになり、X を自分と取り違えて X のホストのパスを選んでしまうため。261120-ezdk4）
 *   - 対象の実体（シンボリックリンクを辿った先）を含む一番深いマウントが bind のときだけ、その Source に残りを足す。
 *     volume・tmpfs・コンテナの層（どのマウントにも当たらない）は、親の bind に逃げずに止める
 * - 個人設定の codex.pathMap（手で書いた対応）は今までどおり前から順の境界一致で、自動より先に使う。自動で求めたものと食い違えば
 *   上書きせず止める。自動で求められない環境でも、手で書いた対応が当たる対象はそれで進める
 *
 * 求めた結果は個人設定に書かない（毎回求める）。確定する前にマウントするコマンドは出さない（ここで動かすのは docker inspect だけ）。
 * 判定の表は docs/architecture.md の「マウントするパスの決め方」。
 */

/** どこから決まったか: 手で書いた対応 / 自分のコンテナのマウント / 変換しない（コンテナの外） */
export type PathOrigin = "manual" | "auto" | "direct";

/** 止める理由 */
export type HostPathReason =
  /** コンテナの中らしいが、自分のコンテナの ID が分からない */
  | "self-unknown"
  /** ID の候補が複数あって、接続先のデーモンでも1つに決まらない */
  | "self-ambiguous"
  /** 接続先のデーモンに自分のコンテナが無い（リモート・別のデーモン） */
  | "self-not-found"
  /** docker inspect の結果が自分と合わない（ホスト名・マウントの元。ネットワークを共有する構成で共有元を自分と取り違えたときなど） */
  | "self-mismatch"
  /** docker inspect が失敗した・時間切れ */
  | "inspect-failed"
  /** 対象が bind ではないマウント（volume・tmpfs など）の下にある */
  | "not-bind"
  /** 対象がどのマウントの下にもない（コンテナの層） */
  | "container-layer"
  /** bind の Source が、このデーモンにそのまま渡せる形（/ で始まる絶対パス）ではない */
  | "unsupported-source"
  /** 手で書いた対応と、自分のコンテナのマウントから求めたものが違う */
  | "conflict";

export type HostPathResult =
  | {
      ok: true;
      local: string;
      host: string;
      origin: PathOrigin;
      /** origin が manual のとき、当たった対応 */
      rule?: [string, string];
      /** manual のとき、自分のコンテナのマウントでも同じだと確かめられたか（求められなかったときは false） */
      verified?: boolean;
      /** auto のとき、当たったマウントのコンテナの中の場所 */
      destination?: string;
    }
  | { ok: false; local: string; reason: HostPathReason; detail: string; next: string };

/** p3 が動いている場所 */
export type HostPathEnvironment =
  | { kind: "direct" }
  | { kind: "container"; containerId: string }
  | { kind: "container-unknown"; reason: HostPathReason; detail: string };

export interface HostPathResolution {
  ok: boolean;
  environment: HostPathEnvironment;
  paths: HostPathResult[];
}

/** docker inspect の結果のうち使うところ */
export interface InspectedContainer {
  Id: string;
  Config?: { Hostname?: string };
  Mounts?: { Type?: string; Source?: string; Destination?: string }[];
}

/** OS と Docker の差し替え口（テストは fixture に置き換える） */
export interface HostPathProbe {
  /** /proc/self/mountinfo の中身（読めなければ null） */
  mountinfo: () => string | null;
  /** /proc/self/cgroup の中身（読めなければ null） */
  cgroup: () => string | null;
  /** /.dockerenv があるか */
  dockerenv: () => boolean;
  hostname: () => string;
  /** シンボリックリンクを辿った実体（無いところは、あるところまで辿って残りを足す） */
  realpath: (p: string) => string;
  /** docker inspect --type container <id>。無ければ null、ほかの失敗は投げる */
  inspect: (id: string, signal?: AbortSignal) => Promise<InspectedContainer | null>;
}

export interface HostPathOptions {
  /** 手で書いた対応（codex.pathMap） */
  pathMap: readonly [string, string][];
  probe?: HostPathProbe;
  docker?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

/** あるところまで realpath し、無い残りを足す */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.toReversed());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/** 手で書いた対応: 前から順に、境界（/）が合う最初の対応を使う（当たらなければ元のパス） */
export function mapPath(pathMap: readonly [string, string][], local: string): { host: string; rule?: [string, string] } {
  for (const rule of pathMap) {
    const [from, to] = rule;
    if (local === from || local.startsWith(`${from}/`)) return { host: to + local.slice(from.length), rule };
  }
  return { host: local };
}

/** コンテナの外として振る舞う（P3_HOST_PATHS=direct のとき） */
export const DIRECT_PROBE: HostPathProbe = {
  mountinfo: () => null,
  cgroup: () => null,
  dockerenv: () => false,
  hostname: () => "",
  realpath: (p) => p,
  inspect: async () => null,
};

/** 実際の OS と docker の CLI（接続先は docker の CLI が環境変数と context から決める） */
export function systemProbe(docker = "docker", timeoutMs = DOCKER_LIMITS.inspectMs): HostPathProbe {
  return {
    mountinfo: () => read("/proc/self/mountinfo"),
    cgroup: () => read("/proc/self/cgroup"),
    dockerenv: () => existsSync("/.dockerenv"),
    hostname: () => osHostname(),
    realpath: realpathLoose,
    inspect: async (id, signal) => {
      try {
        const { stdout } = await dockerExec(docker, ["inspect", "--type", "container", "--format", "{{json .}}", id], {
          stage: "自分のコンテナの確認（docker inspect）",
          timeoutMs,
          signal,
        });
        return JSON.parse(stdout) as InspectedContainer;
      } catch (e) {
        if (e instanceof DockerCommandError && /no such (container|object)/i.test(e.stderr)) return null;
        throw e;
      }
    },
  };
}

/** mountinfo の1行（マウントの場所と、元の場所） */
export interface MountEntry {
  root: string;
  mountPoint: string;
  fsType: string;
}

/** mountinfo の \040 などのエスケープを戻す */
const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));

export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(" ");
    const sep = f.indexOf("-");
    if (f.length < 7 || sep < 6) continue;
    out.push({ root: unescape(f[3]), mountPoint: unescape(f[4]), fsType: f[sep + 1] ?? "" });
  }
  return out;
}

const ID = /(?:^|\/)(?:containers|overlay-containers)\/([0-9a-f]{64})(?:\/|$)/;
/** Docker（と Podman）がコンテナごとに置くファイル */
const PER_CONTAINER = new Set(["/etc/hostname", "/etc/hosts", "/etc/resolv.conf"]);

/** 自分のコンテナの ID の候補（mountinfo の /etc/hostname などの元の場所、cgroup v1 の docker の行） */
export function containerIdCandidates(mountinfo: string | null, cgroup: string | null): string[] {
  const ids = new Set<string>();
  for (const m of mountinfo ? parseMountinfo(mountinfo) : []) {
    if (!PER_CONTAINER.has(m.mountPoint)) continue;
    const id = ID.exec(m.root)?.[1];
    if (id) ids.add(id);
  }
  for (const line of cgroup?.split("\n") ?? []) {
    const id = /\/docker[/-]([0-9a-f]{64})(?:\.scope)?$/.exec(line.trim())?.[1];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 境界（/）が合うか */
const under = (p: string, base: string) => base === "/" || p === base || p.startsWith(`${base}/`);
const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** p を含む一番深いマウントの場所（同じ場所に重なっていれば後のもの） */
export function deepestMount(mounts: readonly MountEntry[], p: string): MountEntry | undefined {
  let best: MountEntry | undefined;
  for (const m of mounts) if (under(p, m.mountPoint) && (!best || m.mountPoint.length >= best.mountPoint.length)) best = m;
  return best;
}

const MANUAL_HINT = "p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker のホストから見たパス>";

interface Self {
  env: HostPathEnvironment;
  container?: InspectedContainer;
}

/** 自分のコンテナを確かめる */
async function identify(probe: HostPathProbe, signal?: AbortSignal): Promise<Self> {
  const mountinfo = probe.mountinfo();
  const candidates = containerIdCandidates(mountinfo, probe.cgroup());
  if (!candidates.length) {
    if (probe.dockerenv())
      return { env: { kind: "container-unknown", reason: "self-unknown", detail: "コンテナの中で動いているようですが、自分のコンテナの ID が分かりません" } };
    return { env: { kind: "direct" } };
  }
  const found: InspectedContainer[] = [];
  for (const id of candidates) {
    let c: InspectedContainer | null;
    try {
      c = await probe.inspect(id, signal);
    } catch (e) {
      if (e instanceof DockerAbortError && e.reason === "aborted") throw e;
      const why = (e as NodeJS.ErrnoException).code === "ENOENT" ? "docker コマンドがありません" : (e as Error).message.split("\n")[0];
      return { env: { kind: "container-unknown", reason: "inspect-failed", detail: `自分のコンテナを Docker に問い合わせられません（${why}）` } };
    }
    if (c && c.Id === id) found.push(c);
  }
  if (!found.length)
    return {
      env: {
        kind: "container-unknown",
        reason: "self-not-found",
        detail: "接続先の Docker のデーモンに、p3 が動いているコンテナがありません（リモートの Docker・別のデーモンに繋がっている）",
      },
    };
  if (found.length > 1)
    return { env: { kind: "container-unknown", reason: "self-ambiguous", detail: `自分のコンテナの候補が ${found.length} つあり、1つに決まりません` } };
  const c = found[0];
  const host = c.Config?.Hostname;
  if (host && host !== probe.hostname())
    return {
      env: { kind: "container-unknown", reason: "self-mismatch", detail: "docker inspect で見つけたコンテナのホスト名が、このマシンのホスト名と合いません" },
    };
  if (mountsDisagree(c, parseMountinfo(mountinfo ?? ""), probe))
    return {
      env: {
        kind: "container-unknown",
        reason: "self-mismatch",
        detail: `docker inspect で見つけたコンテナのマウントの元が、このマシンのマウントと合いません（${SHARED_HINT}）`,
      },
    };
  return { env: { kind: "container", containerId: c.Id }, container: c };
}

/** ネットワークを共有する構成の説明（止める理由に添える） */
const SHARED_HINT = "Compose の network_mode: service:・--network container: でネットワークを共有するコンテナでは、共有元を自分と取り違えることがあります";

/**
 * 見つけたコンテナの bind が、このマシンのマウントと合わないか。mountinfo の root（マウントの元のファイルシステムの中のパス）は、
 * bind の Source の末尾と一致するはず（ファイルシステムの丸ごとの bind は root が / なので比べない）。マウント先が mountinfo に
 * 無いもの（/var/run → /run のようにリンクを辿っても見つからないもの）は比べない。ホストでシンボリックリンクを通して bind すると
 * Source はリンクのまま・root は実体になり、合わないと判定する（自動では決めず、手で書いてもらう。取り違えて別のフォルダを
 * マウントするより安全な側に倒す）
 */
function mountsDisagree(c: InspectedContainer, mounts: readonly MountEntry[], probe: HostPathProbe): boolean {
  for (const m of c.Mounts ?? []) {
    if (m.Type !== "bind" || !m.Destination || !m.Source?.startsWith("/")) continue;
    const at = probe.realpath(trimSlash(m.Destination));
    const mine = mounts.findLast((x) => x.mountPoint === at);
    if (!mine || mine.root === "/") continue;
    const root = trimSlash(mine.root);
    const src = trimSlash(m.Source);
    if (src !== root && !src.endsWith(root)) return true;
  }
  return false;
}

type Auto = { ok: true; host: string; destination: string } | { ok: false; reason: HostPathReason; detail: string };

/** 自分のコンテナのマウントから1つのパスを求める */
function fromMounts(local: string, mounts: readonly MountEntry[], c: InspectedContainer, probe: HostPathProbe): Auto {
  const real = probe.realpath(local);
  const m = deepestMount(mounts, real);
  if (!m || m.mountPoint === "/")
    return { ok: false, reason: "container-layer", detail: "このフォルダはホストのフォルダ（bind マウント）の下にありません（コンテナの中だけにある）" };
  const mount = (c.Mounts ?? []).find((x) => x.Destination && trimSlash(x.Destination) === m.mountPoint);
  // ファイルシステムの一部を付けたマウント（bind の形）なのに、自分のコンテナの Mounts に無い: 共有元を自分と取り違えている
  if (!mount && m.root !== "/")
    return {
      ok: false,
      reason: "self-mismatch",
      detail: `このフォルダのマウントが、docker inspect で見つけたコンテナのマウントにありません（${SHARED_HINT}）`,
    };
  if (!mount)
    return {
      ok: false,
      reason: "not-bind",
      detail: `このフォルダは Docker が付けたマウントではない場所（${m.fsType}）の下にあります`,
    };
  if (mount.Type !== "bind")
    return { ok: false, reason: "not-bind", detail: `このフォルダはホストのフォルダではないマウント（${mount.Type ?? "不明"}）の下にあります` };
  const src = mount.Source ?? "";
  if (!src.startsWith("/"))
    return { ok: false, reason: "unsupported-source", detail: "このフォルダのマウントの元が、そのまま渡せる形（/ で始まるパス）ではありません" };
  return { ok: true, host: trimSlash(src) + real.slice(m.mountPoint.length), destination: m.mountPoint };
}

/** 止める理由ごとの次にすること（1つ） */
export function nextStep(reason: HostPathReason): string {
  switch (reason) {
    case "not-bind":
    case "container-layer":
      return "このフォルダを、ホストのフォルダをマウント（bind）した場所の下へ移してください";
    case "conflict":
      return "手で書いた対応を直すか外してください（p3 user-config set codex.pathMap-=<このマシンのパス>。外せば自動で決めます）";
    case "inspect-failed":
      return "docker version で Docker に繋がるか確かめてください";
    default:
      return `ホストから見たパスを手で書いてください: ${MANUAL_HINT}`;
  }
}

/**
 * 対象のパスごとに、Docker のデーモンから見たパスを決める。1つでも決まらなければ ok: false（呼ぶ側はコンテナを起こさない）
 */
export async function resolveHostPaths(locals: readonly string[], opts: HostPathOptions): Promise<HostPathResolution> {
  // P3_HOST_PATHS=direct: 自動で決めず、コンテナの外と同じに扱う（手で書いた対応だけ。テストと切り分け用）
  const probe = opts.probe ?? (process.env.P3_HOST_PATHS === "direct" ? DIRECT_PROBE : systemProbe(opts.docker, opts.timeoutMs));
  const manual = (local: string) => {
    const m = mapPath(opts.pathMap, local);
    return m.rule ? m : undefined;
  };
  const self = await identify(probe, opts.signal);
  const mounts = self.container ? parseMountinfo(probe.mountinfo() ?? "") : [];
  const paths = locals.map((local): HostPathResult => {
    const hand = manual(local);
    if (self.env.kind === "direct") return hand ? { ok: true, local, host: hand.host, origin: "manual", rule: hand.rule, verified: false } : { ok: true, local, host: local, origin: "direct" };
    if (self.env.kind === "container-unknown") {
      if (hand) return { ok: true, local, host: hand.host, origin: "manual", rule: hand.rule, verified: false };
      return { ok: false, local, reason: self.env.reason, detail: self.env.detail, next: nextStep(self.env.reason) };
    }
    const auto = fromMounts(local, mounts, self.container!, probe);
    if (hand) {
      if (auto.ok && trimSlash(auto.host) !== trimSlash(hand.host))
        return {
          ok: false,
          local,
          reason: "conflict",
          detail: "手で書いた対応（codex.pathMap）と、p3 が自分のコンテナのマウントから求めたホストのパスが違います",
          next: nextStep("conflict"),
        };
      return { ok: true, local, host: hand.host, origin: "manual", rule: hand.rule, verified: auto.ok };
    }
    if (!auto.ok) return { ok: false, local, reason: auto.reason, detail: auto.detail, next: nextStep(auto.reason) };
    return { ok: true, local, host: auto.host, origin: "auto", destination: auto.destination };
  });
  return { ok: paths.every((p) => p.ok), environment: self.env, paths };
}

/** ローカルで確かめるコマンド（実際のパスはこの CLI の出力だけに出す） */
export const PATHS_CHECK = "p3 user-config paths <このマシンのパス>";

/**
 * 決まらなかったときのエラーの文。共有の記録（run.json・ログ）に残るので、このマシンのパス・ホストのパス・コンテナの ID は書かず、
 * 対象の名前・理由・次にすること・確かめ方だけにする
 */
export function unresolvedMessage(what: string, items: readonly { label: string; result: HostPathResult }[]): string {
  const ng = items.filter((i): i is { label: string; result: Extract<HostPathResult, { ok: false }> } => !i.result.ok);
  const nexts = [...new Set(ng.map((i) => i.result.next))];
  return [
    `${what}でマウントするフォルダが Docker のホストのどこにあるか決められないので、コンテナを起こしません（どのフォルダもマウントしていません）`,
    ...ng.map((i) => `  ${i.label}: ${i.result.detail}`),
    ...nexts.map((n) => `次にすること: ${n}`),
    `確かめる: このマシンで ${PATHS_CHECK}（実際のパスと決め方が出ます）`,
  ].join("\n");
}

/** 決め方の説明（共有の記録に残してよい言葉だけ） */
export function originText(r: Extract<HostPathResult, { ok: true }>, rules: number): string {
  if (r.origin === "auto") return "自動（p3 が動いているコンテナのマウントから）";
  if (r.origin === "manual")
    return r.rule && r.rule[0] === r.rule[1]
      ? `codex.pathMap の対応あり（パスは変わらない）${r.verified ? "。コンテナのマウントとも一致" : ""}`
      : `codex.pathMap の対応あり${r.verified ? "。コンテナのマウントとも一致" : ""}`;
  return rules
    ? `codex.pathMap の対応なし（${rules} 件のどれにも当たらない。このマシンのパスのまま渡す）`
    : "codex.pathMap の対応なし（このマシンのパスのまま渡す）";
}
