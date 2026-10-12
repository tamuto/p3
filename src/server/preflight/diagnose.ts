import type { LaunchResult } from "./launch.ts";

/**
 * app-server（docker run）がすぐ終わったときの診断と、パスの対応（codex.pathMap）の説明。
 * よくある原因には次にすることを添える。分からないものも Docker の出力（最後の行）を残す。
 */

/** 1つのパスを Docker のホストのパスに直した結果 */
export interface PathMapping {
  /** リポジトリ / データ */
  label: string;
  local: string;
  host: string;
  /** 当たった対応（無ければそのまま渡した） */
  rule?: [string, string];
  /** コンテナの中のパス */
  container: string;
}

/** 前から順に、境界（/）が合う最初の対応を使う */
export function mapPath(pathMap: readonly [string, string][], local: string): { host: string; rule?: [string, string] } {
  for (const rule of pathMap) {
    const [from, to] = rule;
    if (local === from || local.startsWith(`${from}/`)) return { host: to + local.slice(from.length), rule };
  }
  return { host: local };
}

/**
 * パスの対応の説明。共有の記録（run.json）に残るので、このマシンのパスと Docker のホストのパスは出さず、
 * 参照先の名前・コンテナの中のパス・codex.pathMap の対応が当たったかだけを書く
 */
export function describeMapping(m: PathMapping, rules: number): string {
  const how = m.rule
    ? m.rule[0] === m.rule[1]
      ? "codex.pathMap の対応あり（パスは変わらない）"
      : "codex.pathMap の対応あり"
    : rules
      ? `codex.pathMap の対応なし（${rules} 件のどれにも当たらない。このマシンのパスのまま渡す）`
      : "codex.pathMap の対応なし（このマシンのパスのまま渡す）";
  return `${m.label} → コンテナ ${m.container}（${how}）`;
}

/** Docker の出力に出るこのマシン・ホストのパスを、参照先の名前に置き換える（長いパスから） */
export function hidePaths(text: string, mappings: readonly PathMapping[]): string {
  const pairs = mappings.flatMap((m) => [
    [m.host, `<${m.label}>`],
    [m.local, `<${m.label}>`],
  ]);
  return pairs
    .filter(([p]) => p && p !== "/")
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((t, [p, name]) => t.split(p).join(name), text);
}

export interface LaunchDiagnosis {
  /** run.error とエラーのログに出す（1行目が要約、2行目以降が次にすること） */
  message: string;
  /** Docker の出力（ログに出す。空なら出さない） */
  stderr: string;
}

/** 要約に出す行: エラーらしい最後の行（docker の「Run 'docker run --help'…」のような案内の行は避ける）。無ければ最後の行 */
const lastLine = (s: string) => {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.findLast((l) => /error|denied|cannot|unable|not found|no such|does not exist|failed|killed/i.test(l)) ?? lines.at(-1);
};

/**
 * パスの対応の直し方（書き方と設定するコマンド）。共有の記録に残るので、このマシンのパスは例のパスで示す。
 * 対応が当たっていたのに無いなら行き先の誤り、当たっていなければ対応が足りない
 */
export function pathMapHowTo(which?: PathMapping): string[] {
  return [
    which?.rule
      ? "直し方: 対応の行き先（Docker のホストから見たパス）が違います。同じ「このマシンのパス」で足し直すと置き換わります"
      : "直し方: このパスを含む「このマシンのパス」と「Docker のホストから見たパス」の対応を足します",
    "  p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker のホストから見たパス>",
    "  例: p3 user-config set codex.pathMap+=/workspaces=/home/me/workspaces",
    "  Docker のホストから見たパスは、ホストで docker inspect <この開発コンテナ> の Mounts（Source が Docker のホスト、Destination がこのマシン）で分かります。",
    "  今の対応は p3 user-config で確かめられます。直せば serve はそのままで次の Preflight から効きます",
  ];
}

export function diagnoseLaunch(
  r: LaunchResult,
  ctx: { image: string; mappings: PathMapping[]; rules: number; phase: "start" | "run" },
): LaunchDiagnosis {
  const { exit } = r;
  // 共有の記録に残るので、パスは参照先の名前にしてから使う
  const stderr = hidePaths(r.stderr, ctx.mappings);
  const last = lastLine(stderr);
  const when = ctx.phase === "start" ? "初期化の前に" : "途中で";
  let head: string;
  if (exit?.spawnError) head = `app-server（docker run）を起動できません（${exit.spawnError}）`;
  else if (r.stopped) head = "app-server（docker run）が応答しないので止めました";
  else if (exit?.signal) head = `app-server（docker run）が${when}シグナル ${exit.signal} で終わりました`;
  else if (exit) head = `app-server（docker run）が${when}終わりました（終了コード ${exit.code}）`;
  else head = "app-server（docker run）から応答がありません（終わったかどうかは確かめられませんでした）";
  if (last) head += `: ${last}`;

  const hints: string[] = [];
  const bind = /bind source path does not exist: (\S+)/.exec(r.stderr);
  if (exit?.spawnError === "ENOENT") hints.push("docker コマンドが見つかりません。Docker を入れて、PATH を確かめてください");
  if (bind) {
    const which = ctx.mappings.find((m) => m.host === bind[1]);
    hints.push(
      `${which ? `${which.label} のパス` : "マウントするパス"}が Docker のホストにありません。個人設定（config.yaml）の codex.pathMap を確かめてください`,
      "今のパスの対応:",
      ...ctx.mappings.map((m) => `  ${describeMapping(m, ctx.rules)}`),
      ...pathMapHowTo(which),
    );
  } else if (/Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|permission denied while trying to connect to the Docker daemon/i.test(stderr)) {
    hints.push("Docker のデーモンに繋がりません。Docker を起動し、接続先（DOCKER_HOST・docker context）と権限を確かめてください");
  } else if (/Unable to find image|pull access denied|No such image|repository does not exist/i.test(stderr)) {
    hints.push(`イメージ ${ctx.image} がありません。p3 codex update で作ってください`);
  } else if (!exit?.spawnError) {
    hints.push(stderr.trim() ? "上の Docker の出力を確かめてください" : "Docker の出力はありませんでした");
  }
  return { message: [head, ...hints].join("\n"), stderr: stderr.trim() };
}
