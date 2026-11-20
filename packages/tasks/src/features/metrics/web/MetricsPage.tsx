import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { METRIC_STATE_LABEL, METRIC_UNIT_LABEL, type MetricResult, type MetricsReport } from "../shared/metrics.ts";
import { Button, Badge, buttonCls, cx, Empty, inputCls, Section, type Tone } from "@infodb/p3-shared/web/ui.tsx";
import { api } from "../../../web/lib/api.ts";
import { useAppData } from "../../../web/lib/appData.tsx";
import { latestOnly, STALE } from "../../../web/lib/latest.ts";

/**
 * 開発の指標（URL の ?m= でマイルストーン。省けばプロジェクト全体）。値・対象・欠損・算出の方法はサーバ（core/metrics）が出したものをそのまま
 * 見せ、画面では数え直さない。並びも定義（features/metrics/core/definitions.ts）の順で、記録から数える指標と人が記録する値に分けるだけ。
 * 改善の振り返りのための画面で、人・エージェントごとの値や順位は出さない。人の記録は CLI からで、画面は記録のしかたを見せる。
 * ルートの宣言（URL と検索の値）は web/routes/metrics.tsx
 */

const STATE_TONE: Record<MetricResult["state"], Tone> = { ok: "emerald", no_targets: "slate", no_data: "rose", not_reached: "slate", unrecorded: "amber" };

export function MetricsPage() {
  const { tick } = useAppData();
  const { m } = useSearch({ from: "/metrics" });
  const navigate = useNavigate({ from: "/metrics" });
  const [report, setReport] = useState<MetricsReport>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(latestOnly());
  const selectId = useId();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await latest.current.run(() => api.metrics(m));
      if (r === STALE) return;
      setReport(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [m]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  // 読み込みに失敗した後も、前に読めた範囲の一覧で選び直せる
  const scopes = report?.scopes ?? [{ scope: { kind: "project" as const }, label: "プロジェクト全体" }];
  const current = report && (report.scope.kind === "project" ? !m : report.scope.id === m) ? report : undefined;
  const recorded = current?.metrics.filter((x) => x.kind === "record") ?? [];
  const manual = current?.metrics.filter((x) => x.kind === "manual") ?? [];

  return (
    <div className="w-full space-y-6 px-4 pt-6 pb-10 sm:px-6 lg:px-8 lg:pt-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">開発の指標</h1>
        <p className="text-slate-500 dark:text-slate-400">
          記録から、要望の到達時間・受け入れ基準・手戻り・AI レビューの所見を出します。改善の振り返りの材料で、人や AI の成績の評価には使いません。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={selectId} className="flex min-w-0 flex-col gap-1">
          <span className="text-base font-medium text-slate-700 dark:text-slate-300">集計範囲</span>
          <select
            id={selectId}
            className={cx(inputCls, "max-w-full sm:w-72")}
            value={m ?? ""}
            onChange={(e) => void navigate({ search: { m: e.target.value || undefined } })}
          >
            {scopes.map((s) => (
              <option key={s.scope.kind === "project" ? "" : s.scope.id} value={s.scope.kind === "project" ? "" : s.scope.id}>
                {s.scope.kind === "project" ? s.label : `マイルストーン ${s.label}`}
              </option>
            ))}
            {m && !scopes.some((s) => s.scope.kind === "milestone" && s.scope.id === m) && <option value={m}>{m}（登録にありません）</option>}
          </select>
        </label>
        <button type="button" className={buttonCls("secondary")} onClick={() => void load()} aria-busy={loading}>
          {loading ? "読み込み中…" : "指標を読み込み直す"}
        </button>
      </div>

      {error && (
        <div role="alert" className="space-y-1 rounded-md bg-rose-50 p-3 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          <p className="break-words">指標を読み込めませんでした: {error}</p>
          <p className="flex flex-wrap gap-3">
            <Button variant="link" onClick={() => void load()}>
              もう一度
            </Button>
            {m && (
              <Link to="/metrics" search={{}} className="underline">
                プロジェクト全体を開く
              </Link>
            )}
          </p>
        </div>
      )}

      {!current ? (
        !error && <p className="text-slate-500">Loading…</p>
      ) : (
        <>
          <p className="break-words text-slate-600 dark:text-slate-400" data-testid="metrics-scope">
            <span className="font-medium text-slate-800 dark:text-slate-100">表示中: {current.scopeLabel}</span>（{current.scopeRule}）
          </p>
          {current.notices.length > 0 && (
            <ul aria-label="集計への知らせ" className="space-y-1">
              {current.notices.map((n) => (
                <li key={`${n.code}:${n.target}`} className="break-words text-amber-700 dark:text-amber-300">
                  ⚠ {n.message}
                </li>
              ))}
            </ul>
          )}
          <Section title="記録から数える指標">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {recorded.map((x) => (
                <MetricCard key={x.id} metric={x} />
              ))}
            </div>
          </Section>
          <Section title="人が記録する値">
            <p className="text-slate-600 dark:text-slate-400">費用やリリース後の不具合は記録から出せないので、人が CLI で記録します（画面では記録しません）。</p>
            {manual.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {manual.map((x) => (
                  <MetricCard key={x.id} metric={x} />
                ))}
              </div>
            ) : (
              <Empty>人が記録する指標はありません</Empty>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

const valueText = (x: MetricResult) => {
  if (x.kind === "manual" && x.rows?.length) return x.rows.length === 1 ? `${x.rows[0].value.toLocaleString()} ${x.rows[0].unit}` : `${x.rows.length} 行（期間・単位ごと）`;
  if (x.value === null) return METRIC_STATE_LABEL[x.state];
  const v = `${x.value.toLocaleString()} ${METRIC_UNIT_LABEL[x.unit]}`;
  return x.denominator !== undefined ? `${v} / 基準 ${x.denominator} 件` : v;
};

function MetricCard({ metric: x }: { metric: MetricResult }) {
  const headingId = useId();
  return (
    <article aria-labelledby={headingId} data-testid={`metric-${x.id}`} className="min-w-0 space-y-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="min-w-0 font-semibold break-words text-slate-800 dark:text-slate-100">
          {x.label}
        </h3>
        <Badge tone={STATE_TONE[x.state]}>{METRIC_STATE_LABEL[x.state]}</Badge>
      </div>
      <p className="text-2xl font-bold break-words" data-testid="metric-value">
        {valueText(x)}
      </p>
      {x.kind === "record" ? (
        <p className="text-base text-slate-600 dark:text-slate-400">
          対象 {x.targets}・値に入れた {x.observed}・欠損 {x.missing}
        </p>
      ) : (
        x.rows &&
        x.rows.length > 0 && (
          <ul aria-label={`${x.label}の記録`} className="space-y-1 text-base text-slate-700 dark:text-slate-300">
            {x.rows.map((r) => (
              <li key={r.id} className="break-words">
                <span className="font-mono text-sm text-slate-500">{r.id}</span> {r.from}〜{r.to}・{r.value.toLocaleString()} {r.unit}・出典: {r.source}
                {r.note ? `・メモ: ${r.note}` : ""}
                <span className="text-sm text-slate-500">（版 {r.rev}）</span>
              </li>
            ))}
          </ul>
        )
      )}
      {x.recordHint && (
        <details className="text-base">
          <summary className="cursor-pointer text-indigo-700 underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none dark:text-indigo-300">
            CLI での記録のしかた
          </summary>
          <code className="mt-1 block rounded bg-slate-100 p-2 text-sm break-all whitespace-pre-wrap dark:bg-slate-800">{x.recordHint}</code>
        </details>
      )}
      <details className="text-base">
        <summary className="cursor-pointer text-indigo-700 underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none dark:text-indigo-300">
          算出方法と内訳
        </summary>
        <dl className="mt-2 space-y-1 text-slate-700 dark:text-slate-300">
          <Def term="何から" value={x.source} />
          <Def term="対象" value={x.target} />
          <Def term="算出" value={x.method} />
          <Def term="欠損の扱い" value={x.missingRule} />
          <Def term="ID" value={x.id} />
        </dl>
        {x.breakdown.length > 0 && (
          <ul aria-label={`${x.label}の内訳`} className="mt-2 space-y-0.5 text-slate-700 dark:text-slate-300">
            {x.breakdown.map((b) => (
              <li key={b.key} className="break-words">
                {b.label}: {b.count}
              </li>
            ))}
          </ul>
        )}
        {x.missingItems.length > 0 && (
          <ul aria-label={`${x.label}の欠損`} className="mt-2 space-y-0.5 text-amber-800 dark:text-amber-300">
            {x.missingItems.slice(0, 20).map((mi) => (
              <li key={mi.target} className="break-words">
                欠損: <span className="font-mono text-sm">{mi.target}</span> {mi.reason}
              </li>
            ))}
            {x.missingItems.length > 20 && <li>ほか {x.missingItems.length - 20} 件（p3 metrics --json で全部）</li>}
          </ul>
        )}
      </details>
    </article>
  );
}

function Def({ term, value }: { term: string; value: string }) {
  return (
    <div className="break-words">
      <dt className="inline font-medium">{term}: </dt>
      <dd className="inline">{value}</dd>
    </div>
  );
}
