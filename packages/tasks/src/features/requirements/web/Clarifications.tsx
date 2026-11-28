import { useEffect, useId, useState } from "react";
import { ANSWER_STATE_LABEL, clarificationStates, type AnswerState, type Clarification, type ClarifyAnswer } from "../shared/clarify.ts";
import type { Request } from "../../../shared/types.ts";
import { api, failureOf, saveErrorText, type RunInfo } from "../../../web/lib/api.ts";
import { useUnsaved } from "../../../web/lib/unsaved.ts";
import { Alert, Badge, Button, inputCls, type Tone } from "@infodb/p3-shared/web/ui.tsx";

/**
 * Preflight の確認事項（clarify の構造化した確認事項）のカードと回答欄。確認先・質問・対象・必要な根拠・判断への影響・元の run と ID・
 * 回答の状態を見せる。確認先が分からなければ分からないまま案内し、誰かが確認したように書かない。
 * 「回答を要望に保存」と「保存した内容で再評価」は分け、自動では実行しない。過去の run の質問なら、回答は今の要望に残ることを示す。
 */

const STATE_TONE: Record<AnswerState, Tone> = { answered: "emerald", unanswered: "amber" };

/** 保存の失敗（他で更新されたら入力は残して読み直しを促す） */
const saveError = (e: unknown) => (failureOf(e) === "rev_conflict" ? "他で更新されました。入力は残しています。最新を読み込んでから、もう一度保存してください" : saveErrorText(e));

type Fields = { answer: string; by: string; on: string };
const fieldsOf = (a?: ClarifyAnswer): Fields => ({ answer: a?.answer ?? "", by: a?.by ?? "", on: a?.on ?? "" });

export function Clarifications({
  request,
  run,
  latest,
  onSaved,
  onDirty,
  onRerun,
  canRerun,
}: {
  request: Request;
  run: RunInfo;
  /** 表示中の run が要望の最新か */
  latest: boolean;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
  onRerun: () => void;
  canRerun: boolean;
}) {
  const qs = run.assessment?.clarifications ?? [];
  const problems = run.assessment?.clarificationProblems ?? [];
  const items = clarificationStates(run.id, qs, request.clarifyAnswers);
  const [dirtyBy, setDirtyBy] = useState<Record<string, boolean>>({});
  const anyDirty = Object.values(dirtyBy).some(Boolean);
  useEffect(() => onDirty(anyDirty), [anyDirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const [saved, setSaved] = useState(false);
  if (!qs.length && !problems.length) return null;
  return (
    <section className="min-w-0 space-y-3" aria-label="確認事項と回答">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">確認事項と回答</h3>
        <span className="text-base text-fg-4">
          {run.id} の確認事項{latest ? "" : "（過去の評価の質問です。回答は今の要望に残ります）"}
        </span>
      </div>
      <p className="text-base text-fg-3">
        回答は要望に残し、過去の評価は書き換えません。回答を保存しても評価は自動で始まりません。保存した後に「保存した内容で再評価」してください。
      </p>
      {problems.map((p) => (
        <Alert key={p}>
          読めない確認事項: {p}
        </Alert>
      ))}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">
        {items.map((i) => (
          <ClarificationCard
            key={i.clarification.id}
            request={request}
            runId={run.id}
            q={i.clarification}
            state={i.state}
            answer={i.answer}
            onDirty={(d) => setDirtyBy((cur) => (cur[i.clarification.id] === d ? cur : { ...cur, [i.clarification.id]: d }))}
            onSaved={() => {
              setSaved(true);
              onSaved();
            }}
          />
        ))}
      </ul>
      {(saved || items.some((i) => i.answer)) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!canRerun || anyDirty} onClick={onRerun}>
            保存した内容で再評価
          </Button>
          {anyDirty && <span className="text-base text-warn">未保存の回答があります。保存するか取消してから再評価してください</span>}
        </div>
      )}
    </section>
  );
}

function ClarificationCard({
  request,
  runId,
  q,
  state,
  answer,
  onDirty,
  onSaved,
}: {
  request: Request;
  runId: string;
  q: Clarification;
  state: AnswerState;
  answer?: ClarifyAnswer;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Fields>(() => fieldsOf(answer));
  const [base, setBase] = useState<Fields>(() => fieldsOf(answer));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = open && JSON.stringify(f) !== JSON.stringify(base);
  useUnsaved(dirty);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const start = () => {
    const init = fieldsOf(answer);
    setF(init);
    setBase(init);
    setError(null);
    setOpen(true);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveAnswer(request.id, { run: runId, question: q.id, answer: f.answer, by: f.by || undefined, on: f.on || undefined, rev: request.rev });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError(saveError(e));
    } finally {
      setBusy(false);
    }
  };
  const fid = (k: string) => `${id}-${k}`;
  return (
    <li className="min-w-0 space-y-2 rounded-lg bg-surface p-4 ring-1 ring-line" data-testid={`clarification-${q.id}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-fg-4">
          {runId}/{q.id}
        </span>
        <Badge tone={STATE_TONE[state]}>{ANSWER_STATE_LABEL[state]}</Badge>
      </div>
      <p className="font-medium break-words">{q.question}</p>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-base">
        <dt className="text-fg-4">確認先</dt>
        <dd className="min-w-0 break-words">{q.ask}</dd>
        <dt className="text-fg-4">対象</dt>
        <dd className="min-w-0 break-words">{q.target}</dd>
        {q.needed && (
          <>
            <dt className="text-fg-4">必要な根拠</dt>
            <dd className="min-w-0 break-words">{q.needed}</dd>
          </>
        )}
        {q.impact && (
          <>
            <dt className="text-fg-4">判断への影響</dt>
            <dd className="min-w-0 break-words">{q.impact}</dd>
          </>
        )}
      </dl>
      {answer && !open && (
        <div className="min-w-0 rounded-md bg-ok-soft p-2 text-base">
          <p data-aux className="text-sm text-fg-3">
            回答{answer.by || answer.on ? `（${[answer.by, answer.on].filter(Boolean).join("・")}）` : ""}
          </p>
          <p className="break-words whitespace-pre-wrap">{answer.answer}</p>
        </div>
      )}
      {open ? (
        <div
          className="min-w-0 space-y-2"
          role="group"
          aria-label={`${q.id} の回答`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="min-w-0">
            <label className="block text-base" htmlFor={fid("answer")}>
              回答
            </label>
            <textarea id={fid("answer")} rows={3} className={inputCls} value={f.answer} disabled={busy} onChange={(e) => setF({ ...f, answer: e.target.value })} />
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <label className="block min-w-0 text-base" htmlFor={fid("by")}>
                回答した役割・アクター（任意）
              </label>
              <input id={fid("by")} className={inputCls} value={f.by} disabled={busy} onChange={(e) => setF({ ...f, by: e.target.value })} />
            </div>
            <div className="min-w-0">
              <label className="block min-w-0 text-base" htmlFor={fid("on")}>
                回答の日（任意）
              </label>
              <input id={fid("on")} type="date" className={inputCls} value={f.on} disabled={busy} onChange={(e) => setF({ ...f, on: e.target.value })} />
            </div>
          </div>
          {dirty && <p className="text-base text-warn">未保存の回答があります</p>}
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || !f.answer.trim()} onClick={() => void save()}>
              {busy ? "保存中…" : "回答を要望に保存"}
            </Button>
            <Button variant="cancel" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" className="text-base" onClick={start}>
          {answer ? "回答を直す" : "回答する"}
        </Button>
      )}
    </li>
  );
}
