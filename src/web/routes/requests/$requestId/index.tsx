import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type PreflightRun, type RunPulse } from "../../../../shared/types.ts";
import { Badge, Button, cx } from "../../../components/ui.tsx";
import { runAction } from "../../../lib/action.ts";
import { api, type RunInfo } from "../../../lib/api.ts";
import { notesPanelState, PLAIN_RUN_BLOCKED } from "../../../lib/notes.ts";
import { useAppCtx, type AppCtx } from "../../../lib/appCtx.ts";
import { useRequestData, type RequestData } from "../../../lib/requestData.tsx";
import { useServerEvents } from "../../../lib/live.ts";
import { useEngineStatus } from "../../../lib/engineStatus.ts";
import { optionalString } from "../../../lib/search.ts";
import { AttachmentsPanel } from "../../../components/Attachments.tsx";
import { isDirty, sameBody } from "../../../lib/draft.ts";
import { UNSAVED_BLOCKED, unsavedFields } from "../../../lib/requestEdit.ts";
import { RunView } from "../../../components/request/RunView.tsx";
import { Notes } from "../../../components/request/Notes.tsx";
import { RequestMeta } from "../../../components/request/RequestMeta.tsx";
import { BodyEditor } from "../../../components/request/BodyEditor.tsx";
import { useRequestDrafts } from "../../../lib/requestDrafts.ts";
import { latestOnly, STALE } from "../../../lib/latest.ts";
import { createPulsePoller, latestNotice, shownRunChanged } from "../../../lib/preflightWatch.ts";
import { PreflightNotice } from "../../../components/request/PreflightNotice.tsx";


/** 要望の概要と Preflight。?run= で表示する preflight を選ぶ（省くと最新） */
export const Route = createFileRoute("/requests/$requestId/")({
  validateSearch: (s: Record<string, unknown>): { run?: string } => ({ run: optionalString(s.run) }),
  component: RequestPage,
});

function RequestPage() {
  const ctx = useAppCtx();
  const data = useRequestData();
  const { run } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <RequestPanel
      key={data.request.id}
      ctx={ctx}
      data={data}
      runId={run}
      onRunChange={(id) => void navigate({ search: (prev) => ({ ...prev, run: id }) })}
    />
  );
}

/**
 * 要望の詳細。表示する preflight の run は URL（?run=）で選ぶ。無ければ開いたときの最新で、そのあと新しい run ができても
 * 表示は変えずに知らせる（lib/preflightWatch.ts）。切り替えるのは人の操作（知らせの「開く」・履歴の選択・自分で実行）だけ
 */
function RequestPanel({
  ctx,
  data,
  runId: selectedRun,
  onRunChange: setRunId,
}: {
  ctx: AppCtx;
  data: RequestData;
  runId?: string;
  onRunChange: (runId: string) => void;
}) {
  const { request, runs } = data;
  // 表示する run。?run= が変わったとき（選んだ・戻る/進む）だけ決め直す。?run= が無ければ、その時点の最新に留める
  const [pin, setPin] = useState(() => ({ selected: selectedRun, shown: selectedRun ?? request.lastPreflight ?? null }));
  if (pin.selected !== selectedRun) setPin({ selected: selectedRun, shown: selectedRun ?? request.lastPreflight ?? null });
  const runId = pin.shown;
  const [run, setRun] = useState<RunInfo>();
  // run の取得は最後に頼んだものだけを使い、今表示している run のものでなければ捨てる（応答の逆転・移動のあとの応答）
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const runRef = useRef(run);
  runRef.current = run;
  const runFetch = useRef(latestOnly());
  const loadRun = (id: string) =>
    void runFetch.current.run(() => api.run(request.id, id)).then(
      (r) => {
        if (r !== STALE && r.id === runIdRef.current) setRun(r);
      },
      () => undefined,
    );
  const drafts = useRequestDrafts(request);
  // 本文は「本文を編集」で開いたときだけ入力欄にする（ぼかしただけでは保存しない）
  const [editingBody, setEditingBody] = useState(false);
  // 未保存のタイトル・本文がある間は、Preflight の開始とタスク化を止める（保存していない内容は評価にもタスクにも渡らない）
  const unsaved = unsavedFields({ title: isDirty(drafts.titleD), body: editingBody && isDirty(drafts.bodyD, sameBody) });
  const blocked = unsaved.length ? UNSAVED_BLOCKED : null;
  const [error, setError] = useState<string | null>(null);
  // 個人設定を直したら、取り直したとき（タブに戻った・「再読み込み」など）に反映する
  const engine = useEngineStatus(ctx.tick);

  useEffect(() => {
    if (!runId) {
      runFetch.current.cancel();
      return setRun(undefined);
    }
    // 取れなければ前の表示のまま（要望が消えた・通信の失敗は要望の枠が知らせる）
    loadRun(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, request.id, ctx.tick]);

  // 最新の Preflight を、開いている間だけ軽く確かめる（外で始めた run・その進みと終わりを、監視や SSE に頼らずに見つける）
  const [latest, setLatest] = useState<RunPulse | null>(null);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const knownAtOpen = useRef(new Set<string>([...runs.map((r) => r.id), ...(request.lastPreflight ? [request.lastPreflight] : [])]));
  const poller = useRef<ReturnType<typeof createPulsePoller> | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    const fetchPulse = latestOnly();
    let lastLatest: string | null | undefined;
    let lastVersion: { id: string; version?: string } | undefined;
    const p = createPulsePoller({
      check: async () => {
        const shown = runIdRef.current;
        try {
          const r = await fetchPulse.run(() => api.preflightStatus(request.id, shown ?? undefined));
          if (r === STALE) return;
          setPulseError(null);
          if (r.state !== "ok") {
            // 消えた・読めない: 要望の枠の扱い（gone・読めない）に任せる
            if (!dataRef.current.gone) dataRef.current.reload();
            return;
          }
          setLatest(r.latest);
          // 新しい run ができたら履歴（選択肢）を取り直す。表示中の run と入力は変えない
          if (lastLatest !== undefined && r.latest?.id !== lastLatest) dataRef.current.reload();
          lastLatest = r.latest?.id ?? null;
          // 表示中の run が外で進んだ・終わった（版か状態が変わった）なら取り直す
          const mine = r.run;
          if (shownRunChanged(mine, runIdRef.current, lastVersion, runRef.current)) loadRun(mine!.id);
          if (mine?.state === "ready") lastVersion = { id: mine.id, version: mine.version };
        } catch (e) {
          setPulseError((e as Error).message);
        }
      },
    });
    poller.current = p;
    const onVisibility = () => (document.hidden ? p.pause() : p.resume());
    if (document.hidden) p.pause();
    document.addEventListener("visibilitychange", onVisibility);
    p.start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      p.stop();
      fetchPulse.cancel();
      poller.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id]);
  // 表示する run を替えたら、その run の状態もすぐ確かめる
  useEffect(() => poller.current?.now(), [runId]);
  const notice = latestNotice(runId, latest, knownAtOpen.current);

  // ログはストリームで追記。状態の変化は SSE が速い経路（確かめも今すぐ1回）
  useServerEvents((e) => {
    if (e.type === "preflight-log" && e.runId === runId) {
      setRun((r) => (r ? { ...r, log: [...r.log, e.entry] } : r));
    } else if (e.type === "preflight-status") {
      if (e.runId === runId) {
        loadRun(runId);
        data.reload();
      }
      poller.current?.now();
    }
  });

  function started(r: PreflightRun) {
    setRun(r);
    setRunId(r.id);
    ctx.reload();
  }

  async function start() {
    setError(null);
    try {
      started(await api.startPreflight(request.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const running = run?.status === "running";
  // メモ欄の入力は要望のページにいる間ずっと持つ（run を替えたり実行を始めたりしても消えない）
  const [draft, setDraft] = useState("");
  // 一度でも実行したか（開始した直後、履歴を読み直す前も含める）
  const hasHistory = runs.length > 0 || !!run;
  const notesState = notesPanelState({ hasHistory, running, engineOk: engine?.ok !== false, draft, busy: false, pending: 0 });
  // 本文を保存したら、表示中の run の評価対象との比較も取り直す
  const refreshRun = () => runId && void api.run(request.id, runId).then(setRun, () => undefined);
  // メモ欄は評価の下（評価を読んでから書くため）。入力中の文はここで持つので、表示が変わっても消えない
  const notes = (
    <Notes
      ctx={ctx}
      request={request}
      hasHistory={hasHistory}
      running={running}
      engineOk={engine?.ok !== false}
      draft={draft}
      onDraft={setDraft}
      onStarted={started}
      gone={data.gone}
      blocked={blocked}
    />
  );

  return (
    // ブラウザの幅をそのまま使う（上限なし）。狭い画面では左右の余白を縮める
    <div className="w-full space-y-8 px-4 py-6 sm:px-6 lg:p-8">
      <RequestMeta ctx={ctx} data={data} drafts={drafts} />

      <section className="space-y-3">
        <BodyEditor
          request={request}
          draft={drafts.bodyD}
          setDraft={drafts.setBodyD}
          editing={editingBody}
          setEditing={setEditingBody}
          gone={data.gone}
          running={running}
          hasRuns={runs.length > 0}
          onSaved={() => {
            data.reload();
            ctx.reload();
            refreshRun();
          }}
          onConflict={() => data.reload()}
        />
        {request.areas.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.areas.map((a) => (
              <Badge key={a} className="max-w-full font-mono">
                {/* 長いパスも全文を見せる（Badge は折り返さないので、中で折り返す） */}
                <span className="min-w-0 whitespace-normal break-all">{a}</span>
              </Badge>
            ))}
          </div>
        )}
      </section>

      <AttachmentsPanel key={request.id} requestId={request.id} tick={ctx.tick} />

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-indigo-50 p-4 dark:bg-indigo-950/40">
        <Button variant="primary" onClick={() => void start()} disabled={running || engine?.ok === false || notesState.blockPlainRun || !!blocked}>
          {running ? "実行中…" : runs.length ? "▶ もう一度 Preflight" : "▶ Preflight を実行"}
        </Button>
        {engine && (
          <span
            className={cx("text-sm", !engine.ok ? "text-rose-600" : engine.name === "mock" ? "text-amber-700 dark:text-amber-400" : "text-slate-600 dark:text-slate-400")}
            title={engine.name === "mock" ? "P3_PREFLIGHT_ENGINE=mock のときだけ Mock で評価します" : undefined}
          >
            {engine.ok ? "●" : "✕"} {engine.detail}
          </span>
        )}
        {running && run && (
          <Button variant="ghost" onClick={() => runAction(() => api.cancelRun(request.id, run.id), (m) => setError(`中止できませんでした: ${m}`))}>
            中止
          </Button>
        )}
        {runs.length > 0 && (
          <select
            className="ml-auto max-w-full min-w-0 rounded-md bg-white px-2 py-1.5 ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700"
            value={runId ?? ""}
            onChange={(e) => setRunId(e.target.value)}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.engine} · {r.status}
                {r.inputMatch && r.inputMatch.status !== "same" ? " · 今の要望と違う" : ""}
              </option>
            ))}
          </select>
        )}
        {pulseError && (
          <p role="status" className="flex w-full flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            最新の Preflight を確かめられませんでした（{pulseError}）。表示と入力はそのままです
            <Button variant="ghost" className="text-sm" onClick={() => poller.current?.now()}>
              もう一度確かめる
            </Button>
          </p>
        )}
        {blocked && <p className="w-full text-sm text-amber-700 dark:text-amber-400">{blocked}</p>}
        {notesState.blockPlainRun && <p className="w-full text-sm text-amber-700 dark:text-amber-400">{PLAIN_RUN_BLOCKED}</p>}
        {error && <p className="w-full text-rose-600">{error}</p>}
      </div>

      {notice && <PreflightNotice run={notice.run} fresh={notice.fresh} onOpen={() => setRunId(notice.run.id)} />}

      {run ? (
        <RunView ctx={ctx} request={request} run={run} onChanged={(r) => setRun(r)} onOpenRun={setRunId} notes={notes} blocked={blocked} />
      ) : (
        // まだ実行していない: 先に保存したメモがあるときだけ見せる（無ければ何も出さない）
        notes
      )}

    </div>
  );
}

