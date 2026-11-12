/**
 * プロジェクトの品質基準（project.yaml の quality）。プロジェクトとして守る最低限の水準（規約・構成・検証・文書など）を、
 * 安定した ID の項目として持つ。CLI・API・画面で同じ規則を使う（保存は core/quality.ts）。
 *
 *   - 状態: unset（quality が無い。初めて作るときの状態に任せている）/ set（設定済み。意図して空でもよい）/ invalid（読めない値がある）
 *   - 項目: { id: Q1.., text, repos?（無い・空は全部の参照先）, check（machine: コマンドと成功の条件 / manual: 人が確かめる方法・参照の資料）,
 *     exempt?（適用の除外。理由が要る）, source?（採用したテンプレートの項目） }
 *   - ID は追加のときに振り、消した ID を別の内容に使い直さない（seq に振った最後の番号を残す）
 *   - P3 はコマンドを実行しない・依存を入れない。確認の方法は CI・手元の作業・外の自動化のどれでもよい（特定の製品・フォルダを必須にしない）
 *   - テンプレートは同梱の版つきの例で、業界の標準への認証ではない。採用すると編集できる実体に写す。テンプレートが改版しても採用済みの
 *     内容は変わらない（差分を見て明示して当てる）
 */

export const QUALITY_LIMITS = {
  standards: 100,
  text: 1000,
  command: 500,
  success: 500,
  reference: 1000,
  reason: 500,
} as const;

export type QualityCheck = { kind: "machine"; command: string; success: string } | { kind: "manual"; reference: string };

export interface QualityStandard {
  /** 安定した ID（Q1, Q2, ...） */
  id: string;
  /** 何を守るか */
  text: string;
  /** 対象の参照先（無い・空は全部） */
  repos?: string[];
  check: QualityCheck;
  /** 適用の除外（理由が要る） */
  exempt?: { reason: string };
  /** 採用したテンプレートの項目（差分を見るため） */
  source?: { template: string; version: number; key: string };
}

export interface QualityConfig {
  /** 採用したテンプレート（版） */
  templates?: { id: string; version: number }[];
  standards: QualityStandard[];
  /** 振った最後の番号 */
  seq?: number;
}

/** ある時点の品質基準の写し（Preflight の run・レビューの材料に固定する） */
export interface QualitySnapshot {
  state: "unset" | "set" | "invalid";
  version: string;
  standards?: QualityStandard[];
  problems?: string[];
}

export function qualitySnapshot(state: QualityState | undefined, version: string | undefined): QualitySnapshot {
  const st = state ?? { state: "unset" as const };
  if (st.state === "set") return { state: "set", version: version ?? "", standards: structuredClone(st.config.standards) };
  if (st.state === "invalid") return { state: "invalid", version: version ?? "", problems: [...st.problems] };
  return { state: "unset", version: version ?? "" };
}

export type QualityState =
  | { state: "unset" }
  | { state: "set"; config: QualityConfig; warnings?: string[] }
  | { state: "invalid"; problems: string[] };

export class QualityInputError extends Error {
  constructor(
    readonly code: "quality_invalid" | "quality_conflict" | "quality_unreadable",
    message: string,
  ) {
    super(message);
  }
}

export const QUALITY_ID_RE = /^Q\d+$/;

// --- 読む ---------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

function readCheck(v: unknown): QualityCheck | string {
  if (!v || typeof v !== "object") return "check がありません（kind: machine / manual）";
  const o = v as Record<string, unknown>;
  if (o.kind === "machine") {
    const command = str(o.command);
    const success = str(o.success);
    if (!command || !success) return "machine の check には command と success が要ります";
    return { kind: "machine", command, success };
  }
  if (o.kind === "manual") {
    const reference = str(o.reference);
    if (!reference) return "manual の check には reference（確かめ方・参照の資料）が要ります";
    return { kind: "manual", reference };
  }
  return "check の kind は machine か manual です";
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
  for (const [i, x] of (list as unknown[]).entries()) {
    const s = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const id = str(s.id) ?? "";
    const at = `品質基準 ${i + 1} 件目${id ? `（${id}）` : ""}`;
    if (!QUALITY_ID_RE.test(id)) {
      problems.push(`${at} の id が読めません（Q1, Q2, ...）`);
      continue;
    }
    if (standards.some((x) => x.id === id)) {
      problems.push(`品質基準の id が重複しています: ${id}`);
      continue;
    }
    const text = str(s.text);
    if (!text) {
      problems.push(`${at} の text が空です`);
      continue;
    }
    const check = readCheck(s.check);
    if (typeof check === "string") {
      problems.push(`${at}: ${check}`);
      continue;
    }
    const repos = Array.isArray(s.repos) ? (s.repos as unknown[]).map((r) => String(r).trim()).filter(Boolean) : undefined;
    for (const r of repos ?? []) if (repoNames.length && !repoNames.includes(r)) warnings.push(`${id} の対象の参照先 ${r} は登録されていません`);
    let exempt: QualityStandard["exempt"];
    if (s.exempt !== undefined && s.exempt !== null) {
      const reason = s.exempt && typeof s.exempt === "object" ? str((s.exempt as Record<string, unknown>).reason) : undefined;
      if (!reason) {
        problems.push(`${at} の適用の除外に理由がありません（exempt.reason）`);
        continue;
      }
      exempt = { reason };
    }
    const src = s.source && typeof s.source === "object" ? (s.source as Record<string, unknown>) : undefined;
    const source = src && str(src.template) && str(src.key) && Number.isInteger(src.version) ? { template: str(src.template)!, version: src.version as number, key: str(src.key)! } : undefined;
    standards.push({ id, text, ...(repos?.length ? { repos } : {}), check, ...(exempt ? { exempt } : {}), ...(source ? { source } : {}) });
  }
  if (standards.length > QUALITY_LIMITS.standards) problems.push(`品質基準は ${QUALITY_LIMITS.standards} 件までです`);
  const templates = Array.isArray(o.templates)
    ? (o.templates as unknown[]).flatMap((t) => {
        const x = t && typeof t === "object" ? (t as Record<string, unknown>) : {};
        return str(x.id) && Number.isInteger(x.version) ? [{ id: str(x.id)!, version: x.version as number }] : [];
      })
    : undefined;
  const seq = Number.isInteger(o.seq) && (o.seq as number) >= 0 ? (o.seq as number) : undefined;
  if (problems.length) return { state: "invalid", problems };
  return { state: "set", config: { ...(templates?.length ? { templates } : {}), standards, ...(seq !== undefined ? { seq } : {}) }, ...(warnings.length ? { warnings } : {}) };
}

/** 書く形（読み直すと同じになる） */
export function qualityPlain(c: QualityConfig): Record<string, unknown> {
  return {
    ...(c.templates?.length ? { templates: c.templates.map((t) => ({ id: t.id, version: t.version })) } : {}),
    standards: c.standards.map((s) => ({
      id: s.id,
      text: s.text,
      ...(s.repos?.length ? { repos: [...s.repos] } : {}),
      check: s.check.kind === "machine" ? { kind: "machine", command: s.check.command, success: s.check.success } : { kind: "manual", reference: s.check.reference },
      ...(s.exempt ? { exempt: { reason: s.exempt.reason } } : {}),
      ...(s.source ? { source: { ...s.source } } : {}),
    })),
    ...(c.seq ? { seq: c.seq } : {}),
  };
}

/** 品質の設定の版（中身の hash。無い・読めないは別の値）。保存の前に比べる */
export function qualityVersion(state: QualityState, raw?: unknown): string {
  const key = state.state === "set" ? JSON.stringify(qualityPlain(state.config)) : state.state === "unset" ? "unset" : `invalid:${JSON.stringify(raw ?? null)}`;
  return fnv(key);
}

/** 依存を足さない短い hash（版の比較だけに使う） */
function fnv(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

// --- 変える -------------------------------------------------------------------

export type QualityStandardInput = { text: string; repos?: string[]; check: QualityCheck };

export type QualityOp =
  | { op: "init" }
  | { op: "adopt"; template: string; version?: number }
  /** 採用したテンプレートを今の版へ明示して当てる（足された項目を足し、変わった項目の文・確認の方法を置き換え、消えた項目は出典だけ外す） */
  | { op: "upgrade"; template: string }
  | { op: "add"; standard: QualityStandardInput }
  /** 一覧を丸ごと置き換える（画面の保存。id のある行は今の項目を直し、無い行は新しい ID を振る。無くなった項目は消える。出典は残す） */
  | {
      op: "replace";
      standards: (QualityStandardInput & { id?: string; exemptReason?: string; source?: { template: string; version: number; key: string } })[];
      /** 画面でテンプレートを編集中の一覧へ足したとき、採用したテンプレート（版） */
      templates?: { id: string; version: number }[];
    }
  | { op: "edit"; id: string; standard: Partial<QualityStandardInput> }
  | { op: "remove"; id: string }
  | { op: "exempt"; id: string; reason: string }
  | { op: "unexempt"; id: string };

function clean(raw: string | undefined, label: string, max: number): string {
  const t = (raw ?? "").trim();
  if (!t) throw new QualityInputError("quality_invalid", `${label}を書いてください`);
  if (t.length > max) throw new QualityInputError("quality_invalid", `${label}は ${max} 文字までです（${t.length} 文字）`);
  return t;
}

function cleanCheck(c: QualityCheck | undefined): QualityCheck {
  if (!c) throw new QualityInputError("quality_invalid", "確認の方法（機械の検査か人の確認）を選んでください");
  if (c.kind === "machine") return { kind: "machine", command: clean(c.command, "検査のコマンド", QUALITY_LIMITS.command), success: clean(c.success, "成功の条件", QUALITY_LIMITS.success) };
  if (c.kind === "manual") return { kind: "manual", reference: clean(c.reference, "確かめ方・参照の資料", QUALITY_LIMITS.reference) };
  throw new QualityInputError("quality_invalid", "確認の方法は machine か manual です");
}

function cleanRepos(repos: string[] | undefined, repoNames: readonly string[]): string[] | undefined {
  const list = [...new Set((repos ?? []).map((r) => r.trim()).filter(Boolean))];
  for (const r of list) if (!repoNames.includes(r)) throw new QualityInputError("quality_invalid", `参照先 ${r} は登録されていません（${repoNames.join(", ") || "参照先なし"}）`);
  return list.length ? list : undefined;
}

function checkSource(src: { template: string; version: number; key: string }, templates: readonly QualityTemplate[]) {
  const t = templates.find((x) => x.id === src.template && x.version === src.version);
  if (!t?.items.some((i) => i.key === src.key)) throw new QualityInputError("quality_invalid", `テンプレートの項目 ${src.template}@${src.version}:${src.key} はありません`);
  return { template: src.template, version: src.version, key: src.key };
}

const lastSeq = (c: QualityConfig) => c.standards.reduce((n, s) => Math.max(n, Number(s.id.slice(1))), c.seq ?? 0);

/** 操作を順に当てた後の設定（何も書かない。合わなければ QualityInputError で1件も当てない） */
export function applyQualityOps(state: QualityState, ops: readonly QualityOp[], ctx: { repoNames: readonly string[]; templates: readonly QualityTemplate[] }): QualityConfig {
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
      case "init":
        break;
      case "adopt": {
        const t = ctx.templates.find((x) => x.id === op.template && (op.version === undefined || x.version === op.version));
        if (!t) throw new QualityInputError("quality_invalid", `テンプレート ${op.template}${op.version ? `@${op.version}` : ""} はありません（${ctx.templates.map((x) => `${x.id}@${x.version}`).join(", ")}）`);
        if (c.templates?.some((x) => x.id === t.id)) throw new QualityInputError("quality_invalid", `テンプレート ${t.id} は採用済みです（更新は差分を見て当ててください）`);
        for (const item of t.items) {
          seq += 1;
          c.standards.push({ id: `Q${seq}`, text: item.text, check: structuredClone(item.check), source: { template: t.id, version: t.version, key: item.key } });
        }
        c.templates = [...(c.templates ?? []), { id: t.id, version: t.version }];
        break;
      }
      case "upgrade": {
        const d = templateDiffs(c, ctx.templates).find((x) => x.template === op.template);
        if (!d) throw new QualityInputError("quality_invalid", `テンプレート ${op.template} に当てる差分はありません`);
        const latest = ctx.templates.find((t) => t.id === d.template && t.version === d.to)!;
        const at = (key: string) => latest.items.find((i) => i.key === key)!;
        c = {
          ...c,
          standards: c.standards.map((x) => {
            if (x.source?.template !== d.template) return x;
            if (d.changed.some((ch) => ch.key === x.source!.key)) return { ...x, text: at(x.source.key).text, check: structuredClone(at(x.source.key).check), source: { ...x.source, version: d.to } };
            if (d.removed.some((r) => r.key === x.source!.key)) return (({ source: _s, ...rest }) => rest)(x);
            return { ...x, source: { ...x.source, version: d.to } };
          }),
        };
        for (const a of d.added) {
          seq += 1;
          c.standards.push({ id: `Q${seq}`, text: a.text, check: structuredClone(at(a.key).check), source: { template: d.template, version: d.to, key: a.key } });
        }
        c.templates = (c.templates ?? []).map((t) => (t.id === d.template ? { id: t.id, version: d.to } : t));
        break;
      }
      case "replace": {
        const seen = new Set<string>();
        const next: QualityStandard[] = op.standards.map((row) => {
          const cur = row.id ? find(row.id) : undefined;
          if (row.id && seen.has(row.id)) throw new QualityInputError("quality_invalid", `品質基準 ${row.id} が2回あります`);
          if (row.id) seen.add(row.id);
          const repos = cleanRepos(row.repos, ctx.repoNames);
          const reason = row.exemptReason?.trim();
          if (reason !== undefined && reason.length > QUALITY_LIMITS.reason) throw new QualityInputError("quality_invalid", `適用の除外の理由は ${QUALITY_LIMITS.reason} 文字までです`);
          const id = cur?.id ?? `Q${++seq}`;
          return {
            id,
            text: clean(row.text, `品質基準 ${id} の文`, QUALITY_LIMITS.text),
            ...(repos ? { repos } : {}),
            check: cleanCheck(row.check),
            ...(reason ? { exempt: { reason } } : {}),
            ...(cur?.source ? { source: cur.source } : row.source ? { source: checkSource(row.source, ctx.templates) } : {}),
          };
        });
        const adopted = [...(c.templates ?? [])];
        for (const t of op.templates ?? []) {
          if (!ctx.templates.some((x) => x.id === t.id && x.version === t.version)) throw new QualityInputError("quality_invalid", `テンプレート ${t.id}@${t.version} はありません`);
          if (!adopted.some((x) => x.id === t.id)) adopted.push({ id: t.id, version: t.version });
        }
        c = { ...c, standards: next, ...(adopted.length ? { templates: adopted } : {}) };
        break;
      }
      case "add": {
        seq += 1;
        c.standards.push({ id: `Q${seq}`, text: clean(op.standard.text, "品質基準の文", QUALITY_LIMITS.text), ...(cleanRepos(op.standard.repos, ctx.repoNames) ? { repos: cleanRepos(op.standard.repos, ctx.repoNames) } : {}), check: cleanCheck(op.standard.check) });
        break;
      }
      case "edit": {
        const s = find(op.id);
        const next: QualityStandard = {
          ...s,
          ...(op.standard.text !== undefined ? { text: clean(op.standard.text, "品質基準の文", QUALITY_LIMITS.text) } : {}),
          ...(op.standard.check !== undefined ? { check: cleanCheck(op.standard.check) } : {}),
        };
        if (op.standard.repos !== undefined) {
          const r = cleanRepos(op.standard.repos, ctx.repoNames);
          if (r) next.repos = r;
          else delete next.repos;
        }
        c = { ...c, standards: c.standards.map((x) => (x.id === s.id ? next : x)) };
        break;
      }
      case "remove":
        find(op.id);
        c = { ...c, standards: c.standards.filter((x) => x.id !== op.id) };
        break;
      case "exempt": {
        const s = find(op.id);
        const reason = clean(op.reason, "適用の除外の理由", QUALITY_LIMITS.reason);
        c = { ...c, standards: c.standards.map((x) => (x.id === s.id ? { ...x, exempt: { reason } } : x)) };
        break;
      }
      case "unexempt": {
        const s = find(op.id);
        c = { ...c, standards: c.standards.map((x) => (x.id === s.id ? (({ exempt: _e, ...rest }) => rest)(x) : x)) };
        break;
      }
      default:
        throw new QualityInputError("quality_invalid", `知らない操作です: ${String((op as { op: unknown }).op)}`);
    }
  }
  if (c.standards.length > QUALITY_LIMITS.standards) throw new QualityInputError("quality_invalid", `品質基準は ${QUALITY_LIMITS.standards} 件までです`);
  return { ...c, ...(seq > 0 ? { seq } : {}) };
}

/** 参照先に当てはまる品質基準（除外したものは別に返す）。repo が null（作業先なし）なら全体の基準だけ */
export function standardsFor(config: QualityConfig, repo: string | null | undefined): { applies: QualityStandard[]; exempt: QualityStandard[] } {
  const hit = config.standards.filter((s) => !s.repos?.length || (repo ? s.repos.includes(repo) : false));
  return { applies: hit.filter((s) => !s.exempt), exempt: hit.filter((s) => s.exempt) };
}

/** 確認の方法の一行 */
export const checkLine = (c: QualityCheck) => (c.kind === "machine" ? `検査: ${c.command}（成功: ${c.success}）` : `人の確認: ${c.reference}`);

// --- テンプレート -------------------------------------------------------------

export interface QualityTemplate {
  id: string;
  version: number;
  title: string;
  description: string;
  items: { key: string; text: string; check: QualityCheck }[];
}

/** テンプレートの差分（採用した版と今の版。key ごと） */
export interface TemplateDiff {
  template: string;
  from: number;
  to: number;
  added: { key: string; text: string }[];
  changed: { key: string; ids: string[]; text: string }[];
  removed: { key: string; ids: string[] }[];
}

export function templateDiffs(config: QualityConfig, templates: readonly QualityTemplate[]): TemplateDiff[] {
  const out: TemplateDiff[] = [];
  for (const used of config.templates ?? []) {
    const latest = templates.filter((t) => t.id === used.id).sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.version <= used.version) continue;
    const old = templates.find((t) => t.id === used.id && t.version === used.version);
    const mine = config.standards.filter((s) => s.source?.template === used.id);
    const idsOf = (key: string) => mine.filter((s) => s.source?.key === key).map((s) => s.id);
    const added = latest.items.filter((i) => !old?.items.some((o) => o.key === i.key)).map((i) => ({ key: i.key, text: i.text }));
    const changed = latest.items
      .filter((i) => {
        const o = old?.items.find((x) => x.key === i.key);
        return o && JSON.stringify([o.text, o.check]) !== JSON.stringify([i.text, i.check]);
      })
      .map((i) => ({ key: i.key, ids: idsOf(i.key), text: i.text }));
    const removed = (old?.items ?? []).filter((o) => !latest.items.some((i) => i.key === o.key)).map((o) => ({ key: o.key, ids: idsOf(o.key) }));
    out.push({ template: used.id, from: used.version, to: latest.version, added, changed, removed });
  }
  return out;
}

// --- タスクの受け入れ基準への取り込み -----------------------------------------------

/** 項目の中身の hash（文・確認の方法・対象。取り込んだ後に変わったかを見る） */
export const standardHash = (s: Pick<QualityStandard, "text" | "check" | "repos">) => fnv(JSON.stringify([s.text, s.check, s.repos ?? []]));

/** 受け入れ基準に取り込むときの文（品質 ID と確認の方法を添える） */
export const qualityCriterionText = (s: Pick<QualityStandard, "id" | "text" | "check">) => `[${s.id}] ${s.text}（${checkLine(s.check)}）`;

/** 取り込む受け入れ基準（作業先に当てはまり、除外していない品質基準） */
export function qualityCriteria(config: QualityConfig, version: string, opts: { repo: string | null | undefined; ids?: readonly string[] }): { text: string; quality: { id: string; hash: string; version: string } }[] {
  const list = opts.ids ? config.standards.filter((s) => opts.ids!.includes(s.id) && !s.exempt) : standardsFor(config, opts.repo).applies;
  if (opts.ids) {
    const missing = opts.ids.filter((id) => !config.standards.some((s) => s.id === id));
    if (missing.length) throw new QualityInputError("quality_invalid", `品質基準 ${missing.join(", ")} はありません`);
  }
  return list.map((s) => ({ text: qualityCriterionText(s), quality: { id: s.id, hash: standardHash(s), version } }));
}

/** タスクの受け入れ基準と、今の品質基準の差分の1件 */
export interface TaskQualityDiffItem {
  /** add: 当てはまるが取り込んでいない / change: 取り込んだ後に品質基準が変わった / remove: 品質基準が消えた・当てはまらなくなった / exempt: 除外になった / edited: タスクで文を直した（知らせだけ） */
  kind: "add" | "change" | "remove" | "exempt" | "edited";
  quality: string;
  /** 取り込んだ受け入れ基準の ID（add には無い） */
  criterion?: string;
  /** 今の品質基準の文（取り込むときの文。remove・exempt には無いことがある） */
  text?: string;
  reason?: string;
}

/**
 * タスクの受け入れ基準と今の品質基準の差分（読むだけ。タスクは書き換えない）。作業先が無いタスクには、取り込み済みのもの以外を足す案を出さない
 */
export function taskQualityDiff(criteria: readonly { id: string; text: string; quality?: { id: string; hash: string } }[], state: QualityState | undefined, repo: string | null | undefined): TaskQualityDiffItem[] {
  if (!state || state.state !== "set") return [];
  const config = state.config;
  const out: TaskQualityDiffItem[] = [];
  const { applies, exempt } = standardsFor(config, repo);
  for (const c of criteria) {
    if (!c.quality) continue;
    const s = config.standards.find((x) => x.id === c.quality!.id);
    if (!s) out.push({ kind: "remove", quality: c.quality.id, criterion: c.id, reason: "品質基準が消えました" });
    else if (exempt.some((x) => x.id === s.id)) out.push({ kind: "exempt", quality: s.id, criterion: c.id, reason: `除外になりました: ${s.exempt!.reason}` });
    else if (!applies.some((x) => x.id === s.id)) out.push({ kind: "remove", quality: s.id, criterion: c.id, reason: "作業先に当てはまらなくなりました" });
    else if (standardHash(s) !== c.quality.hash) out.push({ kind: "change", quality: s.id, criterion: c.id, text: qualityCriterionText(s) });
    else if (c.text !== qualityCriterionText(s)) out.push({ kind: "edited", quality: s.id, criterion: c.id, text: qualityCriterionText(s), reason: "タスクで文を直しています" });
  }
  if (repo) for (const s of applies) if (!criteria.some((c) => c.quality?.id === s.id)) out.push({ kind: "add", quality: s.id, text: qualityCriterionText(s) });
  return out;
}
