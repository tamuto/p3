import { Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { useState } from "react";
import { filesOf, fileKey, type DefinitionProblem } from "../../shared/definition.ts";
import { SLOT_HINT, SLOT_LABEL, SLOTS, validatePreparationInput, type Preparation, type PreparationInput, type Slot } from "../../shared/preparation.ts";
import { ObserverApiError } from "../lib/api.ts";
import { emptyExec, execDraft, execInput, type ExecDraft } from "../lib/formDraft.ts";
import { useFileStates } from "../lib/files.ts";
import { ExecutableEditor } from "./ProcedureEditor.tsx";
import { SaveProblems } from "./SaveProblems.tsx";

interface PrepDraft {
  name: string;
  description: string;
  /** 1行に1つ */
  exclusive: string;
  slots: Partial<Record<Slot, ExecDraft>>;
}

const toDraft = (p?: Partial<PreparationInput>): PrepDraft => ({
  name: p?.name ?? "",
  description: p?.description ?? "",
  exclusive: (p?.exclusive ?? []).join("\n"),
  slots: Object.fromEntries(SLOTS.flatMap((s) => (p?.[s] ? [[s, execDraft(p[s])]] : []))),
});
const toInput = (d: PrepDraft) => ({
  name: d.name,
  description: d.description,
  exclusive: d.exclusive.split("\n").filter((x) => x.trim()),
  ...Object.fromEntries(SLOTS.flatMap((s) => (d.slots[s] ? [[s, execInput(d.slots[s])]] : []))),
});

/**
 * 準備の入力欄（登録と編集で共通）。名前・説明・占有と、確かめ・前処理・後処理（どれも任意。確認の手順と同じ実行方法の入力欄）。
 * 保存の前に共通の検証（shared/preparation.ts）で項目ごとの誤りを出し、保存の応答の誤り（名前の重複など）も同じ場所に出す
 */
export function PreparationForm({ initial, submitLabel, onSave, onSaved }: { initial?: Partial<PreparationInput>; submitLabel: string; onSave: (input: unknown) => Promise<Preparation>; onSaved: (p: Preparation) => void }) {
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [problems, setProblems] = useState<DefinitionProblem[]>([]);
  const [error, setError] = useState<{ message: string; conflict?: { rev: number } }>();
  const [saving, setSaving] = useState(false);
  const err = (path: string) => problems.find((p) => p.path === path)?.message;
  const setSlot = (s: Slot, e: ExecDraft | undefined) => setDraft((d) => ({ ...d, slots: { ...d.slots, [s]: e } }));
  const execs = SLOTS.flatMap((s) => (draft.slots[s] ? [draft.slots[s]] : []));
  const files = useFileStates(filesOf(execs.map((e) => ({ run: e.run as never, replacement: e.replacement.on ? (e.replacement as never) : undefined }))).map((f) => fileKey(f.repo, f.path)));

  async function submit() {
    setError(undefined);
    const v = validatePreparationInput(toInput(draft));
    setProblems(v.ok ? [] : v.problems);
    if (!v.ok) return;
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
  const field = (key: "name" | "description" | "exclusive", label: string, hint?: string, rows?: number) => (
    <Field label={label} hint={hint} error={err(key) ?? (key === "exclusive" ? problems.find((p) => p.path.startsWith("exclusive["))?.message : undefined)}>
      {rows ? (
        <textarea className={inputCls} rows={rows} value={draft[key]} aria-invalid={!!err(key)} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      ) : (
        <input className={inputCls} value={draft[key]} aria-invalid={!!err(key)} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      )}
    </Field>
  );

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SaveProblems problems={problems} error={error} />
      <section aria-labelledby="prep-items-heading" className="space-y-3">
        <h2 id="prep-items-heading" className="text-xl font-semibold">
          準備の項目
        </h2>
        {field("name", "名前", "観測から参照する名前（このプロジェクトの中で一意）")}
        {field("description", "説明（任意）", "何の状態を作る・戻すか", 3)}
        {field("exclusive", "占有（任意。1行に1つ）", "同時に走らせないもの（データ・アカウントなど）", 3)}
      </section>
      {SLOTS.map((s) => {
        const e = draft.slots[s];
        return (
          <section key={s} aria-labelledby={`slot-${s}`} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={`slot-${s}`} className="text-xl font-semibold">
                {SLOT_LABEL[s]}（任意）
              </h2>
              <Button onClick={() => setSlot(s, e ? undefined : emptyExec())}>{e ? `${SLOT_LABEL[s]}を外す` : `＋ ${SLOT_LABEL[s]}を書く`}</Button>
            </div>
            <p className="text-fg-3">{SLOT_HINT[s]}</p>
            {e && (
              <fieldset aria-label={SLOT_LABEL[s]} className="space-y-4 rounded-lg bg-surface p-4 ring-1 ring-line">
                <ExecutableEditor e={e} at={s} err={err} files={files} onChange={(x) => setSlot(s, x)} />
              </fieldset>
            )}
          </section>
        );
      })}
      <Button type="submit" variant="primary" disabled={saving}>
        {saving ? "保存中…" : submitLabel}
      </Button>
    </form>
  );
}
