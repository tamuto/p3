import { isRecord } from "./definition.ts";
import type { SuggestionFailure } from "./suggestion.ts";

/**
 * 観測の候補の提案（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）。手順の提案とは別の依頼で、人が頼んだときだけ動く。
 * 材料はアプリが tasks の記録から抜き出した判断に要る項目だけ（observer は tasks を読まない）と、読むだけで渡す参照先。
 * AI は候補を出すだけで定義を書かない。利用者が選んで確かめて保存したものだけが観測になる
 */

/** 材料の上限（多すぎると依頼が長くなる。実際の材料の量で決めた値） */
export const CANDIDATE_LIMITS = { quality: 30, criteria: 30, requests: 20, observations: 100 } as const;

/** アプリが tasks の記録から作る材料（どれも判断に要る項目だけ） */
export interface CandidateMaterial {
  /** 人が確かめる品質基準（機械の検査は CI で見ている） */
  quality: { id: string; text: string }[];
  /** 済みになったタスクの、証拠が申告のみか未検証の受け入れ基準 */
  criteria: { ref: string; id: string; text: string; state: string }[];
  /** 最近の要望（完了・対応済を新しい順。推定の経緯の関連先はこの中から選ぶ） */
  requests: { id: string; title: string; status: string; updatedAt: string }[];
  /** 今ある観測（重ねて出さないため） */
  observations: { id: string; title: string; expected?: string }[];
}

export interface ObservationCandidate {
  title: string;
  description: string;
  /** 期待する結果（観測が確かめる今の期待） */
  expected: string;
  /** なぜ観測すべきか */
  reason: string;
  /** 参照した根拠（材料の Q1・<要望>/<T>#A1・参照先のファイルなど） */
  evidence: string[];
  /** 近い既存の観測（照合のため。あれば新しく作る前に確かめる） */
  similar?: string;
  /** 推定の経緯（この期待がどの要望で決まったか。材料の要望の中から。利用者が確かめたときだけ初回の履歴に残す） */
  estimatedOrigin?: { requests: string[]; basis: string };
}

export interface CandidateJob {
  id: string;
  status: "running" | "completed" | "failed";
  engine: string;
  startedAt: string;
  finishedAt?: string;
  note?: string;
  material: CandidateMaterial;
  candidates?: ObservationCandidate[];
  warnings?: string[];
  failure?: SuggestionFailure;
  error?: string;
}

export const CANDIDATE_INSTRUCTIONS = `あなたは、ソフトウェアの観測（今の期待が実際の環境・データ・使い方で成り立っているかを確かめる記録）の候補を挙げる補助です。
観測はテストを流す仕組み（CI）ではありません。ユニットテストは観測の対象ではなく手順の道具です。CI で機械的に見られるものより、環境・人や AI の判断・
公開後の状態・揺れる結果など、CI では見にくい期待を優先してください。

材料:
- 人が確かめる品質基準、済みになったが証拠が申告のみか未検証の受け入れ基準、最近の要望、今ある観測（依頼文に載せたものだけ）
- 読むだけで渡された参照先（README・docs・最近の変更の git log など。ls・rg・cat・git log など読むだけのコマンドで調べてよい）

決まり:
- 候補ごとに、タイトル・観測内容・期待する結果・観測すべき理由・参照した根拠（材料の ID かファイル）を書く。根拠の無い候補は出さない
- 今ある観測と重なるものは出さない。近いものがあれば similar にその ID を書く
- 期待がどの要望で決まったかを材料の要望と git の記録から推定できたときだけ estimatedOrigin に書く（要望は材料の ID だけ。推定の根拠を basis に書く）
- ファイルの作成・変更、アプリの起動、テストやスクリプトの実行はしない（候補を挙げるだけ）
- 最後の応答は次の形の JSON だけにする

{ "candidates": [ { "title": "...", "description": "...", "expected": "...", "reason": "...", "evidence": ["Q2", "<要望ID>/T001#A1", "docs/x.md"], "similar": "obs-...（任意）", "estimatedOrigin": { "requests": ["<要望ID>"], "basis": "..." } } ] }`;

/** 依頼文（材料と補足） */
export function candidatePrompt(material: CandidateMaterial, repos: string[], project?: string, note?: string): string {
  const list = <T>(items: T[], line: (x: T) => string, empty: string) => (items.length ? items.map((x) => `- ${line(x)}`) : [empty]);
  return [
    ...(project ? [project, ""] : []),
    "## 人が確かめる品質基準",
    ...list(material.quality, (q) => `${q.id}: ${q.text}`, "（無い）"),
    "",
    "## 済みになったが証拠が申告のみか未検証の受け入れ基準",
    ...list(material.criteria, (c) => `${c.ref}#${c.id}（${c.state}）: ${c.text}`, "（無い）"),
    "",
    "## 最近の要望（推定の経緯の関連先はこの中から）",
    ...list(material.requests, (r) => `${r.id}（${r.status}・${r.updatedAt.slice(0, 10)}）${r.title}`, "（無い）"),
    "",
    "## 今ある観測（重ねて出さない）",
    ...list(material.observations, (o) => `${o.id} ${o.title}${o.expected ? `: 期待「${o.expected.replace(/\s+/g, " ").slice(0, 200)}」` : ""}`, "（無い）"),
    "",
    "## 読める参照先",
    ...list(repos, (r) => r, "（無い）"),
    ...(note ? ["", "## 利用者の補足", note] : []),
    "",
    "最後の応答は指示どおりの JSON だけにしてください。",
  ].join("\n");
}

/** 応答の形が違う */
export class InvalidCandidates extends Error {}

/** 応答を読む。項目が足りない候補は外して知らせ、推定の経緯の要望は材料に無いものを外す（全部外れたら形の違い） */
export function parseCandidates(message: string, material: CandidateMaterial): { candidates: ObservationCandidate[]; warnings: string[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(message)?.[1] ?? message;
  let data: unknown;
  try {
    data = JSON.parse(fenced.slice(fenced.indexOf("{"), fenced.lastIndexOf("}") + 1));
  } catch (e) {
    throw new InvalidCandidates(`応答の JSON を読めません（${(e as Error).message}）`);
  }
  if (!isRecord(data) || !Array.isArray(data.candidates)) throw new InvalidCandidates("candidates が配列ではありません");
  const warnings: string[] = [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const known = new Set(material.requests.map((r) => r.id));
  const candidates = data.candidates.flatMap((raw, i): ObservationCandidate[] => {
    const c = isRecord(raw) ? raw : {};
    const [title, description, expected, reason] = [str(c.title), str(c.description), str(c.expected), str(c.reason)];
    const evidence = Array.isArray(c.evidence) ? c.evidence.flatMap((e) => str(e) ?? []) : [];
    if (!title || !description || !expected || !reason || !evidence.length) {
      warnings.push(`候補 ${i + 1} は題・観測内容・期待・理由・根拠のどれかが無いので外しました`);
      return [];
    }
    const o = isRecord(c.estimatedOrigin) ? c.estimatedOrigin : undefined;
    const requests = Array.isArray(o?.requests) ? o.requests.filter((r): r is string => typeof r === "string") : [];
    const kept = requests.filter((r) => known.has(r));
    if (kept.length < requests.length) warnings.push(`候補「${title}」の推定の経緯から、材料に無い要望を外しました（${requests.filter((r) => !known.has(r)).join("・")}）`);
    const basis = str(o?.basis);
    const similar = str(c.similar);
    return [{ title, description, expected, reason, evidence, ...(similar && material.observations.some((x) => x.id === similar) ? { similar } : {}), ...(kept.length && basis ? { estimatedOrigin: { requests: kept, basis } } : {}) }];
  });
  if (!candidates.length && data.candidates.length) throw new InvalidCandidates("使える候補がありません（どれも項目が足りません）");
  return { candidates, warnings };
}

/** Mock の候補（AI を呼ばない）: 人が確かめる品質基準と未検証の受け入れ基準を1件ずつ候補にする */
export function mockCandidates(material: CandidateMaterial): string {
  const have = (t: string) => material.observations.some((o) => o.title === t);
  const candidates = [
    ...material.quality.slice(0, 2).map((q) => ({ title: `品質基準 ${q.id} の確認`, description: q.text, expected: `${q.text}が守られている`, reason: "Mock: 人が確かめる品質基準なので、観測として繰り返し確かめる", evidence: [q.id] })),
    ...material.criteria.slice(0, 2).map((c) => ({
      title: `${c.text.slice(0, 40)} の確認`,
      description: c.text,
      expected: c.text,
      reason: `Mock: 済みだが証拠が ${c.state} の受け入れ基準`,
      evidence: [`${c.ref}#${c.id}`],
      estimatedOrigin: { requests: [c.ref.split("/")[0]], basis: `Mock: ${c.ref} の受け入れ基準から` },
    })),
  ].filter((c) => !have(c.title));
  return JSON.stringify({ candidates });
}
