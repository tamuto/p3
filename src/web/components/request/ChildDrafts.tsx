import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SPLIT_HINT_TASKS } from "../../../shared/hierarchy.ts";
import type { AdoptionResult, ProposedChild, Request } from "../../../shared/types.ts";
import { api, ApiError, failureOf, type RunInfo } from "../../lib/api.ts";
import { type AppCtx } from "../../lib/appCtx.ts";
import { adoptBlocker, adoptionSummary, editConflict, editDirty, editOf, type ChildEdit } from "../../lib/childDrafts.ts";
import { Markdown } from "../Markdown.tsx";
import { Badge, Button, buttonCls, cx, inputCls, Section } from "../ui.tsx";

/**
 * 分割の run の子の要望の案のレビューと採用（docs/architecture.md の「Preflight の分割の案」）。
 *   - 分割の判断（理由・想定のタスク数）と、各案の目的・範囲・完了条件・前提・既存のタスクとの重なりを見せる（詳細は開閉）
 *   - 題・本文・採否を直せる。未保存の編集・競合・古い評価・案の問題・0件・実行中は採用しない
 *   - 確認で「親は残す・子だけ作る・子の Preflight はまだ」と示してから作る。途中で失敗したら作った子へのリンクと続きを出す
 *   - 応答は、頼んだときの run を今も表示しているときだけ使う（run を切り替えた後の古い応答で上書きしない）
 */
export function ChildDrafts({
  ctx,
  request,
  run,
  onChanged,
  blocked,
}: {
  ctx: AppCtx;
  request: Request;
  run: RunInfo;
  onChanged: (update: RunInfo | ((cur: RunInfo) => RunInfo)) => void;
  /** 採用を止める理由（未保存のタイトル・本文） */
  blocked: string | null;
}) {
  const children = run.children ?? [];
  const a = run.assessment;
  const runRef = useRef(run.id);
  runRef.current = run.id;
  const [edits, setEdits] = useState<Record<string, ChildEdit>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ version?: string; problems?: string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [result, setResult] = useState<AdoptionResult | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // run を替えたら、編集・確認・結果は持ち越さない
  useEffect(() => {
    setEdits({});
    setConfirming(false);
    setResult(null);
    setError(null);
  }, [request.id, run.id]);

  // 確認（案の版・問題）。採否・題を変えたら・外で変わったら読み直す
  const sig = children.map((c) => `${c.key}:${c.include}:${c.title}`).join(",");
  useEffect(() => {
    const runId = run.id;
    void api.previewMaterialize(request.id, runId).then(
      (p) => runRef.current === runId && setPreview({ version: p.version, problems: p.problems }),
      () => runRef.current === runId && setPreview(null),
    );
  }, [request.id, run.id, sig, ctx.tick]);

  const put = (runId: string, next: ProposedChild) =>
    onChanged((cur) => (cur.id === runId ? { ...cur, children: (cur.children ?? []).map((x) => (x.key === next.key ? next : x)) } : cur));

  async function patch(c: ProposedChild, p: Partial<ProposedChild>) {
    const runId = run.id;
    try {
      const next = await api.patchChild(request.id, runId, c.key, p);
      if (runRef.current !== runId) return;
      setError(null);
      put(runId, next);
    } catch (e) {
      if (runRef.current === runId) setError((e as Error).message);
    }
  }

  async function saveEdit(c: ProposedChild) {
    const e = edits[c.key];
    if (!e || editConflict(e, c)) return;
    const runId = run.id;
    setSaving(c.key);
    try {
      const next = await api.patchChild(request.id, runId, c.key, { title: e.title, description: e.description, expectedTitle: e.base });
      if (runRef.current !== runId) return;
      put(runId, next);
      setEdits(({ [c.key]: _, ...rest }) => rest);
      setError(null);
    } catch (err) {
      if (runRef.current !== runId) return;
      const current = err instanceof ApiError && err.status === 409 ? (err.body as { current?: ProposedChild } | null)?.current : undefined;
      if (current) put(runId, current);
      setError(current ? `${c.key} の題が他で変わりました。入力は残してあります（最新を確かめて、取り消すか直してください）` : `保存できませんでした: ${(err as Error).message}（入力は残してあります）`);
    } finally {
      setSaving(null);
    }
  }

  const stopped = adoptBlocker(run, { edits, busy, blocked, problems: preview?.problems });
  const selected = run.adoption ? children.filter((c) => run.adoption!.keys.includes(c.key)) : children.filter((c) => c.include);
  const resuming = !!run.adoption && !run.adoption.done;

  // 確認を開いたら確認の欄へ、取り消したら開いたボタンへフォーカスを移す（ボタンは描き直した後にある）
  const returnFocus = useRef(false);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      openerRef.current?.focus();
    }
  }, [confirming]);
  const cancelConfirm = () => {
    returnFocus.current = true;
    setConfirming(false);
  };

  async function adopt() {
    // 二重送信しない
    if (busyRef.current || stopped) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const runId = run.id;
    try {
      const r = await api.adopt(request.id, runId, resuming ? undefined : preview?.version);
      if (runRef.current !== runId) return;
      setResult(r);
      setConfirming(false);
      onChanged(await api.run(request.id, runId));
      ctx.reload();
    } catch (e) {
      if (runRef.current !== runId) return;
      const code = e instanceof ApiError ? (e.body as { code?: string } | null)?.code : undefined;
      setError(
        failureOf(e) === "stale_input"
          ? `${(e as Error).message}`
          : code === "drafts_changed"
            ? "確認したあとで子の案が変わりました。何も作っていません。内容を確かめて、もう一度確認してください"
            : code === "hierarchy_busy"
              ? "ほかの操作が要望の親子を変えています。何も作っていません。少し待ってもう一度押してください"
              : (e as Error).message,
      );
      setConfirming(false);
      void api.run(request.id, runId).then((x) => runRef.current === runId && onChanged(x), () => undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const created = run.adoption ? run.adoption.created.map((k) => ({ key: k, id: run.adoption!.reserved[k] })) : [];
  const title = (key: string) => children.find((c) => c.key === key)?.title ?? key;

  return (
    <Section
      title={`子の要望への分割案 (${children.filter((c) => c.include).length}/${children.length} 件を採用)`}
      aside={<span className="min-w-0 font-mono text-sm break-all text-slate-400">requests/{request.id}/preflight/{run.id}/children/*.md</span>}
    >
      <div className="space-y-2 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
        <p className="font-medium break-words">
          {a?.split?.decision === "keep" ? "分けない判断です" : "子の要望に分けることを提案しています"}
          {a?.split?.estimatedTasks !== undefined && `（想定 ${a.split.estimatedTasks} タスク）`}
        </p>
        {!!a?.split?.reasons.length && (
          <ul className="list-disc space-y-0.5 pl-5 break-words text-slate-600 dark:text-slate-400">
            {a.split.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p className="text-sm text-slate-500">
          {SPLIT_HINT_TASKS} タスク以上は分けるかを検討する目安です。小さい変更ではフロントエンドとバックエンドを一緒に扱います。
        </p>
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
          親の既存のタスク・履歴・添付は親に残ります（重なりは各案に出ます）。子を作っても、子の Preflight はまだ実行されません。
        </p>
      </div>

      <ul className="space-y-3">
        {children.map((c) => {
          const e = edits[c.key];
          const conflict = editConflict(e, c);
          const locked = !!run.adoption;
          return (
            <li key={c.key} className={cx("min-w-0 space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800", !c.include && !locked && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`${c.key} を採用`}
                    checked={locked ? run.adoption!.keys.includes(c.key) : c.include}
                    disabled={locked || busy}
                    onChange={(ev) => void patch(c, { include: ev.target.checked })}
                  />
                  <span className="font-mono text-sm text-slate-500">{c.key}</span>
                </label>
                {c.estimatedTasks !== undefined && <Badge>想定 {c.estimatedTasks} タスク</Badge>}
                {c.requires.length > 0 && <Badge tone="indigo">前提 {c.requires.join(", ")}</Badge>}
                {c.overlaps.length > 0 && (
                  <Badge tone="amber" title="親の既存のタスクと重なりうる">
                    重なり {c.overlaps.join(", ")}
                  </Badge>
                )}
                {run.adoption?.reserved[c.key] && run.adoption.created.includes(c.key) && <Badge tone="emerald">作成済み {run.adoption.reserved[c.key]}</Badge>}
              </div>
              {e ? (
                <div className="space-y-2">
                  <label className="block space-y-1">
                    <span className="text-sm text-slate-500">題</span>
                    <input className={inputCls} aria-label={`${c.key} の題`} value={e.title} onChange={(ev) => setEdits({ ...edits, [c.key]: { ...e, title: ev.target.value } })} />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-slate-500">目的・範囲・範囲外・完了条件・分割の理由・前提・出典</span>
                    <textarea
                      rows={10}
                      className={`${inputCls} font-mono text-sm`}
                      aria-label={`${c.key} の本文`}
                      value={e.description}
                      onChange={(ev) => setEdits({ ...edits, [c.key]: { ...e, description: ev.target.value } })}
                    />
                  </label>
                  {conflict && (
                    <p role="status" className="rounded-md bg-amber-50 px-2 py-1.5 text-sm break-words text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      編集中に題が他で変わりました（最新: {c.title}）。入力はそのままです。このままでは保存しません。
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" disabled={conflict || saving === c.key || !editDirty(e, c)} onClick={() => void saveEdit(c)}>
                      {saving === c.key ? "保存中…" : "変更を保存"}
                    </Button>
                    <Button onClick={() => setEdits(({ [c.key]: _, ...rest }) => rest)}>{editDirty(e, c) ? "編集を取り消す" : "閉じる"}</Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="font-medium break-words">{c.title}</p>
                  <details className="group">
                    <summary className="cursor-pointer text-sm text-indigo-600 underline">目的・範囲・完了条件・前提を見る</summary>
                    <div className="mt-2 min-w-0 break-words">
                      <Markdown text={c.description} />
                    </div>
                  </details>
                  {!locked && (
                    <Button className="text-sm" onClick={() => setEdits({ ...edits, [c.key]: editOf(c) })}>
                      題・本文を直す
                    </Button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {!!preview?.problems?.length && (
        <div role="status" className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900">
          <p className="font-medium">子の案に問題があります（採用しません）</p>
          <ul className="list-disc pl-5 break-words">
            {preview.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {(result || created.length > 0) && (
        <div role="status" className="space-y-2 rounded-md bg-emerald-50 px-3 py-2 dark:bg-emerald-950/40">
          {result && <p className="break-words">{adoptionSummary(result)}</p>}
          {!result && run.adoption?.done && <p>この評価から子の要望を作成しました。子ごとに Preflight を実行してください。</p>}
          <ul className="space-y-1">
            {(result?.created ?? created).map((c) => (
              <li key={c.key} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-slate-500">{c.key}</span>
                <Link to="/requests/$requestId" params={{ requestId: c.id }} className={buttonCls("ghost", "min-w-0 break-all underline")}>
                  {c.id}
                </Link>
                <span className="min-w-0 break-words">{title(c.key)}</span>
              </li>
            ))}
          </ul>
          {result?.failed.map((f) => (
            <p key={f.key} className="break-words text-rose-700 dark:text-rose-300">
              {f.key}: {f.error}
            </p>
          ))}
        </div>
      )}

      {!run.adoption?.done && (
        <div className="space-y-2 pt-2">
          {confirming ? (
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="group"
              aria-label="採用の確認"
              className="space-y-2 rounded-lg bg-white p-4 ring-2 ring-indigo-500 focus:outline-none dark:bg-slate-900"
              onKeyDown={(ev) => {
                if (ev.key === "Escape") cancelConfirm();
              }}
            >
              <p className="font-medium">子の要望を {selected.length} 件作成します</p>
              <ul className="list-disc pl-5 break-words">
                {selected.map((c) => (
                  <li key={c.key}>
                    <span className="mr-1 font-mono text-sm text-slate-500">{c.key}</span>
                    {c.title}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                親 {request.id} は残します（既存のタスク・履歴もそのまま）。子の要望だけを下書きで作り、期限・マイルストーン・タグを親から写します。子の
                Preflight はまだ実行しません（子ごとに明示して実行します）。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={!!stopped} onClick={() => void adopt()}>
                  {busy ? "作成中…" : resuming ? "続きを作る" : `子の要望を ${selected.length} 件作成`}
                </Button>
                <Button disabled={busy} onClick={cancelConfirm}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button ref={openerRef} variant="primary" disabled={!!stopped} onClick={() => setConfirming(true)}>
                {resuming ? "続きを作る（確認）" : "採用内容を確認"}
              </Button>
              <span className={cx("break-words", stopped ? "text-amber-700 dark:text-amber-400" : "text-slate-500")}>
                {stopped ?? "確認の欄で作成する子と親の扱いを確かめてから作成します。取消では何も保存しません。"}
              </span>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-rose-600">
          {error}
        </p>
      )}
    </Section>
  );
}
