import { useEffect, useId, useState } from "react";
import {
  criteriaSourceView,
  SOURCE_STATE_HINT,
  SOURCE_STATE_LABEL,
  type CriterionSource,
  type RequirementSource,
  type SourceOp,
  type SourceState,
  type SourceView,
} from "../../shared/requirementSource.ts";
import { failureOf, saveErrorText } from "../lib/api.ts";
import { useUnsaved } from "../lib/unsaved.ts";
import { Badge, Button, cx, inputCls, type Tone } from "./ui.tsx";

/**
 * 要求の出典と確認（shared/requirementSource.ts）の表示と編集。要望・タスクの基準・タスク案の基準で同じ部品を使う。
 * 状態は色だけでなく文字で示す。確認記録ありは申告で P3 の保証ではない。実装後の証拠（met・根拠の種類）・人の済みとは別の欄に置く。
 * 連絡先や個人名を促す入力例は置かない（確かめた人は役割名）
 */

const STATE_TONE: Record<SourceState, Tone> = { unrecorded: "slate", unconfirmed: "amber", confirmed: "emerald", reconfirm: "rose", unlinked: "rose" };

export function SourceStateBadge({ state }: { state: SourceState }) {
  return (
    <Badge tone={STATE_TONE[state]} title={SOURCE_STATE_HINT[state]}>
      {SOURCE_STATE_LABEL[state]}
    </Badge>
  );
}

/** 保存の失敗の文言（他で変わった・規則に合わない）。入力は残す */
export function sourceSaveError(e: unknown): string {
  return failureOf(e) === "rev_conflict" ? "他で更新されました。入力は残しています。最新を読み込んでから、もう一度保存してください" : saveErrorText(e);
}

type Form = { mode: "add" } | { mode: "edit"; id: string } | { mode: "confirm"; id: string };
type Fields = { target: string; source: string; basis: string; by: string; on: string; from: string };
const EMPTY: Fields = { target: "", source: "", basis: "", by: "", on: "", from: "" };

function fieldsOf(s?: RequirementSource): Fields {
  return { ...EMPTY, target: s?.target ?? "", source: s?.source ?? "", basis: s?.basis ?? "" };
}

/** 記録1件の表示（長い出典・根拠は折り返す） */
function SourceItem({ s, children }: { s: SourceView; children?: React.ReactNode }) {
  return (
    <li className="min-w-0 space-y-1 rounded-md bg-slate-50 p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800" data-testid={`source-${s.id}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-slate-500">{s.id}</span>
        <SourceStateBadge state={s.state} />
        {s.confirmed && (
          <span className="text-base text-slate-600 dark:text-slate-400">
            確かめた人 {s.confirmed.by}・{s.confirmed.on}
          </span>
        )}
        {s.from && <span data-aux className="text-sm text-slate-500">要望の {s.from} を写したもの</span>}
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-base">
        {s.target && (
          <>
            <dt className="text-slate-500">対象</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap">{s.target}</dd>
          </>
        )}
        {s.source && (
          <>
            <dt className="text-slate-500">出典</dt>
            <dd className="min-w-0 break-all whitespace-pre-wrap">{s.source}</dd>
          </>
        )}
        {s.basis && (
          <>
            <dt className="text-slate-500">根拠</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap">{s.basis}</dd>
          </>
        )}
      </dl>
      {!!s.history?.length && (
        <p data-aux className="text-sm text-slate-500">
          前の確認: {s.history.map((h) => `${h.by}・${h.on}${h.lapsedAt ? `（${h.lapsedAt.slice(0, 10)} に効かなくなった）` : ""}`).join(" / ")}
        </p>
      )}
      {children}
    </li>
  );
}

/**
 * 記録の並びと編集。onSave が無ければ閲覧専用。onSave は操作を送り、失敗したら投げる（入力は残す）。
 * fromChoices: 写せる要望の記録（基準の記録だけ）
 */
export function SourceList({
  sources,
  onSave,
  disabled,
  withTarget = true,
  fromChoices,
  onDirty,
  label,
}: {
  sources: SourceView[];
  onSave?: (ops: SourceOp[]) => Promise<void>;
  disabled?: boolean;
  withTarget?: boolean;
  fromChoices?: RequirementSource[];
  onDirty?: (dirty: boolean) => void;
  /** 支援技術向けの対象の名前（「要望」「A1」など） */
  label: string;
}) {
  const id = useId();
  const [form, setForm] = useState<Form | null>(null);
  const [f, setF] = useState<Fields>(EMPTY);
  const [base, setBase] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !!form && JSON.stringify(f) !== JSON.stringify(base);
  useUnsaved(dirty);
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  const open = (next: Form, init: Fields) => {
    setForm(next);
    setF(init);
    setBase(init);
    setError(null);
  };
  const cancel = () => {
    setForm(null);
    setError(null);
  };
  const confirmOf = () => (f.by.trim() || f.on.trim() ? { confirm: { by: f.by, on: f.on } } : {});
  const save = async () => {
    if (!onSave || !form) return;
    const ops: SourceOp[] =
      form.mode === "add"
        ? [{ op: "add", ...(f.from ? { from: f.from } : {}), ...(withTarget || f.target ? { target: f.target } : {}), source: f.source, basis: f.basis, ...confirmOf() }]
        : form.mode === "edit"
          ? [{ op: "edit", id: form.id, ...(withTarget || f.target ? { target: f.target } : {}), source: f.source, basis: f.basis, ...confirmOf() }]
          : [{ op: "confirm", id: form.id, by: f.by, on: f.on }];
    setBusy(true);
    setError(null);
    try {
      await onSave(ops);
      setForm(null);
    } catch (e) {
      setError(sourceSaveError(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (sid: string) => {
    if (!onSave || !window.confirm(`${label} の記録 ${sid} を消しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      await onSave([{ op: "remove", id: sid }]);
    } catch (e) {
      setError(sourceSaveError(e));
    } finally {
      setBusy(false);
    }
  };
  const fid = (k: string) => `${id}-${k}`;
  const editor = form && (
    <div
      className="min-w-0 space-y-2 rounded-md p-3 ring-1 ring-indigo-200 dark:ring-indigo-900"
      role="group"
      aria-label={`${label} の出典と確認の${form.mode === "add" ? "追加" : form.mode === "edit" ? "編集" : "確認の記録"}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      {form.mode !== "confirm" && (
        <>
          {form.mode === "add" && !!fromChoices?.length && (
            <div className="min-w-0">
              <label className="block text-base" htmlFor={fid("from")}>
                要望の記録を写す（任意。確認は引き継ぎません）
              </label>
              <select id={fid("from")} className={inputCls} value={f.from} disabled={busy} onChange={(e) => setF({ ...f, from: e.target.value })}>
                <option value="">写さない</option>
                {fromChoices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} {s.source ?? s.target ?? ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(withTarget || f.target) && (
            <div className="min-w-0">
              <label className="block text-base" htmlFor={fid("target")}>
                対象の要求・前提
              </label>
              <textarea id={fid("target")} rows={2} className={inputCls} value={f.target} disabled={busy} onChange={(e) => setF({ ...f, target: e.target.value })} />
            </div>
          )}
          <div className="min-w-0">
            <label className="block text-base" htmlFor={fid("source")}>
              出典（誰の要求か・資料の名前・版・節）
            </label>
            <input id={fid("source")} className={inputCls} value={f.source} disabled={busy} onChange={(e) => setF({ ...f, source: e.target.value })} />
          </div>
          <div className="min-w-0">
            <label className="block text-base" htmlFor={fid("basis")}>
              根拠（承認された計算例・規則や契約の該当箇所など）
            </label>
            <textarea id={fid("basis")} rows={3} className={inputCls} value={f.basis} disabled={busy} onChange={(e) => setF({ ...f, basis: e.target.value })} />
          </div>
        </>
      )}
      <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2">
        <legend className="text-base text-slate-600 dark:text-slate-400">
          {form.mode === "confirm" ? "確かめた人と日（出典と根拠がそろっていること）" : "確かめたなら（任意。出典・根拠・人・日がそろうと確認記録あり）"}
        </legend>
        <div className="min-w-0">
          <label className="block min-w-0 text-base" htmlFor={fid("by")}>
            確かめた役割・アクター
          </label>
          <input id={fid("by")} className={inputCls} value={f.by} disabled={busy} onChange={(e) => setF({ ...f, by: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label className="block min-w-0 text-base" htmlFor={fid("on")}>
            確かめた日
          </label>
          <input id={fid("on")} type="date" className={inputCls} value={f.on} disabled={busy} onChange={(e) => setF({ ...f, on: e.target.value })} />
        </div>
      </fieldset>
      {dirty && <p className="text-base text-amber-700 dark:text-amber-400">未保存の変更があります</p>}
      {error && (
        <p role="alert" className="text-base break-words text-rose-600">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || disabled} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={cancel}>
          取消
        </Button>
      </div>
    </div>
  );
  return (
    <div className="min-w-0 space-y-2">
      {sources.length ? (
        <ul className="min-w-0 space-y-2">
          {sources.map((s) => (
            <SourceItem key={s.id} s={s}>
              {onSave && !(form && form.mode !== "add" && form.id === s.id) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="ghost" className="text-base" disabled={busy || disabled || !!form} onClick={() => open({ mode: "edit", id: s.id }, fieldsOf(s))}>
                    編集
                  </Button>
                  <Button variant="ghost" className="text-base" disabled={busy || disabled || !!form || s.state === "unlinked"} onClick={() => open({ mode: "confirm", id: s.id }, EMPTY)}>
                    {s.state === "confirmed" ? "確認を記録し直す" : "確認を記録"}
                  </Button>
                  <Button variant="ghost" className="text-base" disabled={busy || disabled || !!form} onClick={() => void remove(s.id)}>
                    削除
                  </Button>
                </div>
              )}
              {form && form.mode !== "add" && form.id === s.id && editor}
            </SourceItem>
          ))}
        </ul>
      ) : (
        <p className="text-base text-slate-500">記録なし（未記録）</p>
      )}
      {form?.mode === "add" && editor}
      {onSave && !form && (
        <Button variant="secondary" className="text-base" disabled={busy || disabled} onClick={() => open({ mode: "add" }, EMPTY)}>
          ＋ 出典と根拠を追加
        </Button>
      )}
      {!form && error && (
        <p role="alert" className="text-base break-words text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 受け入れ基準ごとの出典と確認（タスク・タスク案・アーカイブ）。onSave が無ければ閲覧専用。
 * 実装後の証拠・人の済みとは別の見出しで示す
 */
export function CriteriaSources({
  criteria,
  sources,
  requestSources,
  onSave,
  disabled,
  onDirty,
}: {
  criteria: { id: string; text: string }[] | undefined;
  sources: CriterionSource[] | undefined;
  requestSources?: RequirementSource[];
  onSave?: (ops: { id: string; source: SourceOp }[]) => Promise<void>;
  disabled?: boolean;
  onDirty?: (dirty: boolean) => void;
}) {
  const view = criteriaSourceView(criteria, sources, requestSources?.map((s) => s.id));
  const [dirtyBy, setDirtyBy] = useState<Record<string, boolean>>({});
  const anyDirty = Object.values(dirtyBy).some(Boolean);
  useEffect(() => onDirty?.(anyDirty), [anyDirty, onDirty]);
  const recorded = view.items.some((i) => i.sources.length) || view.orphans.length > 0;
  // 閲覧専用で記録が無ければ出さない。記録が無いうちは畳んでおく（基準の一覧を二重に見せない）
  if ((!view.items.length && !view.orphans.length) || (!onSave && !recorded)) return null;
  return (
    <section className="min-w-0" aria-label="受け入れ基準の出典と確認">
      <details className="min-w-0 space-y-2" open={recorded || undefined}>
      <summary className="cursor-pointer">
        <h3 className="inline font-semibold">受け入れ基準の出典と確認（任意）</h3>
        {!recorded && <span className="ml-2 text-base text-slate-500">記録なし（未記録）</span>}
      </summary>
      <p className="text-base text-slate-600 dark:text-slate-400">
        要求そのものの根拠（誰の要求か・承認された例など）の記録です。実装後の証拠や人の済みとは別で、確認記録ありも申告です（P3 の保証ではありません）。
      </p>
      <ul className="min-w-0 space-y-3">
        {view.items.map((i) => (
          <li key={i.id} className="min-w-0 space-y-1" data-testid={`criterion-sources-${i.id}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-slate-500">{i.id}</span>
              <SourceStateBadge state={i.state} />
              <span className="min-w-0 break-words">{i.text}</span>
            </div>
            <SourceList
              label={i.id}
              sources={i.sources}
              withTarget={false}
              fromChoices={requestSources}
              disabled={disabled}
              onDirty={(d) => setDirtyBy((cur) => (cur[i.id] === d ? cur : { ...cur, [i.id]: d }))}
              {...(onSave ? { onSave: (ops: SourceOp[]) => onSave(ops.map((source) => ({ id: i.id, source }))) } : {})}
            />
          </li>
        ))}
      </ul>
      {view.orphans.length > 0 && (
        <div className="min-w-0 space-y-1">
          <p className="text-base text-rose-700 dark:text-rose-400">対応先不明の記録（基準を消した・写した元の記録が無い）</p>
          <ul className={cx("min-w-0 space-y-2")}>
            {view.orphans.map((s) => (
              <SourceItem key={s.id} s={s}>
                <p data-aux className="text-sm text-slate-500">基準 {s.criterionId}</p>
              </SourceItem>
            ))}
          </ul>
        </div>
      )}
      </details>
    </section>
  );
}
