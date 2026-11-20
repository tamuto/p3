import { useEffect, useRef, useState } from "react";
import { PROCEDURE_KIND_LABEL, type Procedure } from "../../shared/definition.ts";
import { MISSING_LABEL, SURFACE_LABEL, type SuggestionContext, type SuggestionJob } from "../../shared/suggestion.ts";
import { Alert, Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { cancelSuggestion, fetchSuggestion, fetchSuggestionContext, ObserverApiError, startSuggestion } from "../lib/api.ts";

const FAILURE_LABEL: Record<NonNullable<SuggestionJob["failure"]>, string> = {
  unavailable: "AI の接続を使えません",
  usage_limit: "使用量の上限です",
  invalid_output: "応答の形が違います",
  timeout: "時間切れです",
  error: "失敗しました",
};

/**
 * 「AI に手順を提案してもらう」。入力中の定義（未保存）・補足と、読める参照先（Preflight と同じく全部）を材料に頼み、操作面・手順と根拠・足りない材料を出す。
 * 提案の手順は「編集欄に取り込む」で手順の欄に足すだけ（保存は利用者の明示の操作）。失敗・取り消しでも入力中の定義は変えない。
 * このページ（プロジェクト）で始めた提案だけを扱い、ページを離れたら結果を捨てる
 */
export function SuggestPanel({ material, onAdopt }: { material: () => unknown; onAdopt: (p: Procedure) => void }) {
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
    return () => {
      alive.current = false;
    };
  }, []);

  // 実行中は終わるまで読み直す
  useEffect(() => {
    if (job?.status !== "running") return;
    const t = setTimeout(() => {
      fetchSuggestion(job.id).then(
        (j) => alive.current && setJob(j),
        (e: Error) => alive.current && (setError(e.message), setJob(undefined)),
      );
    }, 700);
    return () => clearTimeout(t);
  }, [job]);

  async function ask() {
    setError(undefined);
    setAdopted([]);
    try {
      const j = await startSuggestion({ definition: material(), ...(note.trim() ? { note } : {}) });
      if (alive.current) setJob(j);
    } catch (e) {
      const problems = e instanceof ObserverApiError ? e.problems.map((p) => `${p.path}: ${p.message}`) : [];
      if (alive.current) setError([(e as Error).message, ...problems].join("\n"));
    }
  }

  const running = job?.status === "running";
  return (
    <section aria-labelledby="suggest-heading" className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <h2 id="suggest-heading" className="font-semibold">
        AI に手順を提案してもらう
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        入力中のタイトル・観測内容・測定項目と、プロジェクトの参照先（読むだけ）を材料に、観測の操作面と確認の手順を提案します。保存はしません。
      </p>
      {ctxError && <Alert>提案の材料を読めません: {ctxError}</Alert>}
      {ctx && (
        <p className={ctx.engine.ok ? "text-sm text-slate-600 dark:text-slate-400" : "text-sm text-amber-700 dark:text-amber-400"} data-testid="suggest-engine">
          頼む先: {ctx.engine.name}（{ctx.engine.detail}）
        </p>
      )}
      <Field label="補足（任意）">
        <textarea className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex gap-3">
        <Button variant="primary" disabled={running} onClick={() => void ask()}>
          {running ? "提案を待っています…" : job ? "もう一度頼む" : "提案を頼む"}
        </Button>
        {running && (
          <Button variant="cancel" onClick={() => void cancelSuggestion(job.id).catch((e: Error) => setError(e.message))}>
            取り消す
          </Button>
        )}
      </div>
      {error && <Alert>提案を頼めませんでした: {error}</Alert>}
      {job?.status === "failed" && <Alert>{`${FAILURE_LABEL[job.failure ?? "error"]}: ${job.error}（入力中の定義はそのままです）`}</Alert>}
      {job?.status === "cancelled" && <p className="text-slate-600">取り消しました（入力中の定義はそのままです）。</p>}
      {job?.status === "completed" && job.result && (
        <div className="space-y-3" data-testid="suggestion">
          <p>
            <span className="font-medium">操作面: {SURFACE_LABEL[job.result.surface]}</span>
            <span className="ml-2 text-sm text-slate-500">（{job.engine}）</span>
          </p>
          <p className="text-sm">根拠: {job.result.rationale}</p>
          {job.result.procedures.map((p, i) => (
            <article key={i} aria-label={`提案 ${i + 1}: ${p.procedure.title}`} className="space-y-1 rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="font-medium">
                <span className="mr-2 rounded bg-slate-100 px-1.5 text-sm dark:bg-slate-800">{PROCEDURE_KIND_LABEL[p.procedure.kind]}</span>
                {p.procedure.title}
              </h3>
              <p className="font-mono text-sm break-all">{summary(p.procedure)}</p>
              <p className="text-sm text-slate-600 dark:text-slate-400">根拠: {p.evidence}</p>
              <Button
                disabled={adopted.includes(i)}
                onClick={() => {
                  onAdopt(p.procedure);
                  setAdopted([...adopted, i]);
                }}
              >
                {adopted.includes(i) ? "取り込みました" : "編集欄に取り込む"}
              </Button>
            </article>
          ))}
          {job.result.missing.length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950" data-testid="suggestion-missing">
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
            <p key={w} className="text-sm text-amber-700">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function summary(p: Procedure): string {
  if (p.kind === "command") return `${[p.command, ...p.args].join(" ")}${p.repo ? `（${p.repo}:${p.cwd ?? "."}）` : ""}`;
  if (p.kind === "ai-instruction") return p.body;
  return `${p.repo}:${p.path}${p.invoke ? `（${p.invoke}）` : ""}`;
}
