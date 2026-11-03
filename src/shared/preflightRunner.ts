/**
 * Preflight の担当（project.yaml の preflight.runner。プロジェクトで1つ、共有の設定）。
 *   - codex: 人が p3 から実行する（Codex が評価する）。AI は、人が対象の要望の手元の評価を明示して頼んだときだけ評価する
 *   - agent: Codex を使えない環境向け。人に「Preflight して」と頼まれたら、手元の対話エージェントが評価する（--prepare / --complete）
 * どちらでも、AI が自分から Preflight を始める・勧めることはなく、タスク化（accept）は人が行う。
 * これは AI 向けの手順を選ぶための方針で、p3 preflight のエンジン（マシン設定の preflight.engine: codex / mock）や
 * run の engine（local など）とは別物。p3 preflight の動き・--prepare / --complete の可否は変えない。
 * 個人（マシン）の設定での上書きは設けない（共有の方針を1つに読めるようにする。Codex を使えない人は codex のままでも明示の依頼で手元の評価ができる）
 */
export type PreflightRunner = "codex" | "agent";
export const PREFLIGHT_RUNNERS: readonly PreflightRunner[] = ["codex", "agent"];
/** 未設定のときの担当（以前のプロジェクトはこれ） */
export const DEFAULT_PREFLIGHT_RUNNER: PreflightRunner = "codex";

export const isPreflightRunner = (v: unknown): v is PreflightRunner => (PREFLIGHT_RUNNERS as readonly unknown[]).includes(v);

/** 今の担当。runner が null なら設定が読めない（problem に理由。agent と推測しない） */
export interface RunnerView {
  runner: PreflightRunner | null;
  /** project: project.yaml に書いてある / default: 未設定なので codex */
  source: "project" | "default";
  problem?: string;
}

export function runnerView(preflight: { runner?: PreflightRunner; invalidRunner?: string }): RunnerView {
  if (preflight.invalidRunner !== undefined) {
    return {
      runner: null,
      source: "project",
      problem: `project.yaml の preflight.runner が読めません: ${preflight.invalidRunner}（${PREFLIGHT_RUNNERS.join(" / ")} のどれか。p3 config set preflight.runner=codex で直せます）`,
    };
  }
  return preflight.runner ? { runner: preflight.runner, source: "project" } : { runner: DEFAULT_PREFLIGHT_RUNNER, source: "default" };
}

export const RUNNER_LABEL: Record<PreflightRunner, string> = {
  codex: "人が p3 から実行する（Codex）",
  agent: "手元の AI エージェントが評価する（頼まれたとき）",
};
