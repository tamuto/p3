import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type PreflightRun } from "../../../../shared/types.ts";
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

/** 要望の詳細。表示する preflight の run は URL（?run=）で選ぶ。無ければ最新 */
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
  const runId = selectedRun ?? request.lastPreflight ?? null;
  const [run, setRun] = useState<RunInfo>();
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
    if (!runId) return setRun(undefined);
    // 取れなければ前の表示のまま（要望が消えた・通信の失敗は要望の枠が知らせる）
    void api.run(request.id, runId).then(setRun, () => undefined);
  }, [runId, request.id, ctx.tick]);

  // ログはストリームで追記
  useServerEvents((e) => {
    if (e.type === "preflight-log" && e.runId === runId) {
      setRun((r) => (r ? { ...r, log: [...r.log, e.entry] } : r));
    } else if (e.type === "preflight-status" && e.runId === runId) {
      void api.run(request.id, runId).then(setRun, () => undefined);
      data.reload();
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
        {blocked && <p className="w-full text-sm text-amber-700 dark:text-amber-400">{blocked}</p>}
        {notesState.blockPlainRun && <p className="w-full text-sm text-amber-700 dark:text-amber-400">{PLAIN_RUN_BLOCKED}</p>}
        {error && <p className="w-full text-rose-600">{error}</p>}
      </div>

      {run ? (
        <RunView ctx={ctx} request={request} run={run} onChanged={(r) => setRun(r)} onOpenRun={setRunId} notes={notes} blocked={blocked} />
      ) : (
        // まだ実行していない: 先に保存したメモがあるときだけ見せる（無ければ何も出さない）
        notes
      )}

    </div>
  );
}

