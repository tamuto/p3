import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  REVIEW_STATUS_LABELS,
  REVIEW_VERDICT_LABELS,
  REVIEW_VERDICTS,
  type ReviewListItem,
  type ReviewRun,
  type ReviewVerdict,
} from "../../../shared/milestoneReview.ts";
import { api, type ReviewDetailView, type ReviewPreview } from "../../lib/api.ts";
import { useAppData } from "../../lib/appData.tsx";
import { fmtTime } from "../../lib/format.ts";
import { latestOnly, STALE } from "../../lib/latest.ts";
import { useServerEvents } from "../../lib/live.ts";
import { Button, cx } from "../ui.tsx";

/**
 * 1つのマイルストーンのレビュー（リリースノートの「マイルストーンレビュー」タブ）。規則（材料・判定・排他・回復）はサーバ
 * （core/milestoneReview）のもので、画面は見せて頼むだけ。
 *
 *   - 実行の前に、保存してある目的・予定機能と、所属する要望の件数・状態・範囲・警告を出す（マイルストーンのタブの書きかけは使わないと知らせる）
 *   - 最新の実行（実行中・失敗・取消）と、最後の成功結果を分けて出す。実行中・失敗の後も前の成功結果を読める
 *   - 履歴から選んだ run は URL（?run=）で開ける。読めない記録も隠さない。評価した後に材料が変わっていれば知らせ、もう一度実行できる
 *   - 所有者を確かめられない実行は、人が「止まっていることを確かめて中断」できる（記録を終えるだけ）
 *   - 結果は参考の記録で、ほかの操作（要望の完了・リリースノート）を止めない
 */
export function MilestoneReviewPanel({
  milestone,
  run,
  onSelectRun,
  milestonesDirty,
}: {
  milestone: string;
  run?: string;
  onSelectRun: (run: string | undefined) => void;
  milestonesDirty: boolean;
}) {
  const { tick } = useAppData();
  const [preview, setPreview] = useState<ReviewPreview>();
  const [items, setItems] = useState<ReviewListItem[]>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ReviewDetailView>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(latestOnly());

  const load = useCallback(async () => {
    try {
      const r = await latest.current.run(() => Promise.all([api.reviewPreview(milestone).catch(() => undefined), api.reviews(milestone)]));
      if (r === STALE) return;
      setPreview(r[0]);
      setItems(r[1].items);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [milestone]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  useServerEvents((e) => {
    if (e.type === "milestone-review" && e.milestone === milestone) void load();
  });

  const ok = (items ?? []).filter((x): x is Extract<ReviewListItem, { state: "ok" }> => x.state === "ok");
  const newest = ok[0];
  const lastDone = ok.find((x) => x.run.status === "completed");
  const shownId = run ?? lastDone?.run.id;
  const running = newest?.run.status === "running" ? newest : undefined;

  // 出す run の詳細（材料・結果）を読む。実行中の run は状態が変わるたびに読み直す
  const want = [shownId, running?.run.id].filter((x): x is string => !!x);
  const wantKey = `${want.join(",")}:${newest?.run.status ?? ""}:${tick}`;
  useEffect(() => {
    for (const id of want) {
      void api
        .review(milestone, id)
        .then((d) => setDetails((cur) => ({ ...cur, [id]: d })))
        .catch((e: Error) => setDetails((cur) => ({ ...cur, [id]: { error: e.message } })));
    }
    // want は wantKey にまとめている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [milestone, wantKey]);
  // 実行中は進み具合（ログ）を読み直す
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void api.review(milestone, running.run.id).then((d) => setDetails((cur) => ({ ...cur, [running.run.id]: d })), () => undefined);
    }, 1500);
    return () => clearInterval(t);
  }, [milestone, running]);

  if (!items)
    return loadError ? (
      <div className="space-y-2">
        <p role="alert" className="text-rose-600">
          読み込めませんでした: {loadError}
        </p>
        <Button onClick={() => void load()}>もう一度読み込む</Button>
      </div>
    ) : (
      <p className="text-slate-500">Loading…</p>
    );

  async function start() {
    setBusy(true);
    setMsg(null);
    try {
      await api.startReview(milestone);
      onSelectRun(undefined);
      void load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function cancel(id: string, acknowledgeStopped = false) {
    if (acknowledgeStopped && !window.confirm("実行しているプロセスが止まっていることを確かめましたか？ この実行の記録を中断にします（ほかの環境で動いているプロセスを止めるものではありません）")) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.cancelReview(milestone, id, acknowledgeStopped);
      setMsg({ ok: true, text: r.requested ? "取消を頼みました（実行しているプロセスが止めます）" : acknowledgeStopped ? "中断にしました" : "取り消しました" });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const noUnits = !!preview && !preview.units.length;
  const shown = shownId ? details[shownId] : undefined;
  const shownItem = ok.find((x) => x.run.id === shownId);
  const changed = !!preview && !!shownItem && shownItem.inputHash !== preview.hash;
  const runningDetail = running ? details[running.run.id] : undefined;
  const owner = runningDetail && "run" in runningDetail ? runningDetail.owner : undefined;
  const ownerUnknown = owner?.state === "unknown";

  return (
    <div className="min-w-0 space-y-6">
      <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-900 dark:text-slate-300">
        保存してある目的・予定機能と、このマイルストーンに属する要望・タスクの記録を比べた参考の記録です。リリースするかは人が読んで決めます
        （レビューをしなくても、要望の完了やリリースノートの操作はできます）。
      </p>

      <section aria-labelledby="rv-target" className="space-y-3">
        <h3 id="rv-target" className="text-lg font-semibold">
          評価する内容
        </h3>
        {milestonesDirty && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
            ⚠ 「マイルストーン」タブに保存していない変更があります。レビューは保存した目的・予定機能で行います。
          </p>
        )}
        {preview ? (
          <>
            <Purpose text={preview.milestone.purpose} />
            <div>
              <p className="text-sm font-medium">予定している機能・目標</p>
              {preview.milestone.goals?.length ? (
                <ul className="mt-1 space-y-1 text-sm">
                  {preview.milestone.goals.map((g) => (
                    <li key={g.id} className="break-words">
                      <span className="mr-2 font-mono text-slate-500">{g.id}</span>
                      {g.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-500">（なし{preview.milestone.purpose ? "。目的そのものを評価します" : ""}）</p>
              )}
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              所属する要望 {preview.requests} 件
              {preview.requests > 0 && `（${Object.entries(preview.statuses).map(([s, n]) => `${STATUS_JA[s] ?? s} ${n}`).join("・")}）`}
              {preview.context > 0 && `・別のマイルストーンの親子 ${preview.context} 件（文脈として渡し、成果に数えません）`}
            </p>
            {preview.warnings.length > 0 && (
              <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-300">
                {preview.warnings.map((w) => (
                  <li key={`${w.code}:${w.target}`}>⚠ {w.message}</li>
                ))}
              </ul>
            )}
            <p className="text-sm text-slate-500 dark:text-slate-400">範囲: {preview.scope}</p>
          </>
        ) : (
          <p className="text-sm text-amber-700 dark:text-amber-300">このマイルストーンは project.yaml にありません（過去の記録だけを読めます）。</p>
        )}
        <p className="text-sm">
          <Link to="/release-notes" search={{ m: milestone, tab: "milestones" }} className="underline">
            目的・予定機能を書く・直す（「マイルストーン」タブ）
          </Link>
        </p>
        {noUnits && (
          <p role="status" className="rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            目的も予定機能もまだありません。「マイルストーン」タブで行の「目的・予定機能」を開いて書き、保存してから実行してください。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          {!running && preview && (
            <Button variant="primary" disabled={busy || noUnits} onClick={() => void start()}>
              {ok.length ? "もう一度実行" : "レビューを実行"}
            </Button>
          )}
          {running && !ownerUnknown && (
            <Button disabled={busy} onClick={() => void cancel(running.run.id)}>
              取消
            </Button>
          )}
          {msg && (
            <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-emerald-600" : "text-rose-600"}>
              {msg.text}
            </span>
          )}
        </div>
      </section>

      {newest && newest.run.status !== "completed" && (
        <section aria-labelledby="rv-latest" className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <h3 id="rv-latest" className="font-semibold">
            最新の実行: {REVIEW_STATUS_LABELS[newest.run.status]}
            <span className="ml-2 text-sm font-normal text-slate-500">{fmtTime(newest.run.startedAt)}</span>
          </h3>
          {newest.run.status === "running" && (
            <>
              <p role="status" className="text-slate-600 dark:text-slate-300">
                実行中です（Codex に頼んでいます）。終わると結果がここに出ます。
              </p>
              {ownerUnknown && owner && "reason" in owner && (
                <div className="space-y-2 rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  <p>実行しているプロセスを確かめられません（{owner.reason}）。止まっていると確かめたら、この実行を中断にできます。</p>
                  <p className="text-sm">中断は記録を終えるだけで、ほかの環境で動いているプロセスを止めるとは限りません。</p>
                  <Button disabled={busy} onClick={() => void cancel(newest.run.id, true)}>
                    止まっていることを確かめて中断
                  </Button>
                </div>
              )}
              {runningDetail && "run" in runningDetail && runningDetail.run.log.length > 0 && (
                <ol className="max-h-40 overflow-y-auto font-mono text-xs text-slate-500" aria-label="進み具合">
                  {runningDetail.run.log.map((l, i) => (
                    <li key={i}>{l.text}</li>
                  ))}
                </ol>
              )}
            </>
          )}
          {newest.run.status !== "running" && (
            <p className="text-rose-600">
              {newest.run.error ?? REVIEW_STATUS_LABELS[newest.run.status]}
              {lastDone && "（前の成功結果は下で読めます）"}
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="rv-result" className="space-y-3">
        <h3 id="rv-result" className="text-lg font-semibold">
          {run ? "選んだ記録" : "最後の成功結果"}
          {shownItem && <span className="ml-2 text-sm font-normal text-slate-500">{fmtTime(shownItem.run.startedAt)}</span>}
        </h3>
        {run && (
          <button type="button" className="text-sm underline" onClick={() => onSelectRun(undefined)}>
            最後の成功結果に戻る
          </button>
        )}
        {!shownId ? (
          <p className="text-slate-500">まだ成功した記録はありません。</p>
        ) : !shown ? (
          <p className="text-slate-500">Loading…</p>
        ) : "error" in shown ? (
          <p role="alert" className="text-rose-600">
            記録を読めません: {shown.error}
          </p>
        ) : (
          <ReviewResultView detail={shown} changed={changed} canRerun={!running && !noUnits && !!preview} onRerun={() => void start()} busy={busy} />
        )}
      </section>

      <section aria-labelledby="rv-history" className="space-y-2">
        <h3 id="rv-history" className="text-lg font-semibold">
          履歴
        </h3>
        {!items.length ? (
          <p className="text-slate-500">まだ実行していません。</p>
        ) : (
          <ul className="space-y-1" aria-label="レビューの履歴">
            {items.map((x) =>
              x.state === "broken" ? (
                <li key={x.id} className="text-sm text-rose-600 break-words">
                  ⚠ 読めない記録 <span className="font-mono">{x.id}</span>: {x.error}
                </li>
              ) : (
                <li key={x.run.id}>
                  <button
                    type="button"
                    aria-current={x.run.id === shownId ? "true" : undefined}
                    onClick={() => onSelectRun(x.run.id)}
                    className={cx(
                      "w-full rounded-md px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none",
                      x.run.id === shownId ? "bg-indigo-50 dark:bg-indigo-950" : "hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                  >
                    <span className="mr-2">{fmtTime(x.run.startedAt)}</span>
                    <span className="mr-2 font-medium">{REVIEW_STATUS_LABELS[x.run.status]}</span>
                    {x.verdicts && <span className="mr-2 text-slate-500">{verdictSummary(x.verdicts)}</span>}
                    {preview && x.inputHash !== preview.hash && x.run.status === "completed" && <span className="text-amber-700 dark:text-amber-300">評価の後に材料が変わっています</span>}
                    <span className="block text-xs text-slate-500 break-words">
                      評価した目的・予定機能: {x.purpose ? `${x.purpose.split("\n")[0]} / ` : ""}
                      {x.units.map((u) => u.id).join(", ")}
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

const STATUS_JA: Record<string, string> = { draft: "下書き", active: "進行中", resolved: "対応済", done: "完了済", rejected: "見送り" };

const verdictSummary = (v: Partial<Record<ReviewVerdict, number>>) =>
  REVIEW_VERDICTS.filter((k) => v[k])
    .map((k) => `${REVIEW_VERDICT_LABELS[k]} ${v[k]}`)
    .join("・");

const VERDICT_CLS: Record<ReviewVerdict, string> = {
  achieved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  not_achieved: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  insufficient: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

function Purpose({ text }: { text?: string }) {
  return (
    <div>
      <p className="text-sm font-medium">目的</p>
      {text ? <p className="mt-1 text-sm whitespace-pre-wrap break-words">{text}</p> : <p className="mt-1 text-sm text-slate-500">（なし）</p>}
    </div>
  );
}

/** 根拠の参照（要望 ID・<要望ID>/T001）を今の要望・タスクへのリンクにする（消されていれば開いた先で「無い」と出る） */
function RefLink({ r }: { r: string }) {
  const [rid, tid] = r.split("/");
  return tid ? (
    <Link to="/" search={{ task: r }} className="font-mono underline">
      {r}
    </Link>
  ) : (
    <Link to="/requests/$requestId" params={{ requestId: rid }} className="font-mono underline">
      {r}
    </Link>
  );
}

function ReviewResultView({ detail, changed, canRerun, onRerun, busy }: { detail: Extract<ReviewDetailView, { run: ReviewRun }>; changed: boolean; canRerun: boolean; onRerun: () => void; busy: boolean }) {
  const { input, result } = detail;
  if (!result) return <p className="text-slate-500">結果がありません（{REVIEW_STATUS_LABELS[detail.run.status]}）。</p>;
  const text = new Map(input?.units.map((u) => [u.id, u.text]));
  return (
    <div className="space-y-4">
      {changed && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          評価した後に、目的・予定機能か要望・タスクが変わっています（この記録は評価したときの材料のままです）。
          {canRerun && (
            <Button disabled={busy} onClick={onRerun}>
              今の内容でもう一度実行
            </Button>
          )}
        </div>
      )}
      <div>
        <p className="text-sm font-medium">全体の所見</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{result.overall}</p>
      </div>
      <ul className="space-y-3" aria-label="比較単位ごとの判定">
        {result.units.map((u) => (
          <li key={u.unit} className="space-y-1 rounded-md border border-slate-200 p-3 dark:border-slate-800">
            <p className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-sm text-slate-500">{u.unit === "purpose" ? "目的" : u.unit}</span>
              <span className={cx("rounded px-2 py-0.5 text-sm font-medium", VERDICT_CLS[u.verdict])}>{REVIEW_VERDICT_LABELS[u.verdict]}</span>
              <span className="min-w-0 break-words">{(text.get(u.unit) ?? "").split("\n")[0]}</span>
            </p>
            <p className="text-sm break-words">
              <span className="text-slate-500">理由: </span>
              {u.reason}
            </p>
            {u.evidence.length > 0 && (
              <p className="flex flex-wrap gap-x-2 text-sm">
                <span className="text-slate-500">根拠:</span>
                {u.evidence.map((r) => (
                  <RefLink key={r} r={r} />
                ))}
              </p>
            )}
            {u.gaps.length > 0 && (
              <ul className="list-disc pl-5 text-sm">
                {u.gaps.map((g, i) => (
                  <li key={i} className="break-words">
                    {g}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-500 dark:text-slate-400">範囲: {result.scope}</p>
      {input && (
        <details className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer text-sm font-medium">評価したときの材料（目的・予定機能・要望の文面）</summary>
          <div className="mt-3 max-h-96 space-y-3 overflow-y-auto text-sm">
            <Purpose text={input.milestone.purpose} />
            {input.units.length > 0 && (
              <ul>
                {input.units.map((u) => (
                  <li key={u.id}>
                    <span className="mr-2 font-mono text-slate-500">{u.id}</span>
                    {u.text}
                  </li>
                ))}
              </ul>
            )}
            {input.requests.map((r) => (
              <div key={r.id} className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
                <p className="font-medium break-words">
                  <span className="font-mono text-slate-500">{r.id}</span> {r.title}（{STATUS_JA[r.status] ?? r.status}）
                </p>
                {r.body && <p className="whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">{r.body}</p>}
                {r.tasks.map((t) => (
                  <div key={t.ref} className="pl-3">
                    <p className="break-words">
                      <span className="font-mono text-slate-500">{t.id}</span> {t.title}（{t.status}）
                    </p>
                    {t.record && <p className="whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">{t.record}</p>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
