import type { ReactNode } from "react";
import { Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { FILE_KINDS, FILE_STATE_LABEL, fileKey, RUN_KIND_LABEL, RUN_KINDS, type FileKind, type FileState, type RunKind } from "../../shared/definition.ts";
import type { ExecDraft, ProcedureDraft, ReplacementDraft, RunDraft } from "../lib/formDraft.ts";

/**
 * 確認の手順1つの入力欄。今の実行方法（スクリプトが無いあいだは AI への指示: 前提・対象・順に行う操作・判定・測定値の記録方法）と、
 * 置き換え候補（用意するスクリプト・再現する操作・出力の形・比べる条件・切り替えの条件）。ファイルの欄には、参照先の中での有無を出す
 */
export function ProcedureEditor({
  p,
  i,
  err,
  measureNames,
  files,
  onChange,
  onRemove,
}: {
  p: ProcedureDraft;
  i: number;
  err: (path: string) => string | undefined;
  measureNames: string[];
  files: Record<string, { state: FileState }>;
  onChange: (p: ProcedureDraft) => void;
  onRemove: () => void;
}) {
  const at = `procedures[${i}]`;
  return (
    <fieldset aria-label={`手順 ${i + 1}`} className="space-y-4 rounded-lg bg-surface p-4 ring-1 ring-line">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label={`手順の名前${p.id ? `（${p.id}）` : ""}`} error={err(`${at}.title`)}>
          <input className={inputCls} value={p.title} aria-invalid={!!err(`${at}.title`)} onChange={(e) => onChange({ ...p, title: e.target.value })} />
        </Field>
        <div className="flex items-end">
          <Button onClick={onRemove}>この手順を外す</Button>
        </div>
      </div>
      <ExecutableEditor
        e={p}
        at={at}
        err={err}
        files={files}
        onChange={(x) => onChange({ ...p, ...x })}
        measures={
          <div role="group" aria-label={`手順 ${i + 1} で測る項目`} className="space-y-1">
            <span className="font-medium text-fg-2">この手順で測る項目</span>
            {measureNames.length === 0 && <p className="text-fg-4">測定項目を先に足してください。</p>}
            <div className="flex flex-wrap gap-3">
              {measureNames.map((name) => (
                <label key={name} className="flex items-center gap-1">
                  <input type="checkbox" checked={p.measures.includes(name)} onChange={(e) => onChange({ ...p, measures: e.target.checked ? [...p.measures, name] : p.measures.filter((x) => x !== name) })} />
                  {name}
                </label>
              ))}
            </div>
          </div>
        }
      />
    </fieldset>
  );
}

/** 実行できるもの1つの入力欄（手順と準備の確かめ・前処理・後処理で共通）。measures は今の実行方法と置き換え候補の間に置く欄 */
export function ExecutableEditor({ e: p, at, err, files, onChange, measures }: { e: ExecDraft; at: string; err: (path: string) => string | undefined; files: Record<string, { state: FileState }>; onChange: (e: ExecDraft) => void; measures?: ReactNode }) {
  const run = (patch: Partial<RunDraft>) => onChange({ ...p, run: { ...p.run, ...patch } });
  const rep = (patch: Partial<ReplacementDraft>) => onChange({ ...p, replacement: { ...p.replacement, ...patch } });
  const state = (repo: string, path: string) => {
    const s = files[fileKey(repo, path)]?.state;
    return s ? `ファイル: ${FILE_STATE_LABEL[s]}` : undefined;
  };
  const text = (label: string, path: string, value: string, set: (v: string) => void, o: { rows?: number; hint?: string } = {}) => (
    <Field label={label} error={err(path)} hint={o.hint}>
      {o.rows ? (
        <textarea className={inputCls} rows={o.rows} value={value} aria-invalid={!!err(path)} onChange={(e) => set(e.target.value)} />
      ) : (
        <input className={inputCls} value={value} aria-invalid={!!err(path)} onChange={(e) => set(e.target.value)} />
      )}
    </Field>
  );
  const r = p.run;
  return (
    <>
      <div className="space-y-3">
        <Field label="今の実行方法" error={err(`${at}.run.kind`)}>
          <select className={inputCls} value={r.kind} onChange={(e) => run({ kind: e.target.value as RunKind })}>
            {RUN_KINDS.map((k) => (
              <option key={k} value={k}>
                {RUN_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {r.kind === "ai-instruction" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {text("前提（任意）", `${at}.run.premise`, r.premise, (v) => run({ premise: v }), { hint: "起動しておくもの・用意するデータ" })}
            {text("対象", `${at}.run.target`, r.target, (v) => run({ target: v }), { hint: "画面の URL・コマンド・ファイル" })}
            <div className="sm:col-span-2">{text("順に行う操作（1行に1つ）", `${at}.run.steps`, r.steps, (v) => run({ steps: v }), { rows: 4 })}</div>
            {text("判定", `${at}.run.judge`, r.judge, (v) => run({ judge: v }), { hint: "何をもって期待どおりとするか" })}
            {text("測定値の記録方法", `${at}.run.record`, r.record, (v) => run({ record: v }), { hint: "どの測定項目に何を書くか" })}
          </div>
        )}
        {r.kind === "command" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {text("実行名", `${at}.run.command`, r.command, (v) => run({ command: v }), { hint: "例: pnpm" })}
            {text("引数（1行に1つ）", `${at}.run.args`, r.args, (v) => run({ args: v }), { rows: 3 })}
            {text("作業場所の参照先（任意）", `${at}.run.repo`, r.repo, (v) => run({ repo: v }))}
            {text("作業場所（参照先の中の相対パス）", `${at}.run.cwd`, r.cwd, (v) => run({ cwd: v }))}
          </div>
        )}
        {r.kind !== "ai-instruction" && r.kind !== "command" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {text("参照先", `${at}.run.repo`, r.repo, (v) => run({ repo: v }))}
            {text("ファイル（参照先の中の相対パス）", `${at}.run.path`, r.path, (v) => run({ path: v }), { hint: state(r.repo, r.path) })}
            <div className="sm:col-span-2">{text("呼び出し方（任意）", `${at}.run.invoke`, r.invoke, (v) => run({ invoke: v }))}</div>
          </div>
        )}
      </div>
      {measures}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-fg-2">置き換え候補（毎回同じ動作で、結果を機械的に処理できるようになったら用意するスクリプト）</span>
          <Button onClick={() => rep({ on: !p.replacement.on })}>{p.replacement.on ? "置き換え候補を外す" : "置き換え候補を書く"}</Button>
        </div>
        {p.replacement.on && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="種別" error={err(`${at}.replacement.kind`)}>
              <select className={inputCls} value={p.replacement.kind} onChange={(e) => rep({ kind: e.target.value as FileKind })}>
                {FILE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {RUN_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </Field>
            {text("置き換え先の参照先", `${at}.replacement.repo`, p.replacement.repo, (v) => rep({ repo: v }))}
            {text("用意するファイル", `${at}.replacement.path`, p.replacement.path, (v) => rep({ path: v }), { hint: state(p.replacement.repo, p.replacement.path) })}
            {text("呼び出し方の案（任意）", `${at}.replacement.invoke`, p.replacement.invoke, (v) => rep({ invoke: v }))}
            {text("再現する操作", `${at}.replacement.operation`, p.replacement.operation, (v) => rep({ operation: v }), { rows: 2 })}
            {text("測定値の出力形式", `${at}.replacement.output`, p.replacement.output, (v) => rep({ output: v }), { rows: 2 })}
            {text("結果を比べる条件", `${at}.replacement.compare`, p.replacement.compare, (v) => rep({ compare: v }), { rows: 2 })}
            {text("切り替えの条件", `${at}.replacement.switchWhen`, p.replacement.switchWhen, (v) => rep({ switchWhen: v }), { rows: 2 })}
          </div>
        )}
      </div>
    </>
  );
}
