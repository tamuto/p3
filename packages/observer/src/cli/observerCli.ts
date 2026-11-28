import { readFileSync } from "node:fs";
import { UsageError } from "@infodb/p3-shared/node/usage.ts";
import { observerStatus } from "../core/status.ts";
import { MetricError, MetricStore, type MetricErrorCode } from "../core/metricStore.ts";
import { formatGuide, formatValue, METRIC_AGGREGATE_LABEL, METRIC_TYPE_LABEL, parseValueText, type KeySummary, type MetricKey, type MetricValue, type Problem } from "../shared/metric.ts";
import type { MetricTarget } from "../shared/status.ts";

export const OBSERVER_USAGE = [
  "p3 observer status [--json]",
  "p3 observer list [--milestone <ID>] [--json]（項目キーの一覧。システムの項目を含む）",
  "p3 observer show <キー> [--milestone <ID>] [--json]（項目キーと値。新しい順）",
  "p3 observer key add <キー> --name <名前> --type number|string|boolean|json [--unit <単位>] [--body <説明>] [--min <下限>] [--max <上限>] [--expected <期待する値>] [--aggregate sum|avg|last]（カードに出す数。合計・平均は数値だけ）",
  "p3 observer key set <キー> --rev <今の版> [--name ..] [--type ..] [--unit ..] [--body ..] [--min ..] [--max ..] [--expected ..] [--aggregate ..]（省いた項目は今のまま。--unit= のように空にすると外す）",
  "p3 observer key rm <キー> --rev <今の版>（値があれば断る）",
  "p3 observer value add <キー> <値|-> [--at <日付か日時>] [--target <対象>] [--milestone <ID>] [--note <メモ>]（- は標準入力。構造化データは JSON）",
  "p3 observer value rm <キー> <値 ID>",
].join("\n  ");

/** 項目キーと値を読み書きするサブコマンド（入口がプロジェクトを決めてから呼ぶ。status だけはプロジェクトを決めない） */
const PROJECT_SUBCOMMANDS = ["list", "ls", "show", "key", "value"];
export const observerNeedsProject = (args: string[]) => PROJECT_SUBCOMMANDS.includes(args[0] ?? "");
/** 変えるサブコマンド（登録が1つだけで決まったときなどに、入口が書き込みを止めるため） */
export const observerWrites = (args: string[]) => args[0] === "key" || args[0] === "value";

export interface ObserverCliOptions {
  /** 入口が解決したプロジェクト（status 以外で要る） */
  target?: MetricTarget;
  actor?: string;
  name?: string;
  type?: string;
  unit?: string;
  body?: string;
  min?: string;
  max?: string;
  expected?: string;
  aggregate?: string;
  rev?: string;
  at?: string;
  /** --target（値の対象。1つだけ） */
  valueTarget?: string[];
  milestone?: string;
  note?: string;
}

export type ObserverResult = { data: unknown; text: string; code?: undefined } | { code: 1 | 2 | 3; error: string };

const EXIT: Record<MetricErrorCode, 1 | 2 | 3> = { invalid: 1, forbidden: 1, unreadable: 1, not_found: 2, conflict: 3, in_use: 3 };
const problemText = (ps: Problem[]) => ps.map((p) => `  ${p.path}: ${p.message}`).join("\n");

/** p3 observer のサブコマンド。誤りは終了コード（1 入力の誤り / 2 見つからない / 3 版の競合・値があって消せない） */
export async function observerCommand(args: string[], opts: ObserverCliOptions = {}): Promise<ObserverResult> {
  const [sub, ...rest] = args;
  if (sub === "status") {
    if (rest.length) throw new UsageError(`status は引数を取りません: ${rest.join(" ")}（${OBSERVER_USAGE}）`);
    const s = observerStatus();
    return { data: s, text: [`p3-observer ${s.version}`, `  state  ${s.state}`].join("\n") };
  }
  if (!observerNeedsProject(args)) {
    throw new UsageError(sub === undefined ? `サブコマンドを指定してください:\n  ${OBSERVER_USAGE}` : `observer のサブコマンドではありません: ${sub}\n  ${OBSERVER_USAGE}`);
  }
  if (!opts.target) throw new Error("observer: プロジェクトが決まっていません");
  const store = new MetricStore(opts.target.dataDir);
  const actor = opts.actor ?? "human:cli";
  const arity = (n: number, usage: string) => {
    if (rest.length !== n) throw new UsageError(`使い方: ${usage}`);
  };
  try {
    if (sub === "list" || sub === "ls") {
      arity(0, "p3 observer list [--milestone <ID>]");
      const l = await store.list(opts.milestone);
      return { data: l, text: listText(l.keys, l.unreadable, opts.milestone) };
    }
    if (sub === "show") {
      arity(1, "p3 observer show <キー> [--milestone <ID>]");
      const r = await store.get(rest[0], opts.milestone);
      return { data: r, text: showText(r.key, r.values, opts.milestone) };
    }
    const [op, key, ...more] = rest;
    if (sub === "key") {
      if (op === "add") {
        if (!key || more.length) throw new UsageError("使い方: p3 observer key add <キー> --name <名前> --type number|string|boolean|json …");
        const k = await store.createKey({ key, name: opts.name, description: opts.body, type: opts.type, unit: opts.unit, guide: guideOf(undefined, opts), aggregate: opts.aggregate }, actor);
        return { data: k, text: `項目キーを登録しました: ${k.key}（${k.name}・${METRIC_TYPE_LABEL[k.type]}）` };
      }
      if (op === "set") {
        if (!key || more.length) throw new UsageError("使い方: p3 observer key set <キー> --rev <今の版> [--name ..] …");
        const { key: cur } = await store.get(key);
        const pick = <T>(flag: string | undefined, now: T) => (flag === undefined ? now : flag);
        const k = await store.updateKey(key, revOf(opts.rev), { name: pick(opts.name, cur.name), description: pick(opts.body, cur.description), type: pick(opts.type, cur.type), unit: pick(opts.unit, cur.unit), guide: guideOf(cur, opts), aggregate: pick(opts.aggregate, cur.aggregate) }, actor);
        return { data: k, text: `項目キーを変えました: ${k.key}（版 ${k.rev}）` };
      }
      if (op === "rm") {
        if (!key || more.length) throw new UsageError("使い方: p3 observer key rm <キー> --rev <今の版>");
        await store.deleteKey(key, revOf(opts.rev));
        return { data: { deleted: key }, text: `項目キーを消しました: ${key}` };
      }
      throw new UsageError(`key のあとは add / set / rm のどれか:\n  ${OBSERVER_USAGE}`);
    }
    if (op === "add") {
      if (!key || more.length !== 1) throw new UsageError("使い方: p3 observer value add <キー> <値|-> [--at ..] [--target ..] [--milestone ..] [--note ..]");
      if ((opts.valueTarget?.length ?? 0) > 1) throw new UsageError("--target は1つだけ指定できます");
      const { key: k } = await store.get(key);
      const text = more[0] === "-" ? readFileSync(0, "utf8") : more[0];
      const v = await store.addValue(key, { value: parseValueText(k.type, text), at: opts.at, target: opts.valueTarget?.[0], milestone: opts.milestone, note: opts.note }, actor);
      return { data: v, text: `値を足しました: ${key} ${v.id} = ${formatValue(v.value)}${k.unit ? ` ${k.unit}` : ""}（${v.at}）` };
    }
    if (op === "rm") {
      if (!key || more.length !== 1) throw new UsageError("使い方: p3 observer value rm <キー> <値 ID>");
      await store.deleteValue(key, more[0]);
      return { data: { deleted: more[0] }, text: `値を消しました: ${key} ${more[0]}` };
    }
    throw new UsageError(`value のあとは add / rm のどれか:\n  ${OBSERVER_USAGE}`);
  } catch (e) {
    if (!(e instanceof MetricError)) throw e;
    return { code: EXIT[e.code], error: e.problems.length ? `${e.message}:\n${problemText(e.problems)}` : e.message };
  }
}

function revOf(rev: string | undefined): number {
  const n = Number(rev);
  if (rev === undefined || !Number.isInteger(n)) throw new UsageError("--rev <今の版> を指定してください（p3 observer show <キー> で確かめる）");
  return n;
}

/** 目安: 指定した項目だけを今の目安に重ねる（空の値はその項目を外す） */
function guideOf(cur: MetricKey | undefined, o: ObserverCliOptions): Record<string, unknown> | undefined {
  const given = { ...(o.min !== undefined ? { min: o.min } : {}), ...(o.max !== undefined ? { max: o.max } : {}), ...(o.expected !== undefined ? { expected: o.expected } : {}) };
  const merged = { ...cur?.guide, ...given };
  return Object.keys(merged).length ? merged : undefined;
}

const unitOf = (k: MetricKey) => (k.unit ? ` ${k.unit}` : "");

function listText(keys: KeySummary[], unreadable: { file: string; reason: string }[], milestone?: string): string {
  const lines = [`観測の項目 ${keys.length} 件${milestone ? `（マイルストーン ${milestone} の値）` : ""}`];
  for (const k of keys) {
    const card = k.card !== undefined && k.latest ? `${METRIC_AGGREGATE_LABEL[k.aggregate ?? "last"]} ${formatValue(k.card)}${unitOf(k)}（最後 ${k.latest.at.slice(0, 10)}）` : "値なし";
    lines.push(`${k.key}  ${k.system ? "[システム]" : `v${k.rev}`}  ${k.name}  ${card}・${k.count} 件`);
  }
  for (const u of unreadable) lines.push(`⚠ 読めないファイル ${u.file}: ${u.reason}`);
  return lines.join("\n");
}

function showText(k: MetricKey, values: MetricValue[], milestone?: string): string {
  const guide = formatGuide(k);
  const lines = [
    `${k.key}  ${k.name}${k.system ? "  [システムの項目。p3 が記録します]" : `  版 ${k.rev}`}`,
    `  値の形  ${METRIC_TYPE_LABEL[k.type]}${k.unit ? `（${k.unit}）` : ""}`,
    ...(k.description ? [`  説明    ${k.description}`] : []),
    ...(guide ? [`  目安    ${guide}（並べて見せるだけで、判定はしません）`] : []),
    `  カード  ${METRIC_AGGREGATE_LABEL[k.aggregate ?? "last"]}`,
    `値 ${values.length} 件${milestone ? `（マイルストーン ${milestone}）` : ""}`,
  ];
  for (const v of values) {
    const extra = [v.target && `対象 ${v.target}`, v.milestone && `マイルストーン ${v.milestone}`, v.note && `メモ ${v.note}`].filter(Boolean).join("・");
    lines.push(`  ${v.id}  ${v.at}  ${formatValue(v.value)}${unitOf(k)}  ${v.by}${extra ? `  ${extra}` : ""}`);
  }
  return lines.join("\n");
}
