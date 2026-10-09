import type { PreflightLogEntry, ProjectConfig, RelatedItem, Request } from "../../shared/types.ts";

export interface PreflightJob {
  project: ProjectConfig;
  request: Request;
  context: RelatedItem[];
  /** 管理対象リポジトリのルート（ローカルパス） */
  repoRoot: string;
  /** データディレクトリ（ローカル絶対パス）。リポジトリの外にあってもよい */
  dataDir: string;
  /** run ディレクトリ（ローカル絶対パス。データディレクトリの中） */
  runDir: string;
}

export interface EngineOutcome {
  /** エンジンが書き換えたファイル（ローカル絶対パス） */
  changed: string[];
  usage?: Record<string, unknown>;
  threadModel?: string;
}

/**
 * Preflight エンジン。結果は戻り値ではなく run ディレクトリ配下のファイルとして書き出す契約:
 *   <runDir>/assessment.json   評価（PreflightAssessment）
 *   <runDir>/drafts/D1.md ...   タスク案（frontmatter + 説明）
 * ファイル契約にしておくことで、Codex でも人手でも別エージェントでも同じ取り込み処理になる。
 */
/** エンジンが使えるか（画面に出す） */
export interface EngineStatus {
  name: "codex" | "mock";
  ok: boolean;
  /** 人が読む説明（使えないならその理由） */
  detail: string;
}

export interface PreflightEngine {
  readonly name: "codex" | "mock";
  status(): Promise<EngineStatus>;
  run(job: PreflightJob, log: (e: Omit<PreflightLogEntry, "at">) => void, signal: AbortSignal): Promise<EngineOutcome>;
}

export const ASSESSMENT_SPEC = `{
  "summary": "要望の要約と結論（日本語, 2-4文）",
  "verdict": "go" | "clarify" | "no_go",
  "validity":    { "score": 0-100, "reasons": ["要望として妥当か: 目的・価値・既存方針との整合"] },
  "feasibility": { "score": 0-100, "reasons": ["実現可能か: 既存コード・技術的制約・規模"] },
  "risks": ["..."],
  "questions": ["要望者に確認すべき事項"],
  "areas": ["影響するコード領域やコンポーネント（リポジトリ相対パス推奨）"],
  "impacts": [
    { "target": "別の要望なら <要望ID>、そのタスクなら <要望ID>/T003", "type": "depends_on|impacts|relates_to|duplicates|supersedes",
      "reason": "なぜ関係するか", "confidence": 0.0-1.0 }
  ]
}`;

export const DRAFT_SPEC = `---
key: D2                # D1, D2 ... の連番
title: タスク名
areas: [src/foo]       # 触る領域
dependsOn: [D1]        # 同じ preflight 内で先に終わっている必要があるタスク案の key
relations:             # 既存タスク/要望との関係（無ければ省略）
  - { type: impacts, target: 261001-ab3cd/T003, note: "理由", confidence: 0.7 }
include: true
---

作業内容・完了条件を Markdown で。`;
