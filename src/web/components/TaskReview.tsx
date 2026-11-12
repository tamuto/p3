import { useCallback, useEffect, useRef, useState } from "react";
import { rerunSpec, TASK_REVIEW_SCOPE, TASK_REVIEW_VERDICT_LABELS, TASK_REVIEW_VERDICTS, type TaskReviewListItem, type TaskReviewVerdict } from "../../shared/taskReview.ts";
import type { Task } from "../../shared/types.ts";
import { api, ApiError, type TaskReviewDetailView, type TaskReviewPreview, type TaskReviewSpec } from "../lib/api.ts";
import { useAppData } from "../lib/appData.tsx";
import { fmtTime } from "../lib/format.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { useServerEvents } from "../lib/live.ts";
import { Badge, Button, Field, inputCls, type Tone } from "./ui.tsx";

/**
 * タスク詳細の「タスクの AI レビュー」（作業した側の証拠とは別の欄）。開始の前に材料（比較項目・比較対象の固定した SHA・観点の出典・
 * 注意）を確かめ、その hash で始める（変わっていれば確かめ直す）。履歴は run ごとに選んで読む。結果はタスクの状態・済みを変えない。
 * archived: アーカイブしたタスク（履歴を読むだけ）。unsaved: タスク詳細に保存していない入力がある（始めない）
 */

const STATUS_LABEL = { running: "実行中", completed: "完了", failed: "失敗", cancelled: "取消" } as const;
const VERDICT_TONE: Record<TaskReviewVerdict, Tone> = { satisfied: "emerald", missing: "rose", undetermined: "amber" };

type Ok = Extract<TaskReviewListItem, { state: "ok" }>;

const summary = (v: Partial<Record<TaskReviewVerdict, number>> | undefined) =>
  v ? TASK_REVIEW_VERDICTS.filter((k) => v[k]).map((k) => `${TASK_REVIEW_VERDICT_LABELS[k]} ${v[k]}`).join("・") : "";

function failureText(e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
  if (code === "changed") return "確かめた後で材料が変わりました。もう一度「材料を確かめる」を押してください";
  return (e as Error).message;
}

export function TaskReviewPanel({ task, archived = false, unsaved = false }: { task: Pick<Task, "id" | "request" | "ref" | "status">; archived?: boolean; unsaved?: boolean }) {
  const { tick } = useAppData();
  const rid = task.request;
  const tid = task.id;
  const [items, setItems] = useState<TaskReviewListItem[]>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskReviewDetailView>();
  const [current, setCurrent] = useState<{ run: string; hash?: string; error?: string }>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 開始の指定（比較対象・観点）と、確かめた材料
  const [targetsText, setTargetsText] = useState("");
  const [viewpoint, setViewpoint] = useState("builtin");
  const [viewpointFile, setViewpointFile] = useState("");
  const [consent, setConsent] = useState(false);
  const [checked, setChecked] = useState<TaskReviewPreview>();
  const latest = useRef(latestOnly());

  const load = useCallback(async () => {
    try {
      const r = await latest.current.run(() => api.taskReviews(rid, tid));
      if (r === STALE) return;
      setItems(r.items);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [rid, tid]);
  useEffect(() => {
    setSelected(null);
    setChecked(undefined);
    setDetail(undefined);
  }, [rid, tid]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  useServerEvents((e) => {
    if (e.type === "task-review" && e.request === rid && e.task === tid) void load();
  });

  const ok = (items ?? []).filter((x): x is Ok => x.state === "ok");
  const shownId = selected ?? ok[0]?.run.id ?? null;
  const shownItem = ok.find((x) => x.run.id === shownId);
  const status = shownItem?.run.status;

  // 選んだ run の詳細（実行中は状態が変わるたびに読み直す）
  useEffect(() => {
    if (!shownId) return setDetail(undefined);
    let live = true;
    api.taskReview(rid, tid, shownId).then(
      (d) => live && setDetail(d),
      (e: Error) => live && setMsg({ ok: false, text: `レビューを読めません: ${e.message}` }),
    );
    return () => {
      live = false;
    };
  }, [rid, tid, shownId, status, tick, items]);

  // 選んだ run と同じ指定で今の材料を取り出し、変わったかを比べる（読むだけ）
  const canStart = !archived && task.status === "done";
  useEffect(() => {
    if (!detail || detail.run.status === "running" || !canStart) return setCurrent(undefined);
    let live = true;
    const runId = detail.run.id;
    api.taskReviewPreview(rid, tid, rerunSpec(detail.input)).then(
      (p) => live && setCurrent({ run: runId, hash: p.hash }),
      (e: Error) => live && setCurrent({ run: runId, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [rid, tid, detail, canStart, tick]);

  const spec = (): TaskReviewSpec => {
    const targets = targetsText.split("\n").map((x) => x.trim()).filter(Boolean);
    const vp = viewpoint === "file" ? viewpointFile.trim() : viewpoint;
    return { ...(targets.length ? { targets } : {}), viewpoint: vp };
  };
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setChecked(undefined);
  };

  async function check(s: TaskReviewSpec = spec()) {
    setBusy(true);
    setMsg(null);
    try {
      setChecked(await api.taskReviewPreview(rid, tid, s));
    } catch (e) {
      setChecked(undefined);
      setMsg({ ok: false, text: `材料を取り出せません: ${failureText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!checked || unsaved) return;
    setBusy(true);
    setMsg(null);
    try {
      const run = await api.startTaskReview(rid, tid, { ...spec(), expectedHash: checked.hash, ...(checked.engineRequired ? { engine: "codex" as const } : {}) });
      setSelected(run.id);
      setChecked(undefined);
      setMsg({ ok: true, text: "レビューを始めました（新しい Codex のスレッド）" });
      void load();
    } catch (e) {
      if (e instanceof ApiError && (e.body as { code?: string } | null)?.code === "changed") setChecked(undefined);
      setMsg({ ok: false, text: `始められません: ${failureText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(acknowledgeStopped = false) {
    if (!shownId) return;
    try {
      const r = await api.cancelTaskReview(rid, tid, shownId, acknowledgeStopped);
      setMsg({ ok: true, text: r.requested ? "取消を頼みました（実行しているプロセスが止めます）" : "中断にしました" });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  /** 選んだ run と同じ指定で、今の材料でレビューし直す準備（確かめるところまで） */
  function prepareRerun() {
    if (!detail) return;
    const s = rerunSpec(detail.input);
    setTargetsText(s.targets.join("\n"));
    if (s.viewpoint === "builtin" || s.viewpoint === "project") setViewpoint(s.viewpoint);
    else {
      setViewpoint("file");
      setViewpointFile(s.viewpoint);
    }
    void check(s);
  }

  const changed = detail && current?.run === detail.run.id && current.hash !== undefined && current.hash !== detail.input.hash;
  const ranged = detail?.input.targets.some((t) => t.kind === "range");

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        要望・タスクの基準と成果物（固定したコミットの差分と前後のコード）を、作業したのとは別の Codex のスレッドが読むだけで照らし合わせます。
        作業した AI の能力や成績を採点するものではありません。結果でタスクの状態や「済み」は変わりません（済みは人が決めます）。
      </p>
      {loadError && <p role="alert" className="text-sm text-rose-600">履歴を読めません: {loadError}</p>}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-sm text-emerald-700 dark:text-emerald-400" : "text-sm break-words text-rose-600"}>
          {msg.text}
        </p>
      )}

      {/* 履歴 */}
      {items && items.length === 0 && <p className="text-sm text-slate-400">履歴: まだ実行していません</p>}
      {items && items.length > 0 && (
        <Field label="レビューの履歴">
          <select className={inputCls} value={shownId ?? ""} onChange={(e) => setSelected(e.target.value)}>
            {items.map((x) =>
              x.state === "broken" ? (
                <option key={x.id} value={x.id} disabled>
                  {x.id} 読めない記録
                </option>
              ) : (
                <option key={x.run.id} value={x.run.id}>
                  {fmtTime(x.run.startedAt)} {STATUS_LABEL[x.run.status]}
                  {x.verdicts ? `・${summary(x.verdicts)}` : ""}
                </option>
              ),
            )}
          </select>
        </Field>
      )}
      {items?.some((x) => x.state === "broken") && (
        <ul className="text-sm text-rose-600">
          {items.filter((x): x is Extract<TaskReviewListItem, { state: "broken" }> => x.state === "broken").map((x) => (
            <li key={x.id} className="break-words">
              読めない記録 {x.id}: {x.error}
            </li>
          ))}
        </ul>
      )}
      {detail && <RunView detail={detail} changed={!!changed} ranged={!!ranged} currentError={current?.run === detail.run.id ? current.error : undefined} onCancel={(ack) => void cancel(ack)} onRerun={canStart ? prepareRerun : undefined} />}

      {/* 開始 */}
      {archived ? (
        <p className="text-sm text-slate-500">アーカイブしたタスクは新しいレビューを始められません（過去の履歴は読めます）。</p>
      ) : task.status !== "done" ? (
        <p className="text-sm text-slate-500">レビューは完了したタスクだけ始められます。</p>
      ) : (
        <section aria-label="レビューを始める" className="space-y-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
          <h4 className="font-semibold">新しいレビュー</h4>
          <Field label="比較する対象（1行に1つ。空なら成果物のコミット）" hint="<参照先>:<コミット>[,<コミット>] か <参照先>:<base>..<head>。PR の URL は中身を取りに行かないので、取得済みの base..head を書きます">
            <textarea rows={2} className={`${inputCls} font-mono`} value={targetsText} disabled={busy} onChange={(e) => touch(setTargetsText)(e.target.value)} />
          </Field>
          <Field label="観点">
            <select className={inputCls} value={viewpoint} disabled={busy} onChange={(e) => touch(setViewpoint)(e.target.value)}>
              <option value="builtin">既定だけ</option>
              <option value="project">プロジェクトの設定（project.yaml の taskReview.viewpoints）</option>
              <option value="file">参照先の固定した SHA のファイル</option>
            </select>
          </Field>
          {viewpoint === "file" && (
            <Field label="観点のファイル" hint="<参照先>@<SHA>:<パス>（作業ブランチのファイルではなく、選んだ SHA の文面を使います）">
              <input className={`${inputCls} font-mono`} value={viewpointFile} disabled={busy} onChange={(e) => touch(setViewpointFile)(e.target.value)} />
            </Field>
          )}
          <Button type="button" disabled={busy} onClick={() => void check()}>
            材料を確かめる
          </Button>
          {checked && <PreviewView p={checked} />}
          {checked?.engineRequired && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>Codex で実行する（このプロジェクトの Preflight の担当は agent です。Codex を使うことを明示します。ChatGPT のプランを使います）</span>
            </label>
          )}
          {unsaved && <p className="text-sm text-amber-800 dark:text-amber-300">保存していない入力があります。保存してから材料を確かめて始めてください（保存した内容でレビューします）</p>}
          <Button type="button" variant="primary" disabled={busy || !checked || unsaved || (checked.engineRequired && !consent)} onClick={() => void start()}>
            新しい Codex のスレッドでレビューを始める
          </Button>
        </section>
      )}
    </div>
  );
}

function PreviewView({ p }: { p: TaskReviewPreview }) {
  return (
    <div className="space-y-2 text-sm">
      <p className="font-mono text-xs break-all text-slate-500">材料の hash {p.hash}</p>
      <div>
        <p className="font-medium">比較項目</p>
        <ul className="space-y-0.5">
          {p.items.map((i) => (
            <li key={i.id} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-mono text-slate-500">{i.id}</span>
              <span className="min-w-0 break-words">
                {i.text}
                {i.kind === "body" ? "（本文から）" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium">比較する対象（固定した SHA）</p>
        <ul className="space-y-0.5">
          {p.targets.map((t) => (
            <li key={`${t.repo}-${t.kind}`} className="min-w-0 break-words">
              <span className="font-mono">{t.repo}</span> {t.kind === "range" ? `${t.range!.baseSpec}..${t.range!.headSpec}（merge-base ${t.range!.mergeBase.slice(0, 12)} から ${t.range!.head.slice(0, 12)}）` : t.commits.map((c) => c.sha.slice(0, 12)).join(", ")}・変更 {t.changes} 件
              {t.commits.some((c) => c.otherTasks.length) && <span className="text-amber-700 dark:text-amber-400">（ほかのタスクのコミットを含みます）</span>}
            </li>
          ))}
        </ul>
      </div>
      <p>
        観点: {p.viewpoint.source === "file" ? `${p.viewpoint.repo}@${p.viewpoint.sha?.slice(0, 12)}:${p.viewpoint.path}` : p.viewpoint.source === "project" ? "プロジェクトの設定" : "既定だけ"}
      </p>
      {p.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-amber-800 dark:text-amber-300">
          {p.notes.map((n) => (
            <li key={`${n.code}-${n.target}`} className="break-words">
              {n.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunView({
  detail,
  changed,
  ranged,
  currentError,
  onCancel,
  onRerun,
}: {
  detail: TaskReviewDetailView;
  changed: boolean;
  ranged: boolean;
  currentError?: string;
  onCancel: (acknowledgeStopped?: boolean) => void;
  onRerun?: () => void;
}) {
  const { run, input, result } = detail;
  const text = new Map(input.items.map((i) => [i.id, i.text]));
  const unknownOwner = detail.owner && (detail.owner.state === "unknown" || detail.owner.state === "dead");
  return (
    <article aria-label={`レビュー ${run.id}`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={run.status === "completed" ? "emerald" : run.status === "running" ? "indigo" : "rose"}>{STATUS_LABEL[run.status]}</Badge>
        <span className="font-mono text-slate-500">{run.id}</span>
        <span className="text-slate-500">
          {fmtTime(run.startedAt)}
          {run.finishedAt ? ` 〜 ${fmtTime(run.finishedAt)}` : ""}・{run.engine}
          {run.model ? ` ${run.model}` : ""}
          {run.startedBy ? `・${run.startedBy}` : ""}
        </span>
      </div>
      {run.status === "running" && (
        <div className="space-y-2 text-sm">
          {run.log.slice(-3).map((l, i) => (
            <p key={`${l.at}-${i}`} className="break-words text-slate-500">
              {l.text.split("\n")[0]}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => onCancel()}>
              取り消す
            </Button>
            {unknownOwner && (
              <Button type="button" variant="ghost" onClick={() => onCancel(true)}>
                止まっていると確かめたので中断する
              </Button>
            )}
          </div>
          {unknownOwner && <p className="text-amber-800 dark:text-amber-300">実行しているプロセスを確かめられません（{"reason" in detail.owner! ? detail.owner.reason : ""}）。</p>}
        </div>
      )}
      {run.error && run.status !== "running" && <p className="text-sm break-words text-rose-600">{run.error}</p>}
      {changed && (
        <div role="status" className="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <p>材料が変わりました（本文・基準・証拠・比較対象・観点のどれか）。この結果は実行したときの材料に対するものです。</p>
          {onRerun && (
            <Button type="button" className="text-sm" onClick={onRerun}>
              今の材料でレビューし直す（確かめる）
            </Button>
          )}
        </div>
      )}
      {currentError && <p className="text-sm break-words text-slate-500">今の材料を取り出せません: {currentError}</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-300">実行したときの固定した材料・観点・差分の範囲</summary>
        <div className="mt-2 space-y-1">
          {input.targets.map((t) => (
            <p key={`${t.repo}-${t.kind}`} className="font-mono break-all">
              {t.repo}: {t.kind === "range" ? `${t.range!.base}..${t.range!.head}（${t.range!.baseSpec}..${t.range!.headSpec}）` : t.commits.map((c) => c.sha).join(", ")}
            </p>
          ))}
          {ranged && <p className="text-slate-500">範囲は実行したときの SHA に固定した評価です（ブランチがその後に進んでも、この結果は変わりません）。</p>}
          <p>
            観点: {input.viewpoint.source}
            {input.viewpoint.path ? `（${input.viewpoint.repo}@${input.viewpoint.sha}:${input.viewpoint.path}）` : ""}
          </p>
          <p>比較項目 {input.items.length} 件・ファイル {input.files.length} 件</p>
          {input.notes.map((n) => (
            <p key={`${n.code}-${n.target}`} className="break-words text-amber-800 dark:text-amber-300">
              {n.message}
            </p>
          ))}
        </div>
      </details>
      {result && (
        <div className="space-y-3">
          <p className="break-words">{result.overall}</p>
          <ul className="space-y-2">
            {result.items.map((i) => (
              <li key={i.item} aria-label={`判定 ${i.item}`} className="min-w-0 space-y-1 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                <p className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{i.item}</span>
                  <Badge tone={VERDICT_TONE[i.verdict]}>{TASK_REVIEW_VERDICT_LABELS[i.verdict]}</Badge>
                  <span className="min-w-0 break-words">{text.get(i.item)}</span>
                </p>
                <p className="break-words">{i.reason}</p>
                {i.evidence.length > 0 && <p className="font-mono text-sm break-all text-slate-500">根拠: {i.evidence.join(", ")}</p>}
                {i.gaps.map((g) => (
                  <p key={g} className="text-sm break-words text-rose-700 dark:text-rose-400">
                    不足: {g}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          <section className="space-y-1">
            <h4 className="font-semibold">意図しない変更の候補</h4>
            {result.unplanned.length ? (
              <ul className="list-disc space-y-0.5 pl-5">
                {result.unplanned.map((u) => (
                  <li key={u.text} className="break-words">
                    {u.text}
                    {u.evidence.length ? <span className="font-mono text-sm break-all text-slate-500">（{u.evidence.join(", ")}）</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">見つかっていません</p>
            )}
          </section>
          {result.checks.length > 0 && (
            <section className="space-y-1">
              <h4 className="font-semibold">人が確かめる点</h4>
              <ul className="list-disc space-y-0.5 pl-5">
                {result.checks.map((c) => (
                  <li key={c} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-sm break-words text-slate-500">読めた範囲: {result.coverage.read}</p>
          <p className="text-sm break-words text-slate-500">読めなかった範囲: {result.coverage.unread || "なし"}</p>
          <p className="text-sm text-slate-400">{TASK_REVIEW_SCOPE}</p>
        </div>
      )}
    </article>
  );
}
