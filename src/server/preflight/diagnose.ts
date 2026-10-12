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

export function describeMapping(m: PathMapping, rules: number): string {
  const how = m.rule
    ? m.rule[0] === m.rule[1]
      ? `対応 ${m.rule[0]}=${m.rule[1]}（パスは変わらない）`
      : `対応 ${m.rule[0]}=${m.rule[1]}`
    : rules
      ? `対応なし（codex.pathMap の ${rules} 件のどれにも当たらない。このパスのまま渡す）`
      : "対応なし（codex.pathMap が空。このパスのまま渡す）";
  return `${m.label}: ${m.local} → Docker のホスト ${m.host}（${how}）→ コンテナ ${m.container}`;
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

export function diagnoseLaunch(
  r: LaunchResult,
  ctx: { image: string; mappings: PathMapping[]; rules: number; configPath?: string; phase: "start" | "run" },
): LaunchDiagnosis {
  const { exit, stderr } = r;
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
  const bind = /bind source path does not exist: (\S+)/.exec(stderr);
  if (exit?.spawnError === "ENOENT") hints.push("docker コマンドが見つかりません。Docker を入れて、PATH を確かめてください");
  if (bind) {
    hints.push(
      `Docker のホストにこのパス（${bind[1]}）がありません。個人設定の codex.pathMap を確かめてください${ctx.configPath ? `（${ctx.configPath}）` : ""}`,
      "今のパスの対応:",
      ...ctx.mappings.map((m) => `  ${describeMapping(m, ctx.rules)}`),
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
