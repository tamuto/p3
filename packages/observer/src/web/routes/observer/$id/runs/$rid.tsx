import { Alert, Button, Field, inputCls, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { BASIS_LABEL, lastSteps, PHASE_LABEL, STEP_RESULT_LABEL, STEP_RESULTS, type Phase, type ResultSnapshot, type StepBasis, type StepResult } from "../../../../../shared/result.ts";
import { MEASURE_TYPE_LABEL } from "../../../../../shared/definition.ts";
import { fetchResult, finishResult, interruptResult, ObserverApiError, recordStep, type RunningResult } from "../../../../lib/api.ts";
import { useLoad } from "../../../../lib/useLoad.ts";
import { ResultBadge, ResultBody, StepList } from "../../../../components/Results.tsx";

/**
 * /observer/<ID>/runs/<結果ID>: 実行の記録。実行の指示を見ながら、段（準備の確かめ・前処理・手順・後処理）ごとに判定・測定値・根拠・証跡を記録し、
 * 完了して判定する（P3 は手順を実行しない）。途中で閉じても、実行中の結果から続けられる。完了・中断した結果は読むだけ
 */
export const Route = createFileRoute("/observer/$id/runs/$rid")({ component: RunPage });

function RunPage() {
  const { id, rid } = Route.useParams();
  const load = useLoad(() => fetchResult(id, rid), rid);
  // 記録・完了・中断は応答の結果で置き換える（読み直さないので、入力中の欄が消えない）
  const [cur, setCur] = useState<RunningResult>();
  const r = cur?.id === rid ? cur : load.kind === "ok" ? load.value : undefined;
  const update = (next: RunningResult) => setCur({ ...next, instructions: r?.instructions });
  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer/$id" params={{ id }} className={linkCls}>
        ← 観測の詳細
      </Link>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の結果を読めませんでした: {load.message}</Alert>}
      {r && (
        <>
          <header className="space-y-1">
            <h1 className="text-2xl font-bold">
              実行の記録: {r.snapshot.title} <ResultBadge r={r} />
            </h1>
            <p className="text-slate-600 dark:text-slate-400">
              版 {r.rev} で開始・<span data-aux>{r.id}</span>・期待: {r.snapshot.expected ?? "（未記入。判定は未確認になります）"}
            </p>
          </header>
          {r.status === "running" ? <Recording r={r} update={update} /> : <ResultBody r={r} currentRev={r.rev} />}
        </>
      )}
    </div>
  );
}

type Stage = { phase: Phase; ref: string; label: string; measures: ResultSnapshot["measures"] };
/** 記録する段（実行の順: 確かめ → 前処理 → 手順 → 後処理） */
function stagesOf(s: ResultSnapshot): Stage[] {
  const prep = (slot: "check" | "setup" | "teardown") => s.preparations.filter((p) => p[slot]).map((p) => ({ phase: slot, ref: p.id, label: `準備「${p.name}」の${PHASE_LABEL[slot]}`, measures: [] }));
  const procs = s.procedures.map((p) => ({ phase: "procedure" as const, ref: p.id, label: `手順 ${p.id} ${p.title}`, measures: s.measures.filter((m) => p.measures.includes(m.name)) }));
  return [...prep("check"), ...prep("setup"), ...procs, ...prep("teardown")];
}

function Recording({ r, update }: { r: RunningResult; update: (next: RunningResult) => void }) {
  const [error, setError] = useState<string>();
  const [reason, setReason] = useState("");
  const fail = (e: Error) => setError(e instanceof ObserverApiError && e.problems.length ? `${e.message}: ${e.problems.map((p) => `${p.path} ${p.message}`).join("・")}` : e.message);
  return (
    <>
      <p>P3 は手順を実行しません。指示の順にあなたか担当の AI が実行し、段ごとに記録してから完了してください。</p>
      {r.instructions && (
        <details open className="rounded border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer font-semibold">実行の指示</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all">{r.instructions}</pre>
        </details>
      )}
      {error && <Alert box>{error}</Alert>}
      <StepForm
        r={r}
        onDone={(next) => {
          setError(undefined);
          update(next);
        }}
        onError={fail}
      />
      <section aria-labelledby="steps-heading" className="space-y-2">
        <h2 id="steps-heading" className="text-xl font-semibold">
          記録した段
        </h2>
        <StepList steps={r.steps} label="記録した段" />
      </section>
      <div className="flex flex-wrap items-end gap-3">
        <Button variant="primary" onClick={() => void finishResult(r.observation, r.id).then(update, fail)}>
          完了して判定する
        </Button>
        <div className="min-w-64 flex-1">
          <Field label="中断の理由" hint="続けられなくなったとき。片付けていない状態が残るならそれも書く">
            <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <Button onClick={() => void interruptResult(r.observation, r.id, reason).then(update, fail)}>中断として閉じる</Button>
      </div>
    </>
  );
}

/** 段を1つ記録する（まだ記録していない最初の段を選んでおく） */
function StepForm({ r, onDone, onError }: { r: RunningResult; onDone: (next: RunningResult) => void; onError: (e: Error) => void }) {
  const stages = stagesOf(r.snapshot);
  const done = lastSteps(r);
  const [key, setKey] = useState(() => {
    const next = stages.find((s) => !done.has(`${s.phase}:${s.ref}`)) ?? stages[0];
    return next ? `${next.phase}:${next.ref}` : "";
  });
  const [result, setResult] = useState<StepResult>("met");
  const [values, setValues] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<StepBasis["kind"]>("read");
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  const [reference, setReference] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const stage = stages.find((s) => `${s.phase}:${s.ref}` === key);
  if (!stage) return <Alert warn>記録できる段がありません（手順と準備が無い観測です）。</Alert>;
  const submit = () => {
    const measures = Object.fromEntries(
      stage.measures.filter((m) => values[m.name]?.trim()).map((m) => [m.name, m.type === "number" ? Number(values[m.name]) : m.type === "boolean" ? values[m.name] === "true" : values[m.name]]),
    );
    const basis = kind === "machine" ? { kind, command, result: output } : kind === "read" ? { kind, reference } : { kind };
    recordStep(r.observation, r.id, { phase: stage.phase, ref: stage.ref, result, ...(Object.keys(measures).length ? { measures } : {}), basis, evidence, note }).then((saved) => {
      setValues({});
      setEvidence("");
      setNote("");
      const i = stages.indexOf(stage);
      if (stages[i + 1]) setKey(`${stages[i + 1].phase}:${stages[i + 1].ref}`);
      onDone(saved);
    }, onError);
  };
  return (
    <form
      aria-label="段を記録する"
      className="space-y-3 rounded border border-slate-200 p-4 dark:border-slate-800"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="text-xl font-semibold">段を記録する</h2>
      <Field label="段">
        <select className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}>
          {stages.map((s) => (
            <option key={`${s.phase}:${s.ref}`} value={`${s.phase}:${s.ref}`}>
              {s.label}
              {done.has(`${s.phase}:${s.ref}`) ? "（記録済み。記録し直す）" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="判定">
        <select className={inputCls} value={result} onChange={(e) => setResult(e.target.value as StepResult)}>
          {STEP_RESULTS.map((x) => (
            <option key={x} value={x}>
              {STEP_RESULT_LABEL[x]}
            </option>
          ))}
        </select>
      </Field>
      {stage.measures.map((m) => (
        <Field key={m.name} label={`測定値 ${m.name}（${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `・${m.unit}` : ""}）`}>
          {m.type === "boolean" ? (
            <select className={inputCls} value={values[m.name] ?? ""} onChange={(e) => setValues({ ...values, [m.name]: e.target.value })}>
              <option value="">記録しない</option>
              <option value="true">はい</option>
              <option value="false">いいえ</option>
            </select>
          ) : (
            <input className={inputCls} inputMode={m.type === "number" ? "decimal" : undefined} value={values[m.name] ?? ""} onChange={(e) => setValues({ ...values, [m.name]: e.target.value })} />
          )}
        </Field>
      ))}
      <Field label="根拠の種類" hint="実際にしたことを選ぶ（どれも記録した人の申告です）">
        <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as StepBasis["kind"])}>
          {(["machine", "read", "declaration"] as const).map((k) => (
            <option key={k} value={k}>
              {BASIS_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {kind === "machine" && (
        <>
          <Field label="実行したコマンド">
            <input className={inputCls} value={command} onChange={(e) => setCommand(e.target.value)} />
          </Field>
          <Field label="コマンドの結果" hint="終了コードと出力の要点（失敗もそのまま）">
            <input className={inputCls} value={output} onChange={(e) => setOutput(e.target.value)} />
          </Field>
        </>
      )}
      {kind === "read" && (
        <Field label="確かめた内容" hint="読んだ・見たものと、何を確かめたか">
          <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      <Field label="証跡（任意）" hint="期待どおりでない・実行できなかったときは、片付ける前に取ったスクリーンショットやログのパス">
        <input className={inputCls} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </Field>
      <Field label="メモ（任意）">
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary">
        記録する
      </Button>
    </form>
  );
}
