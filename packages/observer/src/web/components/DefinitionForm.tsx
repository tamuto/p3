import { useEffect, useRef, useState } from "react";
import { Alert, Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { filesOf, fileKey, MEASURE_TYPE_LABEL, MEASURE_TYPES, validateDefinitionInput, type DefinitionInput, type DefinitionProblem, type Measure, type MeasureType, type ObservationDefinition } from "../../shared/definition.ts";
import { draftOf, emptyMeasure, emptyProcedure, isDraft, procedureDraft, toDraft, toInput, type Draft, type MeasureDraft, type ProcedureDraft } from "../lib/formDraft.ts";
import { useFileStates } from "../lib/files.ts";
import { ProcedureEditor } from "./ProcedureEditor.tsx";
import { ObserverApiError, saveDraft, type DraftRecord } from "../lib/api.ts";
import { SuggestPanel } from "./SuggestPanel.tsx";
import { SaveProblems } from "./SaveProblems.tsx";

/**
 * 観測の定義の入力欄（編集の画面）。保存の前に共通の検証（shared/definition.ts）で項目ごとの誤りを出し、保存の応答の誤り（API の problems）も
 * 同じ場所に出す。入力は編集途中のまま観測に残す
 */
/**
 * 編集途中の入力を観測に残す（変えてから少し待って保存。検証の前の不完全な入力もそのまま）。保存の状況を文で返す。
 * flush は確定の保存のあとに、確定した版をもとにした入力として残す（次に開いたときに古い下書きを出さない）
 */
function useDraftSave(id: string, rev: number, draft: Draft, saved?: DraftRecord) {
  const version = useRef<number | null>(saved?.version ?? null);
  const first = useRef(true);
  const [text, setText] = useState(saved ? `入力は保存されています（${new Date(saved.savedAt).toLocaleString()}）` : "入力はまだ保存されていません");
  const save = async (basedOnRev: number) => {
    setText("入力を保存しています…");
    try {
      const d = await saveDraft(id, version.current, basedOnRev, draft);
      version.current = d.version;
      setText(`入力は保存されています（${new Date(d.savedAt).toLocaleTimeString()}）`);
    } catch (e) {
      setText(`入力を保存できません: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setText("保存していない変更があります");
    const t = setTimeout(() => void save(rev), 800);
    return () => clearTimeout(t);
    // 入力が変わったときだけ保存する
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- save は描画ごとに作り直されるが、保存するのは入力が変わったときだけ
  }, [draft]);
  return { text, flush: save };
}

export function DefinitionForm({
  initial,
  submitLabel,
  onSave,
  onSaved,
  id,
  rev,
  saved,
  restore,
}: {
  initial?: DefinitionInput;
  submitLabel: string;
  onSave: (input: unknown) => Promise<ObservationDefinition>;
  onSaved: (d: ObservationDefinition) => void;
  /** 保存した観測の ID と版 */
  id: string;
  rev: number;
  /** 保存した編集途中の入力（restore のときだけ入力欄に戻す。版は上書きの確かめに使う） */
  saved?: DraftRecord;
  restore?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => (restore && isDraft(saved?.input) ? draftOf(saved.input) : toDraft(initial)));
  const status = useDraftSave(id, rev, draft, saved);
  const [problems, setProblems] = useState<DefinitionProblem[]>([]);
  const [error, setError] = useState<{ message: string; conflict?: { rev: number } }>();
  const [saving, setSaving] = useState(false);
  const err = (path: string) => problems.find((p) => p.path === path)?.message;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setMeasure = (i: number, patch: Partial<MeasureDraft>) => setDraft((d) => ({ ...d, measures: d.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const setProcedure = (i: number, p: ProcedureDraft) => setDraft((d) => ({ ...d, procedures: d.procedures.map((x, j) => (j === i ? p : x)) }));
  const measureNames = draft.measures.map((m) => m.name.trim()).filter(Boolean);
  const files = useFileStates(filesOf(draft.procedures.map((p) => ({ run: p.run as never, replacement: p.replacement.on ? (p.replacement as never) : undefined }))).map((f) => fileKey(f.repo, f.path)));
  const adoptMeasure = (m: Measure) => set({ measures: [...draft.measures, { name: m.name, type: m.type, unit: m.unit ?? "", description: m.description ?? "" }] });

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
      const d = await onSave(v.value);
      await status.flush(d.rev);
      onSaved(d);
    } catch (e) {
      if (e instanceof ObserverApiError && e.problems.length) setProblems(e.problems);
      setError({ message: (e as Error).message, conflict: e instanceof ObserverApiError && e.code === "conflict" ? e.current : undefined });
    } finally {
      setSaving(false);
    }
  }

  return (
    // 広い画面は2ペイン: 左に観測の項目・測定項目・確認の手順、右に AI の提案。狭い画面は 観測の項目 → AI の提案 → 測定項目 → 確認の手順 の順
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,40%)]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-3 lg:col-span-2">
        <p role="status" className="text-slate-600 dark:text-slate-400">
          {status.text}
        </p>
        <SaveProblems problems={problems} error={error} />
      </div>

      <section aria-labelledby="items-heading" className="space-y-3 lg:col-start-1 lg:row-start-2">
        <h2 id="items-heading" className="text-xl font-semibold">
          観測の項目
        </h2>
        <Field label="タイトル" error={err("title")}>
          <input className={inputCls} value={draft.title} aria-invalid={!!err("title")} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="カテゴリ" error={err("category")} hint="例: 性能・可用性・品質・使い勝手">
          <input className={inputCls} value={draft.category} aria-invalid={!!err("category")} onChange={(e) => set({ category: e.target.value })} />
        </Field>
        <Field label="観測内容" error={err("description")} hint="何を観測するか（目的・対象・観測したい状態）">
          <textarea className={inputCls} rows={4} value={draft.description} aria-invalid={!!err("description")} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="期待する結果（任意）" error={err("expected")} hint="どうなっていれば期待どおりか（判定のもとになる）">
          <textarea className={inputCls} rows={3} value={draft.expected} aria-invalid={!!err("expected")} onChange={(e) => set({ expected: e.target.value })} />
        </Field>
      </section>

      <div className="lg:sticky lg:top-4 lg:col-start-2 lg:row-span-4 lg:row-start-2 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
      <SuggestPanel
        id={id}
        rev={rev}
        material={() => toInput(draft)}
        measures={draft.measures.filter((m) => m.name.trim()).map((m) => ({ name: m.name.trim(), type: m.type, ...(m.unit ? { unit: m.unit } : {}) }))}
        onAdopt={(p) => setDraft((d) => ({ ...d, procedures: [...d.procedures, procedureDraft(p)] }))}
        onAdoptMeasure={adoptMeasure}
      />
      </div>

      <section aria-labelledby="measures-heading" className="space-y-3 lg:col-start-1 lg:row-start-3">
        <div className="flex items-center justify-between">
          <h2 id="measures-heading" className="text-xl font-semibold">
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

      <section aria-labelledby="procedures-heading" className="space-y-3 lg:col-start-1 lg:row-start-4">
        <div className="flex items-center justify-between">
          <h2 id="procedures-heading" className="text-xl font-semibold">
            確認の手順（繰り返し確かめる方法）
          </h2>
          <Button onClick={() => set({ procedures: [...draft.procedures, emptyProcedure()] })}>
            ＋ 手順を足す
          </Button>
        </div>
        <p className="text-slate-600 dark:text-slate-400">
          スクリプト等が無いあいだは「AI への指示」で、AI か人がそのまま実行できる具体的なやることを書く。毎回同じ動作で結果を機械的に処理できるようになったら、
          置き換え候補にスクリプトの案を書き、用意して確かめたら観測の詳細の画面で切り替える。
        </p>
        {err("procedures") && <Alert>{err("procedures")}</Alert>}
        {draft.procedures.length === 0 && <p className="text-slate-500">まだありません。</p>}
        {draft.procedures.map((p, i) => (
          <ProcedureEditor
            key={i}
            p={p}
            i={i}
            err={err}
            measureNames={measureNames}
            files={files}
            onChange={(x) => setProcedure(i, x)}
            onRemove={() => set({ procedures: draft.procedures.filter((_, j) => j !== i) })}
          />
        ))}
      </section>

      <div className="flex gap-3 lg:col-start-1 lg:row-start-5">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "保存中…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
