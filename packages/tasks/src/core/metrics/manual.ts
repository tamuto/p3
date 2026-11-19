import { join } from "node:path";
import { MetricsError, type ManualRecord } from "../../shared/metrics.ts";
import type { P3Context } from "../context.ts";
import { withFileLock } from "@infodb/p3-kit/fsutil.ts";
import { readJsonRecord, writeJsonRecord } from "../store/jsonRecord.ts";
import { METRIC_DEFINITIONS, type ManualSpec } from "./definitions.ts";

/**
 * 人が記録する指標の値（費用・リリース後の不具合など。記録から出せないもの）の保存。記録は CLI の p3 metrics record からだけ（API・画面は読むだけ）。
 *
 *   <data>/metrics/manual.json   {version: 1, seq, records: [...]}（プロジェクトのデータと一緒に共有する）
 *   <data>/metrics/.manual.lock  書くときのロック（同じマシンのプロセスの間）
 *
 *   - 1件は 指標・範囲（project かマイルストーン ID）・観測期間（開始日・終了日）・単位 で決まる。同じ内容の再送は何も変えない。値・出典・メモを
 *     変える訂正は、読んだ版（rev）を渡したときだけ（渡さない・違えば競合で何も書かない）
 *   - 値は0以上（不具合は整数）。費用は通貨コードごとで、通貨・期間の違う値を1つに合算しない。範囲の間（全体とマイルストーン）も合算しない
 *   - ロックの中で読み直してから書き、置き換えで書く（途中の状態を読ませない）。壊れたファイルは空とみなさず、読めないと知らせて書かない
 *   - 記録のあるマイルストーンは通常の削除で消さない（core/requestOps.ts の checkMilestoneRemoval）。直接編集で消えたら知らせる
 */

const DIR = "metrics";
const FILE = "manual.json";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SOURCE_MAX = 1000;

interface ManualFile {
  version: 1;
  seq: number;
  records: ManualRecord[];
}

export const manualFile = (dataDir: string) => join(dataDir, DIR, FILE);
const lockFile = (dataDir: string) => join(dataDir, DIR, `.${FILE.replace(".json", "")}.lock`);

const validDate = (v: string) => DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function readRecord(raw: unknown, i: number): ManualRecord {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const at = `${i + 1} 件目`;
  if (!o) throw new Error(`${at} がオブジェクトではありません`);
  const s = (k: string) => (typeof o[k] === "string" && o[k] ? o[k] : undefined);
  const id = s("id");
  if (!id || !/^M\d+$/.test(id)) throw new Error(`${at} の id が読めません（M1, M2, ...）`);
  for (const k of ["metric", "scope", "from", "to", "unit", "source", "createdAt", "updatedAt"]) if (!s(k)) throw new Error(`${at}（${id}）の ${k} がありません`);
  if (typeof o.value !== "number" || !Number.isFinite(o.value) || o.value < 0) throw new Error(`${at}（${id}）の value が 0 以上の数ではありません`);
  if (!Number.isInteger(o.rev) || (o.rev as number) < 1) throw new Error(`${at}（${id}）の rev が読めません`);
  return {
    id,
    metric: s("metric")!,
    scope: s("scope")!,
    from: s("from")!,
    to: s("to")!,
    value: o.value,
    unit: s("unit")!,
    source: s("source")!,
    ...(s("note") ? { note: s("note") } : {}),
    rev: o.rev as number,
    createdAt: s("createdAt")!,
    ...(s("createdBy") ? { createdBy: s("createdBy") } : {}),
    updatedAt: s("updatedAt")!,
    ...(s("updatedBy") ? { updatedBy: s("updatedBy") } : {}),
  };
}

/** 記録を読む。無ければ空、壊れていれば problem（空とみなさない） */
export async function readManual(dataDir: string): Promise<{ records: ManualRecord[]; seq: number; problem?: string }> {
  const broken = (m: string) => ({ records: [], seq: 0, problem: `${DIR}/${FILE} が読めません（直してください。記録は書き足しません）: ${m}` });
  return readJsonRecord<{ records: ManualRecord[]; seq: number; problem?: string }>(manualFile(dataDir), {
    missing: () => ({ records: [], seq: 0 }),
    readFailed: (e) => ({ records: [], seq: 0, problem: `読めません: ${e.message}` }),
    invalidJson: broken,
    shape: (raw) => {
      try {
        const j = raw as Partial<ManualFile>;
        if (!j || typeof j !== "object" || j.version !== 1 || !Array.isArray(j.records)) throw new Error("{version: 1, records: [...]} の形ではありません");
        const records = j.records.map(readRecord);
        const seq = Math.max(Number.isInteger(j.seq) ? (j.seq as number) : 0, ...records.map((r) => Number(r.id.slice(1))));
        return { records, seq };
      } catch (e) {
        return broken((e as Error).message);
      }
    },
  });
}

export interface ManualInput {
  metric: string;
  /** 省けば project */
  scope?: string;
  from: string;
  to: string;
  /** 数か数の文字列 */
  value: number | string;
  unit?: string;
  source: string;
  note?: string;
}

const manualSpec = (metric: string): ManualSpec => {
  const d = METRIC_DEFINITIONS.find((x) => x.id === metric);
  if (!d?.manual) {
    const ids = METRIC_DEFINITIONS.filter((x) => x.manual).map((x) => x.id);
    throw new MetricsError(`人が記録する指標ではありません: ${metric}（${ids.join(" / ")}）`);
  }
  return d.manual;
};

/** 入力を確かめて、識別に使う値と保存する値にする（何も書かない） */
export function cleanManual(ctx: P3Context, i: ManualInput): Pick<ManualRecord, "metric" | "scope" | "from" | "to" | "value" | "unit" | "source" | "note"> {
  const spec = manualSpec(i.metric);
  const scope = i.scope || "project";
  if (scope !== "project" && !ctx.ws.project.milestones.some((m) => m.id === scope)) throw new MetricsError(`マイルストーン ${scope} は登録されていません（project か登録済みのマイルストーン ID）`);
  if (!validDate(i.from) || !validDate(i.to)) throw new MetricsError(`観測期間は YYYY-MM-DD の日付で指定してください（--from ${i.from || "?"} --to ${i.to || "?"}）`);
  if (i.from > i.to) throw new MetricsError(`観測期間の開始日 ${i.from} が終了日 ${i.to} より後です`);
  const value = typeof i.value === "number" ? i.value : i.value.trim() === "" ? NaN : Number(i.value);
  if (!Number.isFinite(value)) throw new MetricsError(`値が数ではありません: ${String(i.value)}`);
  if (value < 0) throw new MetricsError(`値は 0 以上です: ${value}`);
  if (spec.value === "integer" && !Number.isInteger(value)) throw new MetricsError(`${i.metric} の値は 0 以上の整数です: ${value}`);
  let unit: string;
  if (spec.unit === "currency") {
    unit = (i.unit ?? "").trim().toUpperCase();
    if (!CURRENCY.test(unit)) throw new MetricsError(`${i.metric} は通貨コード（--unit JPY / USD など 3 文字）が要ります`);
  } else {
    unit = spec.unit;
    if (i.unit !== undefined && i.unit.trim() !== unit) throw new MetricsError(`${i.metric} の単位は「${unit}」だけです（--unit は省いてください）`);
  }
  const source = i.source?.trim() ?? "";
  if (!source) throw new MetricsError("出典（--source 請求書・課金の画面・不具合の管理表など）が要ります");
  if (source.length > SOURCE_MAX) throw new MetricsError(`出典は ${SOURCE_MAX} 文字までです`);
  const note = i.note?.trim();
  return { metric: i.metric, scope, from: i.from, to: i.to, value, unit, source, ...(note ? { note } : {}) };
}

const sameKey = (a: Pick<ManualRecord, "metric" | "scope" | "from" | "to" | "unit">, b: typeof a) => a.metric === b.metric && a.scope === b.scope && a.from === b.from && a.to === b.to && a.unit === b.unit;

const writeManual = (dataDir: string, f: ManualFile) => writeJsonRecord(manualFile(dataDir), f);

async function locked<T>(dataDir: string, fn: (cur: { records: ManualRecord[]; seq: number }) => Promise<T>): Promise<T> {
  return withFileLock(lockFile(dataDir), async () => {
    const cur = await readManual(dataDir);
    if (cur.problem) throw new MetricsError(cur.problem, "metrics_unreadable");
    return fn(cur);
  });
}

/**
 * 記録する。同じ識別（指標・範囲・期間・単位）が無ければ足す。あって値・出典・メモが同じなら何もしない（changed: false）。
 * 違えば訂正で、expectedRev がその記録の rev と同じときだけ書く（無い・違う → metrics_conflict）
 */
export async function recordManual(ctx: P3Context, input: ManualInput, opts: { expectedRev?: number; actor?: string } = {}): Promise<{ record: ManualRecord; changed: boolean; created: boolean }> {
  const v = cleanManual(ctx, input);
  const dataDir = ctx.ws.dataDir;
  return locked(dataDir, async (cur) => {
    const now = new Date().toISOString();
    const hit = cur.records.find((r) => sameKey(r, v));
    if (!hit) {
      if (opts.expectedRev !== undefined && opts.expectedRev !== 0) throw new MetricsError(`同じ指標・範囲・期間・単位の記録はありません（--rev ${opts.expectedRev} は使えません）`, "metrics_conflict");
      const record: ManualRecord = { id: `M${cur.seq + 1}`, ...v, rev: 1, createdAt: now, ...(opts.actor ? { createdBy: opts.actor } : {}), updatedAt: now, ...(opts.actor ? { updatedBy: opts.actor } : {}) };
      await writeManual(dataDir, { version: 1, seq: cur.seq + 1, records: [...cur.records, record] });
      return { record, changed: true, created: true };
    }
    if (hit.value === v.value && hit.source === v.source && (hit.note ?? "") === (v.note ?? "")) return { record: hit, changed: false, created: false };
    if (opts.expectedRev === undefined) {
      throw new MetricsError(`${hit.id} に同じ指標・範囲・期間・単位の記録があります（値 ${hit.value} ${hit.unit}・版 ${hit.rev}）。訂正するなら --rev ${hit.rev} を付けてください`, "metrics_conflict");
    }
    if (opts.expectedRev !== hit.rev) throw new MetricsError(`${hit.id} は他で変わりました（読んだ版 ${opts.expectedRev}・今の版 ${hit.rev}）。p3 metrics で確かめてからやり直してください`, "metrics_conflict");
    const { note: _n, ...rest } = hit;
    const record: ManualRecord = { ...rest, value: v.value, source: v.source, ...(v.note ? { note: v.note } : {}), rev: hit.rev + 1, updatedAt: now, ...(opts.actor ? { updatedBy: opts.actor } : {}) };
    await writeManual(dataDir, { version: 1, seq: cur.seq, records: cur.records.map((r) => (r.id === hit.id ? record : r)) });
    return { record, changed: true, created: false };
  });
}

/** 記録を消す（ID は使い直さない）。expectedRev を渡せば照らす */
export async function removeManual(ctx: P3Context, id: string, opts: { expectedRev?: number } = {}): Promise<ManualRecord> {
  const dataDir = ctx.ws.dataDir;
  return locked(dataDir, async (cur) => {
    const hit = cur.records.find((r) => r.id === id);
    if (!hit) throw new MetricsError(`人の記録 ${id} はありません（p3 metrics records で確かめてください）`);
    if (opts.expectedRev !== undefined && opts.expectedRev !== hit.rev) throw new MetricsError(`${id} は他で変わりました（読んだ版 ${opts.expectedRev}・今の版 ${hit.rev}）`, "metrics_conflict");
    await writeManual(dataDir, { version: 1, seq: cur.seq, records: cur.records.filter((r) => r.id !== id) });
    return hit;
  });
}
