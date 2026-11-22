import { useEffect, useRef, useState } from "react";
import { filesOf, fileKey, MEASURE_TYPE_LABEL, type Measure, type Procedure } from "../../shared/definition.ts";
import { useFileStates } from "../lib/files.ts";
import { ProcedureView } from "./ProcedureView.tsx";
import { MISSING_LABEL, SURFACE_LABEL, type SuggestionContext, type SuggestionJob } from "../../shared/suggestion.ts";
import { Alert, Button, buttonCls, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { Link } from "@tanstack/react-router";
import { STARTING_LABEL, useStartOnce } from "@infodb/p3-shared/web/startOnce.ts";
import { SLOT_LABEL, SLOTS } from "../../shared/preparation.ts";
import type { Refs } from "./RefPicker.tsx";
import { cancelSuggestion, fetchSuggestion, fetchSuggestionContext, listSuggestions, ObserverApiError, startSuggestion } from "../lib/api.ts";

const FAILURE_LABEL: Record<NonNullable<SuggestionJob["failure"]>, string> = {
  unavailable: "AI の接続を使えません",
  usage_limit: "使用量の上限です",
  invalid_output: "応答の形が違います",
  timeout: "時間切れです",
  error: "失敗しました",
};

/**
 * 「AI に手順を提案してもらう」。保存した観測（ID）に、入力中の定義・補足と、読める参照先（Preflight と同じく全部）を材料に頼む。
 * 依頼と結果は観測に残るので、読み直しや serve の再起動のあとも最新の提案を出す。実行していたプロセスが終わっていれば中断と出し、同じ入力で頼み直せる。
 * 提案の手順は「編集欄に取り込む」で手順の欄に足すだけ（保存は利用者の明示の操作）。今の版と違う版への提案は、確かめてから取り込む
 */
export function SuggestPanel({
  id,
  rev,
  material,
  measures,
  onAdopt,
  onAdoptMeasure,
  refs,
  onAdoptRef,
}: {
  id: string;
  rev: number;
  material: () => unknown;
  /** 今の入力の測定項目（候補の名前の衝突と、手順の測る項目が揃っているかを見る） */
  measures: Measure[];
  onAdopt: (p: Procedure) => void;
  onAdoptMeasure: (m: Measure) => void;
  /** 今の入力の前提の観測と使う準備（取り込み済みの候補を見分ける） */
  refs: Refs;
  onAdoptRef: (key: keyof Refs, id: string) => void;
}) {
  const [ctx, setCtx] = useState<SuggestionContext>();
  const [ctxError, setCtxError] = useState<string>();
  const [note, setNote] = useState("");
  const [job, setJob] = useState<SuggestionJob>();
  const [error, setError] = useState<string>();
  const [adopted, setAdopted] = useState<number[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    fetchSuggestionContext().then(
      (c) => alive.current && setCtx(c),
      (e: Error) => alive.current && setCtxError(e.message),
    );
    // 残っている最新の提案を出す
    listSuggestions(id).then(
      (l) => alive.current && setJob((j) => j ?? l.suggestions[0]),
      (e: Error) => alive.current && setError(e.message),
    );
    return () => {
      alive.current = false;
    };
  }, [id]);

  // 実行中は終わるまで読み直す
  useEffect(() => {
    if (job?.status !== "running") return;
    const t = setTimeout(() => {
      fetchSuggestion(id, job.id).then(
        (j) => alive.current && setJob(j),
        (e: Error) => alive.current && setError(e.message),
      );
    }, 700);
    return () => clearTimeout(t);
  }, [id, job]);

  // 開始待ち（押した直後から応答まで。中断した提案の頼み直しも同じ）。応答が遅くても二重に頼まない
  const once = useStartOnce(id);
  function ask(body: { definition: unknown; note?: string; basedOnRev: number }) {
    setError(undefined);
    void once.start(
      () => startSuggestion(id, body),
      (j) => {
        setAdopted([]);
        if (alive.current) setJob(j);
      },
      (e) => {
        const problems = e instanceof ObserverApiError ? e.problems.map((p) => `${p.path}: ${p.message}`) : [];
        if (alive.current) setError([e.message, ...problems].join("\n"));
      },
    );
  }
  const measureNames = measures.map((m) => m.name);
  const stale = job?.basedOnRev !== undefined && job.basedOnRev !== rev;
  const files = useFileStates(job?.result ? filesOf(job.result.procedures.map((p) => p.procedure)).map((f) => fileKey(f.repo, f.path)) : []);

  const running = job?.status === "running";
  return (
    <section aria-labelledby="suggest-heading" className="space-y-3 rounded-lg bg-surface p-4 ring-1 ring-line">
      <h2 id="suggest-heading" className="text-xl font-semibold">
        AI に手順を提案してもらう
      </h2>
      <p className="text-fg-3">
        入力中の観測の項目・測定項目・手順と、プロジェクトの参照先（読むだけ）を材料に、確認の手順と測定項目の候補を提案します。提案は観測に残り、定義には取り込んで保存したときだけ入ります。
      </p>
      {ctxError && <Alert>提案の材料を読めません: {ctxError}</Alert>}
      {ctx && (
        <p data-aux className={ctx.engine.ok ? "text-sm text-fg-3" : "text-sm text-warn"} data-testid="suggest-engine">
          頼む先: {ctx.engine.name}（{ctx.engine.detail}）
        </p>
      )}
      <Field label="補足（任意）">
        <textarea className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-3">
        <Button variant="primary" disabled={running || once.pending} onClick={() => ask({ definition: material(), basedOnRev: rev, ...(note.trim() ? { note } : {}) })}>
          {once.pending ? STARTING_LABEL : running ? "提案を待っています…" : job ? "もう一度頼む" : "提案を頼む"}
        </Button>
        {running && (
          <Button variant="cancel" onClick={() => void cancelSuggestion(id, job.id).catch((e: Error) => setError(e.message))}>
            取り消す
          </Button>
        )}
      </div>
      {error && <Alert>提案を頼めませんでした: {error}</Alert>}
      {job?.status === "failed" && <Alert>{`${FAILURE_LABEL[job.failure ?? "error"]}: ${job.error}（入力中の定義はそのままです）`}</Alert>}
      {job?.status === "cancelled" && <p className="text-fg-3">取り消しました（入力中の定義はそのままです）。</p>}
      {job?.status === "interrupted" && job.request && (
        <Alert box warn>
          {job.error}{" "}
          <Button disabled={once.pending} onClick={() => ask({ definition: job.request!.definition, basedOnRev: job.basedOnRev ?? rev, ...(job.request!.note ? { note: job.request!.note } : {}) })}>
            {once.pending ? STARTING_LABEL : "同じ入力で頼み直す"}
          </Button>
        </Alert>
      )}
      {stale && job?.status === "completed" && <Alert warn>{`この提案は版 v${job.basedOnRev} の定義に頼んだものです（今は v${rev}）。取り込むときに確かめます`}</Alert>}
      {job?.status === "completed" && job.result && (
        <div className="space-y-3" data-testid="suggestion">
          <p>
            <span className="font-semibold">操作面: {SURFACE_LABEL[job.result.surface]}</span>
            <span className="ml-2 text-fg-3">（{job.engine}）</span>
          </p>
          <p>根拠: {job.result.rationale}</p>
          {job.result.measures.length > 0 && (
            <section aria-label="測定項目の候補" className="space-y-2">
              <h3 className="text-lg font-semibold">測定項目の候補</h3>
              <ul className="space-y-2">
                {job.result.measures.map((m) => {
                  const taken = measureNames.includes(m.name);
                  return (
                    <li key={m.name} className="flex flex-wrap items-center gap-3">
                      <span>
                        <code>{m.name}</code>（{MEASURE_TYPE_LABEL[m.type]}
                        {m.unit ? `・${m.unit}` : ""}）{m.description ? `　${m.description}` : ""}
                      </span>
                      <Button disabled={taken} onClick={() => onAdoptMeasure(m)}>
                        {taken ? "同じ名前の測定項目があります" : "測定項目に取り込む"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {job.result.procedures.map((p, i) => (
            <ProcedureView key={i} p={p.procedure} label={`提案 ${i + 1}: ${p.procedure.title}`} measures={[...measures, ...(job.result?.measures ?? [])]} files={files}>
              <p>根拠: {p.evidence}</p>
              <Button
                disabled={adopted.includes(i) || p.procedure.measures.some((n) => !measureNames.includes(n))}
                onClick={() => {
                  if (stale && !window.confirm(`版 v${job.basedOnRev} への提案です。今の入力（v${rev}）に取り込みますか？`)) return;
                  onAdopt(p.procedure);
                  setAdopted([...adopted, i]);
                }}
              >
                {adopted.includes(i) ? "取り込みました" : p.procedure.measures.some((n) => !measureNames.includes(n)) ? "測る項目を先に取り込んでください" : "編集欄に取り込む"}
              </Button>
            </ProcedureView>
          ))}
          <RefSuggestions id={id} job={job} refs={refs} onAdopt={onAdoptRef} />
          {job.result.missing.length > 0 && (
            <div className="rounded-md bg-warn-soft p-3 text-warn-strong" data-testid="suggestion-missing">
              <p className="font-medium">判断に足りない材料（補足に書くか、観測内容に足して頼み直す）</p>
              <ul className="list-disc pl-5">
                {job.result.missing.map((m, i) => (
                  <li key={i}>
                    {MISSING_LABEL[m.field]}: {m.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {job.result.warnings.map((w) => (
            <Alert key={w} warn>
              ⚠ {w}
            </Alert>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 前提の観測・再利用する準備・新しい準備の案（どれも任意）。前提と既にある準備は入力に取り込むだけで、保存のときに循環や存在しない参照が確かめられる。
 * 新しい準備の案は、案を入れた準備の登録の画面で確かめて保存してから、この観測の編集に戻って使う準備に足す（編集途中の入力は観測に残っている）
 */
function RefSuggestions({ id, job, refs, onAdopt }: { id: string; job: SuggestionJob; refs: Refs; onAdopt: (key: keyof Refs, id: string) => void }) {
  const r = job.result!;
  const c = job.request?.candidates;
  if (!r.prerequisites.length && !r.preparations.length && !r.newPreparations.length) return null;
  const item = (key: keyof Refs, x: { id: string; reason: string }, label: string) => {
    const taken = refs[key].includes(x.id);
    return (
      <li key={`${key}:${x.id}`} className="space-y-1">
        <p>
          <span className="font-medium">{label}</span>　{x.reason}
        </p>
        <Button disabled={taken} onClick={() => onAdopt(key, x.id)}>
          {taken ? "取り込みました" : key === "prerequisites" ? "前提に取り込む" : "使う準備に取り込む"}
        </Button>
      </li>
    );
  };
  return (
    <section aria-label="前提と準備の候補" className="space-y-2">
      <h3 className="text-lg font-semibold">前提と準備の候補</h3>
      <ul className="space-y-3">
        {r.prerequisites.map((x) => item("prerequisites", x, `前提の観測: ${c?.observations.find((o) => o.id === x.id)?.title ?? x.id}`))}
        {r.preparations.map((x) => item("preparations", x, `既にある準備: ${c?.preparations.find((p) => p.id === x.id)?.name ?? x.id}`))}
        {r.newPreparations.map((x, n) => (
          <li key={`new:${n}`} className="space-y-1">
            <p>
              <span className="font-medium">新しい準備の案: {x.preparation.name}</span>（{SLOTS.filter((s) => x.preparation[s]).map((s) => SLOT_LABEL[s]).join("・") || "中身なし"}）　{x.reason}
            </p>
            <Link to="/observer/preparations/new" search={{ from: id, sid: job.id, n }} className={buttonCls()}>
              準備の登録の画面で確かめる
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
