/**
 * プロジェクトの品質基準（project.yaml の quality）。プロジェクトとして守る最低限の水準を、安定した ID の項目として持つ。
 * CLI・API・画面で同じ規則を使う（保存は core/quality.ts と Workspace.writeQuality）。
 *
 *   - 項目: { id: Q1.., text, repos?（無い・空は全部の参照先）, how?（確かめ方。文1つで、コマンドでも人の手順でもよい） }
 *   - ID は追加のときに振り、消した ID を別の内容に使い直さない（seq に振った最後の番号を残す）
 *   - タスクを作るとき（直接作成・タスク化）に、作業先に当てはまる基準を `[Q1] 文（確かめ方）` の受け入れ基準として足す。参照先の指定が無い基準は
 *     作業先なしのタスクにも当てはまる。基準を変えても既にあるタスクは変えない（変えた後に作るタスクから当てはまる）
 *   - 以前の形の check（manual の reference・machine の command と success）は確かめ方の文として読む。テンプレートの記録（templates・source）は読まない。
 *     除外（exempt）の付いた基準は無いものとして扱う
 *   - P3 はコマンドを実行しない・依存を入れない
 */

export const QUALITY_LIMITS = { standards: 100, text: 1000, how: 1000 } as const;

export interface QualityStandard {
  /** 安定した ID（Q1, Q2, ...） */
  id: string;
  /** 何を守るか */
  text: string;
  /** 対象の参照先（無い・空は全部） */
  repos?: string[];
  /** 確かめ方（任意） */
  how?: string;
}

export interface QualityConfig {
  standards: QualityStandard[];
  /** 振った最後の番号 */
  seq?: number;
}

/** 品質基準の写し（マイルストーンレビューの材料に固定する。比べるのは中身） */
export interface QualitySnapshot {
  state: "unset" | "set" | "invalid";
  standards?: QualityStandard[];
  problems?: string[];
}

export type QualityState = { state: "unset" } | { state: "set"; config: QualityConfig; warnings?: string[] } | { state: "invalid"; problems: string[] };

export function qualitySnapshot(state: QualityState | undefined): QualitySnapshot {
  const st = state ?? { state: "unset" as const };
  if (st.state === "set") return { state: "set", standards: structuredClone(st.config.standards) };
  if (st.state === "invalid") return { state: "invalid", problems: [...st.problems] };
  return { state: "unset" };
}

export class QualityInputError extends Error {
  constructor(
    readonly code: "quality_invalid" | "quality_unreadable" | "quality_conflict",
    message: string,
  ) {
    super(message);
  }
}

export const QUALITY_ID_RE = /^Q\d+$/;

// --- 読む ---------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

/** 確かめ方を読む（how。無ければ以前の形の check から） */
function readHow(s: Record<string, unknown>): string | undefined {
  const how = str(s.how);
  if (how) return how;
  const c = s.check && typeof s.check === "object" ? (s.check as Record<string, unknown>) : undefined;
  if (c?.kind === "manual") return str(c.reference) || undefined;
  if (c?.kind === "machine") {
    const command = str(c.command);
    const success = str(c.success);
    return command ? `${command}${success ? `（成功: ${success}）` : ""}` : undefined;
  }
  return undefined;
}

/**
 * project.yaml の quality を読む。無ければ unset、読めない値があれば invalid（理由つき。ファイルは書き換えない）。
 * repoNames: 今の参照先（知らない参照先は警告にする。読める）
 */
export function readQuality(raw: unknown, repoNames: readonly string[] = []): QualityState {
  if (raw === undefined) return { state: "unset" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", problems: ["quality は standards を持つ対応（マップ）にしてください"] };
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  const warnings: string[] = [];
  const list = o.standards ?? [];
  if (!Array.isArray(list)) return { state: "invalid", problems: ["quality.standards が並びになっていません"] };
  const standards: QualityStandard[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const [i, x] of (list as unknown[]).entries()) {
    const s = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const id = str(s.id) ?? "";
    const at = `品質基準 ${i + 1} 件目${id ? `（${id}）` : ""}`;
    if (!QUALITY_ID_RE.test(id)) {
      problems.push(`${at} の id が読めません（Q1, Q2, ...）`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`品質基準の id が重複しています: ${id}`);
      continue;
    }
    ids.add(id);
    const text = str(s.text);
    if (!text) {
      problems.push(`${at} の text が空です`);
      continue;
    }
    // 以前の版の適用の除外は、無いものとして扱う（ID は使い直さない）
    if (s.exempt !== undefined && s.exempt !== null) {
      skipped = Math.max(skipped, Number(id.slice(1)));
      continue;
    }
    const repos = Array.isArray(s.repos) ? (s.repos as unknown[]).map((r) => String(r).trim()).filter(Boolean) : undefined;
    for (const r of repos ?? []) if (repoNames.length && !repoNames.includes(r)) warnings.push(`${id} の対象の参照先 ${r} は登録されていません`);
    const how = readHow(s);
    standards.push({ id, text, ...(repos?.length ? { repos } : {}), ...(how ? { how } : {}) });
  }
  if (standards.length > QUALITY_LIMITS.standards) problems.push(`品質基準は ${QUALITY_LIMITS.standards} 件までです`);
  const given = Number.isInteger(o.seq) && (o.seq as number) >= 0 ? (o.seq as number) : 0;
  const seq = Math.max(given, skipped) || undefined;
  if (problems.length) return { state: "invalid", problems };
  return { state: "set", config: { standards, ...(seq !== undefined ? { seq } : {}) }, ...(warnings.length ? { warnings } : {}) };
}

/** 書く形（読み直すと同じになる） */
export function qualityPlain(c: QualityConfig): Record<string, unknown> {
  return {
    standards: c.standards.map((s) => ({ id: s.id, text: s.text, ...(s.repos?.length ? { repos: [...s.repos] } : {}), ...(s.how ? { how: s.how } : {}) })),
    ...(c.seq ? { seq: c.seq } : {}),
  };
}

// --- 変える -------------------------------------------------------------------

export type QualityStandardInput = { text: string; repos?: string[]; how?: string };

export type QualityOp =
  | { op: "add"; standard: QualityStandardInput }
  /**
   * 一覧を丸ごと置き換える（画面の保存。id のある行は今の項目を直し、無い行は新しい ID を振る。無くなった項目は消える）。
   * base: 編集を始めたときの一覧。今の一覧と違えば quality_conflict で断る（他の変更を黙って消さない）
   */
  | { op: "replace"; standards: (QualityStandardInput & { id?: string })[]; base?: QualityStandard[] }
  | { op: "edit"; id: string; standard: Partial<QualityStandardInput> }
  | { op: "remove"; id: string };

function clean(raw: string | undefined, label: string, max: number): string {
  const t = (raw ?? "").trim();
  if (!t) throw new QualityInputError("quality_invalid", `${label}を書いてください`);
  if (t.length > max) throw new QualityInputError("quality_invalid", `${label}は ${max} 文字までです（${t.length} 文字）`);
  return t;
}

function cleanHow(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  if (t.length > QUALITY_LIMITS.how) throw new QualityInputError("quality_invalid", `確かめ方は ${QUALITY_LIMITS.how} 文字までです（${t.length} 文字）`);
  return t || undefined;
}

function cleanRepos(repos: string[] | undefined, repoNames: readonly string[]): string[] | undefined {
  const list = [...new Set((repos ?? []).map((r) => r.trim()).filter(Boolean))];
  for (const r of list) if (!repoNames.includes(r)) throw new QualityInputError("quality_invalid", `参照先 ${r} は登録されていません（${repoNames.join(", ") || "参照先なし"}）`);
  return list.length ? list : undefined;
}

const make = (id: string, text: string, repos: string[] | undefined, how: string | undefined): QualityStandard => ({ id, text, ...(repos ? { repos } : {}), ...(how ? { how } : {}) });
const lastSeq = (c: QualityConfig) => c.standards.reduce((n, s) => Math.max(n, Number(s.id.slice(1))), c.seq ?? 0);

/** 操作を順に当てた後の設定（何も書かない。合わなければ QualityInputError で1件も当てない。読めない設定は変えない） */
export function applyQualityOps(state: QualityState, ops: readonly QualityOp[], ctx: { repoNames: readonly string[] }): QualityConfig {
  if (state.state === "invalid") throw new QualityInputError("quality_unreadable", `project.yaml の quality が読めないため変えられません。ファイルを直してください: ${state.problems.join(" / ")}`);
  let c: QualityConfig = state.state === "set" ? structuredClone(state.config) : { standards: [] };
  let seq = lastSeq(c);
  const find = (id: string) => {
    const s = c.standards.find((x) => x.id === id);
    if (!s) throw new QualityInputError("quality_invalid", `品質基準 ${id} はありません`);
    return s;
  };
  for (const op of ops) {
    switch (op.op) {
      case "add":
        seq += 1;
        c.standards.push(make(`Q${seq}`, clean(op.standard.text, "品質基準の文", QUALITY_LIMITS.text), cleanRepos(op.standard.repos, ctx.repoNames), cleanHow(op.standard.how)));
        break;
      case "replace": {
        if (op.base && JSON.stringify(qualityPlain({ standards: op.base }).standards) !== JSON.stringify(qualityPlain(c).standards))
          throw new QualityInputError("quality_conflict", "品質基準が他で変わったので保存しませんでした。読み直してから直してください");
        const seen = new Set<string>();
        const next = op.standards.map((row) => {
          const cur = row.id ? find(row.id) : undefined;
          if (row.id && seen.has(row.id)) throw new QualityInputError("quality_invalid", `品質基準 ${row.id} が2回あります`);
          if (row.id) seen.add(row.id);
          const id = cur?.id ?? `Q${++seq}`;
          return make(id, clean(row.text, `品質基準 ${id} の文`, QUALITY_LIMITS.text), cleanRepos(row.repos, ctx.repoNames), cleanHow(row.how));
        });
        c = { ...c, standards: next };
        break;
      }
      case "edit": {
        const s = find(op.id);
        const text = op.standard.text !== undefined ? clean(op.standard.text, "品質基準の文", QUALITY_LIMITS.text) : s.text;
        const repos = op.standard.repos !== undefined ? cleanRepos(op.standard.repos, ctx.repoNames) : s.repos;
        const how = op.standard.how !== undefined ? cleanHow(op.standard.how) : s.how;
        c = { ...c, standards: c.standards.map((x) => (x.id === s.id ? make(s.id, text, repos, how) : x)) };
        break;
      }
      case "remove":
        find(op.id);
        c = { ...c, standards: c.standards.filter((x) => x.id !== op.id) };
        break;
      default:
        throw new QualityInputError("quality_invalid", `知らない操作です: ${String((op as { op: unknown }).op)}`);
    }
  }
  if (c.standards.length > QUALITY_LIMITS.standards) throw new QualityInputError("quality_invalid", `品質基準は ${QUALITY_LIMITS.standards} 件までです`);
  return { ...c, ...(seq > 0 ? { seq } : {}) };
}

/** 作業先に当てはまる品質基準（参照先の指定が無い基準は作業先なしにも当てはまり、指定がある基準は一致する作業先だけ） */
export function standardsFor(config: QualityConfig, repo: string | null | undefined): QualityStandard[] {
  return config.standards.filter((s) => !s.repos?.length || (repo ? s.repos.includes(repo) : false));
}

/** 受け入れ基準に取り込むときの文（品質 ID と確かめ方を添える） */
export const qualityCriterionText = (s: Pick<QualityStandard, "id" | "text" | "how">) => `[${s.id}] ${s.text}${s.how ? `（${s.how}）` : ""}`;

/** タスクを作るときに足す受け入れ基準（作業先に当てはまる品質基準。基準には品質の ID だけを残す） */
export function qualityCriteria(config: QualityConfig, repo: string | null | undefined): { text: string; quality: { id: string } }[] {
  return standardsFor(config, repo).map((s) => ({ text: qualityCriterionText(s), quality: { id: s.id } }));
}
