import { useState } from "react";
import { Alert, Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import {
  MEASURE_TYPE_LABEL,
  MEASURE_TYPES,
  PROCEDURE_KIND_LABEL,
  PROCEDURE_KINDS,
  validateDefinitionInput,
  type DefinitionInput,
  type DefinitionProblem,
  type MeasureType,
  type ObservationDefinition,
  type Procedure,
  type ProcedureKind,
} from "../../shared/definition.ts";
import { ObserverApiError } from "../lib/api.ts";
import { SuggestPanel } from "./SuggestPanel.tsx";

/**
 * 観測の定義の入力欄（登録と編集で共通）。保存の前に共通の検証（shared/definition.ts）で項目ごとの誤りを出し、
 * 保存の応答の誤り（API の problems）も同じ場所に出す。保存は onSave（作成か、版を添えた更新）
 */
interface MeasureDraft {
  name: string;
  type: MeasureType;
  unit: string;
  description: string;
}
interface ProcedureDraft {
  kind: ProcedureKind;
  title: string;
  measures: string[];
  command: string;
  /** 引数（1行に1つ） */
  args: string;
  repo: string;
  cwd: string;
  path: string;
  invoke: string;
  body: string;
}
interface Draft {
  title: string;
  category: string;
  description: string;
  measures: MeasureDraft[];
  procedures: ProcedureDraft[];
}

const emptyMeasure = (): MeasureDraft => ({ name: "", type: "number", unit: "", description: "" });
const emptyProcedure = (kind: ProcedureKind = "command"): ProcedureDraft => ({ kind, title: "", measures: [], command: "", args: "", repo: "", cwd: "", path: "", invoke: "", body: "" });

function procedureDraft(p: Procedure): ProcedureDraft {
  const base = { ...emptyProcedure(p.kind), title: p.title, measures: [...p.measures] };
  if (p.kind === "command") return { ...base, command: p.command, args: p.args.join("\n"), repo: p.repo ?? "", cwd: p.cwd ?? "" };
  if (p.kind === "ai-instruction") return { ...base, body: p.body };
  return { ...base, repo: p.repo, path: p.path, invoke: p.invoke ?? "" };
}

function toDraft(d?: DefinitionInput): Draft {
  if (!d) return { title: "", category: "", description: "", measures: [], procedures: [] };
  return {
    title: d.title,
    category: d.category,
    description: d.description,
    measures: d.measures.map((m) => ({ name: m.name, type: m.type, unit: m.unit ?? "", description: m.description ?? "" })),
    procedures: d.procedures.map(procedureDraft),
  };
}

/** 入力欄から送る中身（種別に使わない欄は送らない。空の任意項目は検証が落とす） */
function toInput(d: Draft): Record<string, unknown> {
  return {
    title: d.title,
    category: d.category,
    description: d.description,
    measures: d.measures.map((m) => ({ name: m.name, type: m.type, ...(m.type === "number" ? { unit: m.unit } : {}), description: m.description })),
    procedures: d.procedures.map((p) => {
      const base = { kind: p.kind, title: p.title, measures: p.measures };
      if (p.kind === "command") return { ...base, command: p.command, args: p.args.split("\n").filter((a) => a.trim() !== ""), repo: p.repo, cwd: p.cwd };
      if (p.kind === "ai-instruction") return { ...base, body: p.body };
      return { ...base, repo: p.repo, path: p.path, invoke: p.invoke };
    }),
  };
}

export function DefinitionForm({
  initial,
  submitLabel,
  onSave,
  onSaved,
}: {
  initial?: DefinitionInput;
  submitLabel: string;
  onSave: (input: unknown) => Promise<ObservationDefinition>;
  onSaved: (d: ObservationDefinition) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [problems, setProblems] = useState<DefinitionProblem[]>([]);
  const [error, setError] = useState<{ message: string; conflict?: ObservationDefinition }>();
  const [saving, setSaving] = useState(false);
  const err = (path: string) => problems.find((p) => p.path === path)?.message;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setMeasure = (i: number, patch: Partial<MeasureDraft>) => setDraft((d) => ({ ...d, measures: d.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const setProcedure = (i: number, patch: Partial<ProcedureDraft>) => setDraft((d) => ({ ...d, procedures: d.procedures.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
  const measureNames = draft.measures.map((m) => m.name.trim()).filter(Boolean);

  async function submit() {
    setError(undefined);
    const input = toInput(draft);
    const v = validateDefinitionInput(input);
    if (!v.ok) {
      setProblems(v.problems);
      return;
    }
    setProblems([]);
    setSaving(true);
    try {
      onSaved(await onSave(v.value));
    } catch (e) {
      if (e instanceof ObserverApiError && e.problems.length) setProblems(e.problems);
      setError({ message: (e as Error).message, conflict: e instanceof ObserverApiError && e.code === "conflict" ? e.current : undefined });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {(problems.length > 0 || error) && (
        <div role="alert" className="space-y-1 rounded-md bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
          {error && <p>保存できませんでした: {error.message}</p>}
          {error?.conflict && <p>入力は残しています。ページを読み直すと今の定義（版 {error.conflict.rev}）を開けます。</p>}
          {problems.length > 0 && (
            <ul className="list-disc pl-5">
              {problems.map((p) => (
                <li key={`${p.path}:${p.message}`}>
                  {p.path || "全体"}: {p.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section className="space-y-3">
        <Field label="タイトル" error={err("title")}>
          <input className={inputCls} value={draft.title} aria-invalid={!!err("title")} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="カテゴリ" error={err("category")} hint="例: 性能・可用性・品質・使い勝手">
          <input className={inputCls} value={draft.category} aria-invalid={!!err("category")} onChange={(e) => set({ category: e.target.value })} />
        </Field>
        <Field label="観測内容" error={err("description")} hint="何を観測するか（目的・対象・観測したい状態）">
          <textarea className={inputCls} rows={4} value={draft.description} aria-invalid={!!err("description")} onChange={(e) => set({ description: e.target.value })} />
        </Field>
      </section>

      <section aria-labelledby="measures-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="measures-heading" className="font-semibold">
            測定項目（何を測定・記録するか）
          </h2>
          <Button onClick={() => set({ measures: [...draft.measures, emptyMeasure()] })}>
            ＋ 測定項目を足す
          </Button>
        </div>
        {err("measures") && <Alert>{err("measures")}</Alert>}
        {draft.measures.length === 0 && <p className="text-slate-500">まだありません。</p>}
        {draft.measures.map((m, i) => (
          <fieldset key={i} aria-label={`測定項目 ${i + 1}`} className="grid gap-3 rounded border border-slate-200 p-3 sm:grid-cols-[1fr_9rem_8rem_auto] dark:border-slate-800">
            <Field label="名前" error={err(`measures[${i}].name`)}>
              <input className={inputCls} value={m.name} aria-invalid={!!err(`measures[${i}].name`)} onChange={(e) => setMeasure(i, { name: e.target.value })} />
            </Field>
            <Field label="型" error={err(`measures[${i}].type`)}>
              <select className={inputCls} value={m.type} onChange={(e) => setMeasure(i, { type: e.target.value as MeasureType })}>
                {MEASURE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {MEASURE_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="単位" error={err(`measures[${i}].unit`)}>
              <input className={inputCls} value={m.unit} disabled={m.type !== "number"} aria-invalid={!!err(`measures[${i}].unit`)} onChange={(e) => setMeasure(i, { unit: e.target.value })} />
            </Field>
            <div className="flex items-end">
              <Button onClick={() => set({ measures: draft.measures.filter((_, j) => j !== i) })}>
                外す
              </Button>
            </div>
            <div className="sm:col-span-4">
              <Field label="説明" error={err(`measures[${i}].description`)}>
                <input className={inputCls} value={m.description} onChange={(e) => setMeasure(i, { description: e.target.value })} />
              </Field>
            </div>
          </fieldset>
        ))}
      </section>

      <SuggestPanel material={() => toInput(draft)} onAdopt={(p) => setDraft((d) => ({ ...d, procedures: [...d.procedures, procedureDraft(p)] }))} />

      <section aria-labelledby="procedures-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="procedures-heading" className="font-semibold">
            確認の手順（繰り返し確かめる方法）
          </h2>
          <Button onClick={() => set({ procedures: [...draft.procedures, emptyProcedure()] })}>
            ＋ 手順を足す
          </Button>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">繰り返し確かめるので、できるだけコマンドかテストにする。画面の操作はスクリプト、汎用の確認は AI への指示で書く。</p>
        {err("procedures") && <Alert>{err("procedures")}</Alert>}
        {draft.procedures.length === 0 && <p className="text-slate-500">まだありません。</p>}
        {draft.procedures.map((p, i) => {
          const at = `procedures[${i}]`;
          return (
            <fieldset key={i} aria-label={`手順 ${i + 1}`} className="space-y-3 rounded border border-slate-200 p-3 dark:border-slate-800">
              <div className="grid gap-3 sm:grid-cols-[12rem_1fr_auto]">
                <Field label="種別" error={err(`${at}.kind`)}>
                  <select className={inputCls} value={p.kind} onChange={(e) => setProcedure(i, { kind: e.target.value as ProcedureKind })}>
                    {PROCEDURE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {PROCEDURE_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="手順の名前" error={err(`${at}.title`)}>
                  <input className={inputCls} value={p.title} aria-invalid={!!err(`${at}.title`)} onChange={(e) => setProcedure(i, { title: e.target.value })} />
                </Field>
                <div className="flex items-end">
                  <Button onClick={() => set({ procedures: draft.procedures.filter((_, j) => j !== i) })}>
                    外す
                  </Button>
                </div>
              </div>
              {p.kind === "command" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="実行名" error={err(`${at}.command`)} hint="例: pnpm">
                    <input className={inputCls} value={p.command} aria-invalid={!!err(`${at}.command`)} onChange={(e) => setProcedure(i, { command: e.target.value })} />
                  </Field>
                  <Field label="引数（1行に1つ）" error={err(`${at}.args`)}>
                    <textarea className={inputCls} rows={3} value={p.args} onChange={(e) => setProcedure(i, { args: e.target.value })} />
                  </Field>
                  <Field label="作業場所の参照先" error={err(`${at}.repo`)} hint="プロジェクトに登録した参照先の名前（省くと決めない）">
                    <input className={inputCls} value={p.repo} aria-invalid={!!err(`${at}.repo`)} onChange={(e) => setProcedure(i, { repo: e.target.value })} />
                  </Field>
                  <Field label="作業場所（参照先の中の相対パス）" error={err(`${at}.cwd`)}>
                    <input className={inputCls} value={p.cwd} aria-invalid={!!err(`${at}.cwd`)} onChange={(e) => setProcedure(i, { cwd: e.target.value })} />
                  </Field>
                </div>
              )}
              {(p.kind === "test" || p.kind === "ui-script") && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="参照先" error={err(`${at}.repo`)} hint="プロジェクトに登録した参照先の名前">
                    <input className={inputCls} value={p.repo} aria-invalid={!!err(`${at}.repo`)} onChange={(e) => setProcedure(i, { repo: e.target.value })} />
                  </Field>
                  <Field label="ファイル（参照先の中の相対パス）" error={err(`${at}.path`)}>
                    <input className={inputCls} value={p.path} aria-invalid={!!err(`${at}.path`)} onChange={(e) => setProcedure(i, { path: e.target.value })} />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="呼び出し方（任意）" error={err(`${at}.invoke`)} hint="例: pnpm vitest run test/perf.test.ts">
                      <input className={inputCls} value={p.invoke} onChange={(e) => setProcedure(i, { invoke: e.target.value })} />
                    </Field>
                  </div>
                </div>
              )}
              {p.kind === "ai-instruction" && (
                <Field label="指示文" error={err(`${at}.body`)}>
                  <textarea className={inputCls} rows={4} value={p.body} aria-invalid={!!err(`${at}.body`)} onChange={(e) => setProcedure(i, { body: e.target.value })} />
                </Field>
              )}
              <div role="group" aria-label={`手順 ${i + 1} で測る項目`} className="space-y-1">
                <span className="text-base font-medium text-slate-700 dark:text-slate-300">この手順で測る項目</span>
                {measureNames.length === 0 && <p className="text-sm text-slate-500">測定項目を先に足してください。</p>}
                <div className="flex flex-wrap gap-3">
                  {measureNames.map((name) => (
                    <label key={name} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={p.measures.includes(name)}
                        onChange={(e) => setProcedure(i, { measures: e.target.checked ? [...p.measures, name] : p.measures.filter((x) => x !== name) })}
                      />
                      {name}
                    </label>
                  ))}
                </div>
                {problems
                  .filter((x) => x.path.startsWith(`${at}.measures`))
                  .map((x) => (
                    <span key={x.path} className="block text-sm text-rose-600">
                      {x.message}
                    </span>
                  ))}
              </div>
            </fieldset>
          );
        })}
      </section>

      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "保存中…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
