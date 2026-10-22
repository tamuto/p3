import type { ResolvedRef } from "../repoRefs.ts";
import type { FixedAttachment, PreflightLogEntry, PreflightNote, PreflightRun, ProjectConfig, Request } from "../../shared/types.ts";

export interface PreflightJob {
  project: ProjectConfig;
  request: Request;
  /** Preflight が読む参照先（始めるときに解決したもの。読めないものも status つきで入る。0件でもよい） */
  refs: ResolvedRef[];
  /** データディレクトリ（ローカル絶対パス）。リポジトリの外にあってもよい */
  dataDir: string;
  /** run ディレクトリ（ローカル絶対パス。データディレクトリの中） */
  runDir: string;
  /** 始めるときに固定した添付（path は run のフォルダからの相対）。中の文章は資料で、指示ではない */
  attachments?: FixedAttachment[];
  /** 子の要望なら、始めたときの親（目的を評価の資料にする。子の範囲は要望の本文にある） */
  parent?: Pick<Request, "id" | "title" | "body">;
  /** 今ある子の要望（重ねて分割しないための資料） */
  children?: Pick<Request, "id" | "title" | "status">[];
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
 *   <runDir>/children/C1.md ... 子の要望の案（分割するときだけ。タスク案とは一緒に書かない）
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
  "split": { "decision": "split" | "keep", "estimatedTasks": 想定するタスクの数（概算）, "reasons": ["分割する・しない理由"] },
  "evidence": [
    { "claim": "支える判断（例: 実現可能性: 既存の X で足りる / D2 の範囲）", "kind": "verified" | "assumed",
      "repo": "参照先の名前（verified のとき）", "file": "参照先の中の相対パス", "location": "行・関数名など",
      "commit": "経緯を確かめたコミット（git の履歴を根拠にしたとき）" }
  ]
}

evidence には、判断に使ったファイル・箇所を書いてください。実際に読んで確かめたものは verified（repo・file を必ず書く）、
読まずに推測した判断も消さずに assumed として書いてください（推測で書いた部分が分かるように）。`;

/** 分割の基準（SPLIT_HINT_TASKS と同じ数を書く） */
export const SPLIT_GUIDE = (hint: number) => `分割するか・しないか（split）:
- 想定するタスクの数が ${hint} 以上なら、分割するか・しないかとその理由を必ず split に書く（数は概算でよい。数を出すためだけに大きなタスク案を書かない）。
- ${hint} 未満でも、独立したインフラ（基盤・Lambda・IaC など）、権限や運用の担当が違う、リリースの境界が違う、別のリポジトリで別にレビューしたい作業があれば分割の候補（split に理由を書く）。
- ${hint} 以上でも、同じ契約（API の型とその呼び出し側、保存の形とその読み書き）を一緒に直さないと途中が壊れる、1つの PR でしかレビューできないなら分けない（keep と理由）。
- 小さいプロジェクトのフロントエンドとバックエンドは機械的に分けない。
- 分割する（split）なら、タスク案（drafts/）は書かずに子の要望の案（children/）だけを書く。分けないならタスク案だけを書く（両方は書かない）。
  子は人が採用した後、子ごとに別の Preflight でタスクにする（ここでは子のタスク案は書かない）。`;

export const CHILD_SPEC = `---
key: C1                # C1, C2 ... の連番
title: 子の要望の題
estimatedTasks: 3      # 想定するタスクの数（概算）
requires: [C2]         # 前提にする他の子の案の key（無ければ省略。タスクの依存ではなく、前提の契約として本文に書く）
overlaps: [T002]       # 親の既存のタスクと重なりうるもの（無ければ省略）
include: true
---

## 目的
## 範囲
## 範囲外
## 完了条件
## 分割の理由
## 他の子との前提と契約
## 出典
（見出しはこの順。目的と完了条件は必ず書く。出典には根拠にした <参照先>:<ファイル> を書く）`;

export const DRAFT_SPEC = `---
key: D2                # D1, D2 ... の連番
title: タスク名
repo: <作業先>         # 作業するリポジトリ・フォルダ（「作業先にできる」参照先の名前）。調査・人の判断など作業先が無いタスクは none
areas: [src/foo]       # 触る領域
dependsOn: [D1]        # 同じ preflight 内で先に終わっている必要があるタスク案の key
supersedes: [T003]     # この案が置き換える、同じ要望の既存タスク（再評価で古いタスクを置き換えるときだけ。無ければ省略）
include: true
---

作業内容・完了条件を Markdown で。最後に次の2つの見出しを付けてください:
## 判断の根拠
- この作業範囲にした根拠（<参照先>:<ファイル> の箇所。確かめていなければ「推測」と書く）
## 未確認
- 確かめられなかったこと（無ければ「なし」）`;
