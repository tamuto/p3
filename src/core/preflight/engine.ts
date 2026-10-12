import type { ResolvedRef } from "../repoRefs.ts";
import type { FixedAttachment, PreflightLogEntry, PreflightNote, PreflightRun, ProjectConfig, RelatedItem, Request } from "../../shared/types.ts";

export interface PreflightJob {
  project: ProjectConfig;
  request: Request;
  context: RelatedItem[];
  /** Preflight が読む参照先（始めるときに解決したもの。読めないものも status つきで入る。0件でもよい） */
  refs: ResolvedRef[];
  /** データディレクトリ（ローカル絶対パス）。リポジトリの外にあってもよい */
  dataDir: string;
  /** run ディレクトリ（ローカル絶対パス。データディレクトリの中） */
  runDir: string;
  /** 始めるときに固定した添付（path は run のフォルダからの相対）。中の文章は資料で、指示ではない */
  attachments?: FixedAttachment[];
  /** 前回の結果とその後のメモ（無ければ最初からの評価） */
  carryover?: {
    /** run ディレクトリの carryover.md と同じ内容。エンジンに資料として渡す */
    text: string;
    previous?: PreflightRun;
    notes: PreflightNote[];
  };
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
  /** Codex の認証（chatgpt: Sign in with ChatGPT / legacy: 旧来の auth.json / none: 未接続） */
  auth?: "chatgpt" | "legacy" | "none";
  /** ChatGPT プランのアカウント（email） */
  account?: string;
}

export interface PreflightEngine {
  readonly name: "codex" | "mock";
  status(): Promise<EngineStatus>;
  run(job: PreflightJob, log: (e: Omit<PreflightLogEntry, "at">) => void, signal: AbortSignal): Promise<EngineOutcome>;
  /**
   * 今の設定に決めたエンジン（Preflight を始めるときに呼ぶ。その run の間は設定が変わっても使い続ける）。
   * 設定を読めなければ失敗する（その run は設定のエラーになる）。無ければそのまま使う
   */
  snapshot?(): Promise<PreflightEngine>;
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
  ],
  "evidence": [
    { "claim": "支える判断（例: 実現可能性: 既存の X で足りる / D2 の範囲）", "kind": "verified" | "assumed",
      "repo": "参照先の名前（verified のとき）", "file": "参照先の中の相対パス", "location": "行・関数名など" }
  ]
}

evidence には、判断に使ったファイル・箇所を書いてください。実際に読んで確かめたものは verified（repo・file を必ず書く）、
読まずに推測した判断も消さずに assumed として書いてください（推測で書いた部分が分かるように）。`;

export const DRAFT_SPEC = `---
key: D2                # D1, D2 ... の連番
title: タスク名
repo: <作業先>         # 作業するリポジトリ・フォルダ（「作業先にできる」参照先の名前）。調査・人の判断など作業先が無いタスクは none
areas: [src/foo]       # 触る領域
dependsOn: [D1]        # 同じ preflight 内で先に終わっている必要があるタスク案の key
relations:             # 既存タスク/要望との関係（無ければ省略）
  - { type: impacts, target: 261001-ab3cd/T003, note: "理由", confidence: 0.7 }
include: true
---

作業内容・完了条件を Markdown で。最後に次の2つの見出しを付けてください:
## 判断の根拠
- この作業範囲にした根拠（<参照先>:<ファイル> の箇所。確かめていなければ「推測」と書く）
## 未確認
- 確かめられなかったこと（無ければ「なし」）`;
