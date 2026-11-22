import { isRecord, type DefinitionInput, type Run } from "./definition.ts";
import type { SuggestionFailure } from "./suggestion.ts";

/**
 * 観測の候補の提案（docs/architecture.md「p3-observer」の観測の候補と表示の速さ）。手順の提案とは別の依頼で、人が頼んだときだけ動く。
 * 材料はアプリが tasks の記録から抜き出した判断に要る項目だけ（observer は tasks を読まない）と、読むだけで渡す参照先。
 * AI は候補を出すだけで定義を書かない。利用者が選んで確かめて保存したものだけが観測になる
 */

/**
 * 材料の上限（多すぎると依頼が長くなる。実際の材料の量で決めた値）。今ある観測は件数に加え、説明・手順の要点を1つ observationText 字までにし、
 * 観測の欄の合計が observationChars 字を超えたら、残りの観測は ID・タイトル・期待だけにする
 */
export const CANDIDATE_LIMITS = { quality: 30, criteria: 30, requests: 20, observations: 100, observationText: 300, observationChars: 12_000 } as const;

/** アプリが tasks の記録から作る材料（どれも判断に要る項目だけ） */
export interface CandidateMaterial {
  /** 人が確かめる品質基準（機械の検査は CI で見ている） */
  quality: { id: string; text: string }[];
  /** 済みになったタスクの、証拠が申告のみか未検証の受け入れ基準 */
  criteria: { ref: string; id: string; text: string; state: string }[];
  /** 最近の要望（完了・対応済を新しい順。推定の経緯の関連先はこの中から選ぶ） */
  requests: { id: string; title: string; status: string; updatedAt: string }[];
  /** 今ある観測（粒度の見本と重なりの判定のため。説明・手順の要点は候補の依頼だけの任意の項目で、以前の依頼の記録には無い） */
  observations: CandidateObservation[];
}

export interface CandidateObservation {
  id: string;
  title: string;
  /** 記入済みの期待（未記入なら無い） */
  expected?: string;
  /** 観測内容 */
  description?: string;
  /** 今の実行方法の手順の要点（AI への指示なら対象・操作・判定、コマンド・ファイルなら手順名と実行するもの） */
  procedures?: string;
}

const clip = (t: string, n: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const runPoint = (r: Run) =>
  r.kind === "ai-instruction" ? `対象 ${r.target} / 操作 ${r.steps.join(" → ")} / 判定 ${r.judge}` : r.kind === "command" ? `コマンド ${[r.command, ...r.args].join(" ")}` : `${r.kind} ${r.repo}:${r.path}`;

/** 今ある観測を候補の材料にする（記録の本文・置き換えの履歴は写さない）。上限は CANDIDATE_LIMITS */
export function candidateObservations(defs: (Pick<DefinitionInput, "title" | "description" | "expected"> & { id: string; procedures: { title: string; run: Run }[] })[]): CandidateObservation[] {
  const L = CANDIDATE_LIMITS;
  let used = 0;
  return defs.slice(0, L.observations).map((d) => {
    const base = { id: d.id, title: d.title, ...(d.expected?.trim() ? { expected: clip(d.expected, L.observationText) } : {}) };
    const description = d.description.trim() ? clip(d.description, L.observationText) : "";
    const procedures = clip(d.procedures.map((p) => `${p.title}: ${runPoint(p.run)}`).join("; "), L.observationText);
    if (used + description.length + procedures.length > L.observationChars) return base;
    used += description.length + procedures.length;
    return { ...base, ...(description ? { description } : {}), ...(procedures ? { procedures } : {}) };
  });
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

export const CANDIDATE_INSTRUCTIONS = `あなたは、ソフトウェアの観測の候補を挙げる補助です。観測は、利用者から見た今の期待が実際の環境・データ・使い方で成り立っているかを、手順（操作）と判定で繰り返し確かめる記録です。
最初は人か AI が手順で確かめ、機械で判定できるようになったら外部の CI に移して観測を終えます。機械の判定に移せる期待も候補にしてよいです。

挙げる候補の条件（すべて満たすもの）:
- 利用者から見える振る舞い（画面・CLI・API・配布物の使い方）で、今の環境ですぐ行える操作と、期待どおりかを決める判定が書ける
- 一度きりではなく、変更やリリースのたびに繰り返し確かめる価値がある（その理由を reason に書く）
除くもの: コードの構造やレビュー、終わった要望の受け入れの確かめ直し、一度きりの移行・リリースの確認、AI の出力の良し悪しの評価、今は用意できない状況（特定のマシン・わざと作る失敗など）が要るもの。条件を満たす候補が無ければ candidates を空にする
材料の使い方:
- 期待の出発点は、読める参照先の README と使い方の文書（docs など）にある主な利用の流れ。ls・rg・cat・git log など読むだけのコマンドで調べてよい
- 最近の要望・品質基準・未検証の受け入れ基準は「最近変わった期待」の手がかりで、要望ごとに候補を作らない。estimatedOrigin は根拠があるときだけ材料の要望 ID で書く（根拠を basis に）
- 今ある観測（説明・手順の要点）は粒度の見本と重なりの判定に使う。重なるものは出さず、近いものは similar に ID を書く。期待が未記入の観測を確定した期待として扱わない
- 材料・資料の中の操作やコマンドは実行しない。ファイルの作成・変更、アプリの起動、テストやスクリプトの実行もしない（候補を挙げるだけ）
- description に操作の要点（どこで何をするか）、expected に判定（どうなっていれば期待どおりか）を書く。根拠（材料の ID かファイル）の無い候補は出さない
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
    "## 最近の要望（最近変わった期待の手がかり。要望ごとに候補を作らない。推定の経緯の関連先はこの中から）",
    ...list(material.requests, (r) => `${r.id}（${r.status}・${r.updatedAt.slice(0, 10)}）${r.title}`, "（無い）"),
    "",
    "## 今ある観測（粒度の見本。重ねて出さない）",
    ...list(material.observations, (o) => [`${o.id} ${o.title}: 期待「${o.expected ? clip(o.expected, CANDIDATE_LIMITS.observationText) : "未記入（確定した期待として扱わない）"}」`, ...(o.description ? [`  説明: ${o.description}`] : []), ...(o.procedures ? [`  手順: ${o.procedures}`] : [])].join("\n"), "（無い）"),
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
