import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ACCEPTANCE_RESULT_LABEL,
  ACCEPTANCE_RESULTS,
  acceptanceStatus,
  basisDetail,
  basisLabel,
  basisMismatch,
  BASIS_LIMITS,
  criteriaEditOps,
  EVIDENCE_BASIS_HINT,
  EVIDENCE_BASIS_KINDS,
  EVIDENCE_BASIS_LABEL,
  evidenceBasisOf,
  type EvidenceBasis,
  type EvidenceBasisKind,
  type AcceptanceCriterion,
  type AcceptanceEvidence,
  type AcceptanceOp,
  type AcceptanceResult,
  type AcceptanceStatus,
  type CriterionState,
} from "../shared/acceptance.ts";
import type { Task } from "../../../shared/types.ts";
import { api, failureOf } from "../../../web/lib/api.ts";
import { fmtTime } from "../../../web/lib/format.ts";
import { Markdown } from "../../../web/components/Markdown.tsx";
import { Badge, Button, cx, Field, inputCls, type Tone } from "@infodb/p3-shared/web/ui.tsx";

/**
 * 受け入れ基準と証拠の部品（shared/acceptance.ts の規則を使う）。
 *   - CriteriaRowsEditor: 基準の並びの編集（追加・文の変更・削除・並べ替え）。タスク案・タスクの追加・タスク詳細で使う
 *   - AcceptanceView: 基準と証拠・不足を読むだけ（アーカイブの詳細）
 *   - AcceptancePanel: タスク詳細の基準と証拠（読む・基準を直す・証拠を残す）。保存は編集を始めたときの rev で送る
 */

/** 編集中の1行。id の無い行は新しい基準（保存するとサーバが振る） */
export interface CriterionRow {
  key: string;
  id?: string;
  text: string;
}

let rowSeq = 0;
const newRowKey = () => `new-${++rowSeq}`;

export const rowsOf = (c: readonly AcceptanceCriterion[] | undefined): CriterionRow[] => (c ?? []).map((x) => ({ key: x.id, id: x.id, text: x.text }));
export const rowsEqual = (a: readonly CriterionRow[], b: readonly CriterionRow[]) =>
  JSON.stringify(a.map((r) => [r.id ?? null, r.text])) === JSON.stringify(b.map((r) => [r.id ?? null, r.text]));
/** 空の行があるか（保存できない） */
export const rowsInvalid = (rows: readonly CriterionRow[]) => rows.some((r) => !r.text.trim());

/** 基準の並びの編集。キーボードで追加・移動・削除できる（足した行の欄へフォーカスを移す） */
export function CriteriaRowsEditor({ rows, onChange, disabled, idPrefix = "criterion" }: { rows: CriterionRow[]; onChange: (rows: CriterionRow[]) => void; disabled?: boolean; idPrefix?: string }) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  useEffect(() => {
    if (focusKey) refs.current.get(focusKey)?.focus();
  }, [focusKey]);
  const name = (r: CriterionRow, i: number) => r.id ?? `新しい項目 ${i + 1}`;
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
    setFocusKey(next[i + d].key);
  };
  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-base text-slate-500">受け入れ基準なし</p>}
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.key} className="space-y-1">
            <label htmlFor={`${idPrefix}-${r.key}`} className="font-mono text-sm text-slate-500">
              {r.id ?? "新規"}
            </label>
            <textarea
              id={`${idPrefix}-${r.key}`}
              ref={(el) => {
                if (el) refs.current.set(r.key, el);
                else refs.current.delete(r.key);
              }}
              rows={2}
              aria-label={`受け入れ基準 ${name(r, i)}`}
              className={cx(inputCls, !r.text.trim() && "ring-rose-400")}
              value={r.text}
              disabled={disabled}
              onChange={(e) => onChange(rows.map((x) => (x.key === r.key ? { ...x, text: e.target.value } : x)))}
            />
            <div className="flex flex-wrap gap-2">
              <Button className="text-base" disabled={disabled || i === 0} aria-label={`${name(r, i)} を上へ`} onClick={() => move(i, -1)}>
                上へ
              </Button>
              <Button className="text-base" disabled={disabled || i === rows.length - 1} aria-label={`${name(r, i)} を下へ`} onClick={() => move(i, 1)}>
                下へ
              </Button>
              <Button
                type="button"
                className="text-base"
                disabled={disabled}
                aria-label={`${name(r, i)} を削除`}
                onClick={() => {
                  onChange(rows.filter((x) => x.key !== r.key));
                  setFocusKey(rows[i + 1]?.key ?? rows[i - 1]?.key ?? null);
                }}
              >
                削除
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        className="text-base"
        disabled={disabled}
        onClick={() => {
          const key = newRowKey();
          onChange([...rows, { key, text: "" }]);
          setFocusKey(key);
        }}
      >
        項目を追加
      </Button>
      {rowsInvalid(rows) && <p className="text-base text-rose-600">空の項目があります。文を書くか削除してください</p>}
    </div>
  );
}

const STATE: Record<CriterionState, { label: string; tone: Tone }> = {
  met: { label: "満たした", tone: "emerald" },
  unmet: { label: "満たせなかった", tone: "rose" },
  unverified: { label: "未検証", tone: "amber" },
  missing: { label: "証拠なし", tone: "slate" },
  stale: { label: "再確認が必要", tone: "amber" },
};

/** 満たしたと申告した数と根拠の内訳（例: 「満たしたと申告 2/3、うち申告のみ 1（検査結果あり 1）」） */
export function metSummary(acc: AcceptanceStatus): string {
  const others = EVIDENCE_BASIS_KINDS.filter((k) => k !== "declaration" && acc.metByBasis[k] > 0).map((k) => `${EVIDENCE_BASIS_LABEL[k]} ${acc.metByBasis[k]}`);
  return `満たしたと申告 ${acc.met}/${acc.total}${acc.met ? `、うち申告のみ ${acc.declarationOnly.length}` : ""}${others.length ? `（${others.join("・")}）` : ""}`;
}

/** 不足の数（「済み」の近くに出す）。不足が無ければ「すべて満たした」 */
export function shortfallSummary(acc: AcceptanceStatus): string {
  const n = (s: CriterionState) => acc.items.filter((i) => i.state === s).length;
  const parts = [
    n("unmet") && `未達 ${n("unmet")} 件`,
    n("missing") && `証拠なし ${n("missing")} 件`,
    n("unverified") && `未検証 ${n("unverified")} 件`,
    n("stale") && `基準を変えた後の古い証拠 ${n("stale")} 件`,
    acc.orphans.length && `対応する基準のない証拠 ${acc.orphans.length} 件`,
    acc.problems.length && `読めない値 ${acc.problems.length} 件`,
    acc.declarationOnly.length && `申告のみの達成 ${acc.declarationOnly.length} 件（確かめた方法の記録なし）`,
  ].filter(Boolean);
  return parts.length ? `${parts.join("・")}。内容を確かめて判断してください。不足があっても「済み」にできます` : `${acc.total} 件すべてを満たした（作業した側の申告）`;
}

/** 根拠（結果と別のラベル）。古い証拠は「種類未記録」、読んだもの・検査の項目を並べる */
function BasisView({ e }: { e: AcceptanceEvidence }) {
  const { basis, recorded } = evidenceBasisOf(e);
  const tone: Tone = basis.kind === "declaration" ? "amber" : basis.kind === "unverified" ? "slate" : "indigo";
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-base text-slate-500 dark:text-slate-400">根拠</span>
        <Badge tone={tone}>{basisLabel(e)}</Badge>
      </p>
      <p className="text-base text-slate-500 dark:text-slate-400">{recorded ? EVIDENCE_BASIS_HINT[basis.kind] : "根拠の種類を記録する前の証拠です（申告として読みます）"}</p>
      {basisDetail(basis).length > 0 && (
        <dl className="grid min-w-0 gap-x-2 text-base sm:grid-cols-[auto_1fr]">
          {basisDetail(basis).map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-slate-500 dark:text-slate-400">{d.label}</dt>
              <dd className="min-w-0 font-mono break-all whitespace-pre-wrap">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function EvidenceBody({ e }: { e: AcceptanceEvidence }) {
  return (
    <div className="min-w-0 space-y-1">
      <BasisView e={e} />
      {e.evidence.trim() ? (
        <div className="min-w-0 break-words [&_a]:break-all [&_code]:break-all">
          <Markdown text={e.evidence} />
        </div>
      ) : (
        <p className="text-base text-slate-500">（本文なし）</p>
      )}
      <p className="text-base text-slate-500 dark:text-slate-400">
        {fmtTime(e.recordedAt)}
        {e.recordedBy ? ` · ${e.recordedBy}` : ""}
      </p>
    </div>
  );
}

/** 基準1項目（左に基準、右に結果と証拠。狭い画面では縦に積む） */
function CriterionItem({ id, text, state, evidence, staleFrom, children }: { id: string; text: string; state: CriterionState; evidence?: AcceptanceEvidence; staleFrom?: string; children?: ReactNode }) {
  return (
    <li className="grid min-w-0 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2 dark:bg-slate-800/50" aria-label={`受け入れ基準 ${id}`}>
      <div className="min-w-0 space-y-1">
        <p className="font-mono text-sm font-semibold">{id}</p>
        <p className="break-words">{text}</p>
      </div>
      <div className="min-w-0 space-y-2">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-base text-slate-500 dark:text-slate-400">結果</span>
          <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>
        </p>
        {staleFrom !== undefined && <p className="text-base break-words text-amber-700 dark:text-amber-400">記録したときの基準: {staleFrom}</p>}
        {evidence ? <EvidenceBody e={evidence} /> : <p className="text-base text-slate-500">確認の材料がありません</p>}
        {children}
      </div>
    </li>
  );
}

/** 基準と証拠・不足を読むだけ（アーカイブの詳細） */
export function AcceptanceView({ task }: { task: Task }) {
  const acc = acceptanceStatus(task);
  if (!acc) return <p className="text-base text-slate-500 dark:text-slate-400">受け入れ基準なし</p>;
  return (
    <div className="space-y-2">
      <p className="text-base text-slate-500">証拠は作業した側の申告です（{metSummary(acc)}）</p>
      <Problems acc={acc} />
      <ul className="space-y-2">
        {acc.items.map((i) => (
          <CriterionItem key={i.id} {...i} staleFrom={i.state === "stale" ? i.evidence?.criterionText : undefined} />
        ))}
        {acc.orphans.map((e) => (
          <CriterionItem key={`orphan-${e.criterionId}`} id={e.criterionId} text={`（基準は消されています）${e.criterionText}`} state={e.result} evidence={e} />
        ))}
      </ul>
      {acc.shortfalls.length > 0 && <p className="text-base text-amber-700 dark:text-amber-400">{shortfallSummary(acc)}</p>}
    </div>
  );
}

function Problems({ acc }: { acc: AcceptanceStatus }) {
  if (!acc.problems.length) return null;
  return (
    <div role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-base text-rose-800 dark:bg-rose-950 dark:text-rose-300">
      <p>ファイルの受け入れ基準・証拠に読めない値があります（直すまで画面からは変えられません。ほかの保存では元の値を残します）:</p>
      <ul className="list-disc pl-5">
        {acc.problems.map((p) => (
          <li key={p} className="break-words">
            {p}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 根拠の入力（種類ごとの欄。使わない欄も残し、種類を戻したときに消えないようにする） */
interface BasisInput {
  kind: EvidenceBasisKind;
  reference: string;
  command: string;
  result: string;
  target: string;
}

const basisInputOf = (e?: AcceptanceEvidence): BasisInput => {
  const b = e ? evidenceBasisOf(e).basis : ({ kind: "declaration" } as EvidenceBasis);
  return { kind: b.kind, reference: b.kind === "read" ? b.reference : "", command: b.kind === "machine" ? b.command : "", result: b.kind === "machine" ? b.result : "", target: b.kind === "machine" ? b.target : "" };
};

/** 入力を保存する根拠にする（欄の空白は shared の cleanBasis が除く） */
const basisOfInput = (b: BasisInput): EvidenceBasis =>
  b.kind === "read" ? { kind: "read", reference: b.reference } : b.kind === "machine" ? { kind: "machine", command: b.command, result: b.result, target: b.target } : { kind: b.kind };

/** 種類に要る欄がそろっているか（そろっていなければ理由） */
function basisMissing(b: BasisInput): string | undefined {
  if (b.kind === "read" && !b.reference.trim()) return "読んだものと確かめた内容を書いてください";
  if (b.kind === "machine") {
    const lack = [!b.command.trim() && "コマンド", !b.result.trim() && "結果", !b.target.trim() && "対象"].filter(Boolean);
    if (lack.length) return `検査の${lack.join("・")}を書いてください`;
  }
  return undefined;
}

/** 根拠の入力の比較（使っている種類の欄だけ） */
const basisKey = (b: BasisInput) => JSON.stringify(basisOfInput(b));

type Editing =
  | { kind: "criteria"; baseRev: number; base: AcceptanceCriterion[]; rows: CriterionRow[] }
  | {
      kind: "evidence";
      id: string;
      baseRev: number;
      baseResult: AcceptanceResult | "";
      baseText: string;
      baseBasis: BasisInput;
      result: AcceptanceResult | "";
      text: string;
      basis: BasisInput;
    };

const editingDirty = (e: Editing | null) =>
  !!e && (e.kind === "criteria" ? !rowsEqual(e.rows, rowsOf(e.base)) : e.result !== e.baseResult || e.text !== e.baseText || basisKey(e.basis) !== basisKey(e.baseBasis));

/** 結果を変えたときの根拠の種類（unverified は未確認だけ。未確認から満たした・満たせなかったへは申告のみ） */
const kindForResult = (result: AcceptanceResult | "", kind: EvidenceBasisKind): EvidenceBasisKind =>
  result === "unverified" ? "unverified" : kind === "unverified" ? "declaration" : kind;

/**
 * タスク詳細の受け入れ基準と証拠。基準の編集と証拠の編集はどちらか1つずつ（保存・取消）。保存は編集を始めたときの rev で送り、
 * 他で変わっていれば入力を残したまま知らせる（「最新に合わせる」で今の rev から保存し直せる）。取り直しで入力は消さない
 */
export function AcceptancePanel({
  task,
  disabled,
  onSaved,
  onDirty,
}: {
  task: Task;
  disabled: boolean;
  /** 保存した（checkCleared: 済みを外した理由） */
  onSaved: (checkCleared?: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = editingDirty(editing);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // 別のタスクに切り替わったら編集をやめる
  useEffect(() => {
    setEditing(null);
    setError(null);
    setConflict(false);
  }, [task.request, task.id]);

  const acc = acceptanceStatus(task);
  const locked = disabled || !!acc?.problems.length;
  // 保存できない入力（空の基準・本文の無い「満たした」・根拠の欄の不足）
  const invalid =
    !!editing &&
    (editing.kind === "criteria" ? rowsInvalid(editing.rows) : (editing.result === "met" && !editing.text.trim()) || (editing.result !== "" && !!basisMissing(editing.basis)));
  const external = !!editing && editing.baseRev !== task.rev;

  const start = (e: Editing) => {
    setEditing(e);
    setError(null);
    setConflict(false);
  };
  const cancel = () => {
    setEditing(null);
    setError(null);
    setConflict(false);
  };
  /** 他で変わった後、入力を残したまま今の内容に合わせる（基準の編集は今の基準と比べ直す） */
  const rebase = () => {
    setEditing((e) => e && (e.kind === "criteria" ? { ...e, baseRev: task.rev, base: task.acceptanceCriteria ?? [] } : { ...e, baseRev: task.rev }));
    setConflict(false);
    setError(null);
  };

  async function send(ops: AcceptanceOp[], baseRev: number) {
    if (!ops.length) return cancel();
    setBusy(true);
    try {
      const res = await api.patchTask(`${task.request}/${task.id}`, { acceptance: ops, rev: baseRev });
      cancel();
      onSaved(res.checkCleared);
    } catch (e) {
      if (failureOf(e) === "rev_conflict") {
        setConflict(true);
        setError("保存する前に他で更新されました。入力は残してあります。最新の内容を確かめてから「最新に合わせる」で保存し直せます");
      } else setError(`保存できませんでした: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!editing) return;
    if (editing.kind === "criteria") {
      if (rowsInvalid(editing.rows)) return setError("空の項目があります。文を書くか削除してください");
      return send(criteriaEditOps({ ...task, acceptanceCriteria: editing.base }, editing.rows), editing.baseRev);
    }
    if (editing.result === "") return send([{ op: "unrecord", id: editing.id }], editing.baseRev);
    // 根拠に触れていなければ送らない（古い証拠を開いて本文だけ直しても、根拠を足したことにしない。サーバが前の根拠を引き継ぐ）
    const touched = basisKey(editing.basis) !== basisKey(editing.baseBasis) || editing.result !== editing.baseResult;
    const basis = basisOfInput(editing.basis);
    if (touched && basisMismatch(editing.result, basis)) return setError(basisMismatch(editing.result, basis)!);
    return send([{ op: "record", id: editing.id, result: editing.result, evidence: editing.text, ...(touched ? { basis } : {}) }], editing.baseRev);
  }

  const notice = editing && (
    <>
      {external && !conflict && (
        <p role="status" className="text-base text-amber-700 dark:text-amber-400">
          編集中に他で更新されました（rev {task.rev}）。このまま保存すると競合になります。
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-base text-rose-600">
          <span className="min-w-0 break-words">{error}</span>
          {conflict && (
            <Button className="text-base" onClick={rebase}>
              最新に合わせる
            </Button>
          )}
        </div>
      )}
    </>
  );

  const actions = (label: string) => (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy || !dirty || conflict || invalid} onClick={() => void save()}>
        {busy ? "保存中…" : label}
      </Button>
      <Button disabled={busy} onClick={cancel}>
        取消
      </Button>
    </div>
  );

  if (editing?.kind === "criteria") {
    return (
      <div className="space-y-3">
        <p className="text-base text-slate-500">基準の文を変えると、その基準の証拠は「再確認が必要」になります。済みの後に基準・証拠を変えると済みが外れます。</p>
        <CriteriaRowsEditor rows={editing.rows} disabled={busy} idPrefix={`task-${task.id}`} onChange={(rows) => setEditing({ ...editing, rows })} />
        {notice}
        {actions("基準を保存")}
      </div>
    );
  }

  const evidenceEditor = (id: string) =>
    editing?.kind === "evidence" && editing.id === id ? (
      <div className="space-y-2 rounded-md bg-white p-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
        <Field label="作業した側の結果">
          <select
            className={inputCls}
            value={editing.result}
            disabled={busy}
            onChange={(e) => {
              const result = e.target.value as AcceptanceResult | "";
              setEditing({ ...editing, result, basis: { ...editing.basis, kind: kindForResult(result, editing.basis.kind) } });
            }}
          >
            {ACCEPTANCE_RESULTS.map((r) => (
              <option key={r} value={r}>
                {ACCEPTANCE_RESULT_LABEL[r]}
              </option>
            ))}
            {editing.baseResult !== "" && <option value="">証拠を消す</option>}
          </select>
        </Field>
        {editing.result !== "" && (
          <Field
            label={editing.result === "met" ? "証拠（必須）" : "証拠・満たせなかった／確かめていない理由"}
            hint="実行したコマンドと結果・確かめた内容・成果物の場所を書きます。確かめていなければそう書きます"
          >
            <textarea rows={4} className={`${inputCls} font-mono`} value={editing.text} disabled={busy} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          </Field>
        )}
        {editing.result === "met" && !editing.text.trim() && <p className="text-base text-rose-600">満たしたときは証拠を書いてください</p>}
        {editing.result !== "" && <BasisEditor value={editing.basis} result={editing.result} disabled={busy} idPrefix={`basis-${task.id}-${id}`} onChange={(basis) => setEditing({ ...editing, basis })} />}
        {notice}
        {actions(editing.result === "" ? "証拠を消す" : "証拠を保存")}
      </div>
    ) : null;

  const editEvidence = (id: string, e?: AcceptanceEvidence) =>
    start({
      kind: "evidence",
      id,
      baseRev: task.rev,
      baseResult: e?.result ?? "",
      baseText: e?.evidence ?? "",
      baseBasis: basisInputOf(e),
      result: e?.result ?? "met",
      text: e?.evidence ?? "",
      basis: basisInputOf(e),
    });

  return (
    <div className="space-y-3">
      {acc ? (
        <p className="text-base text-slate-500">証拠と根拠は作業した側の申告です。人が内容を確かめて「済み」（最終確認）を決めます（{metSummary(acc)}）</p>
      ) : (
        <p className="text-base text-slate-500 dark:text-slate-400">受け入れ基準なし</p>
      )}
      {acc && <Problems acc={acc} />}
      {acc && (
        <ul className="space-y-2">
          {acc.items.map((i) => (
            <CriterionItem key={i.id} {...i} staleFrom={i.state === "stale" ? i.evidence?.criterionText : undefined}>
              {evidenceEditor(i.id) ?? (
                <Button className="text-base" disabled={locked || !!editing} aria-label={`${i.id} の証拠を${i.evidence ? "編集" : "登録"}`} onClick={() => editEvidence(i.id, i.evidence)}>
                  {i.evidence ? "証拠を編集" : "証拠を登録"}
                </Button>
              )}
            </CriterionItem>
          ))}
          {acc.orphans.map((e) => (
            <CriterionItem key={`orphan-${e.criterionId}`} id={e.criterionId} text={`（基準は消されています）${e.criterionText}`} state={e.result} evidence={e}>
              <Button className="text-base" disabled={locked || !!editing} aria-label={`${e.criterionId} の証拠を消す`} onClick={() => void send([{ op: "unrecord", id: e.criterionId }], task.rev)}>
                証拠を消す
              </Button>
            </CriterionItem>
          ))}
        </ul>
      )}
      {!editing && error && <p className="text-base text-rose-600">{error}</p>}
      <Button className="text-base" disabled={locked || !!editing} onClick={() => start({ kind: "criteria", baseRev: task.rev, base: task.acceptanceCriteria ?? [], rows: rowsOf(task.acceptanceCriteria) })}>
        {task.acceptanceCriteria?.length ? "基準を編集" : "基準を足す"}
      </Button>
    </div>
  );
}

/**
 * 根拠の入力。種類は結果に合うものだけを選べる（未検証は未確認だけ、満たした・満たせなかったは申告のみ・読んで確認・検査結果あり）。
 * 検査結果ありは作業した側が記録した結果で、P3 は実行しない。AI のレビューはここからは動かさない
 */
function BasisEditor({ value, result, disabled, idPrefix, onChange }: { value: BasisInput; result: AcceptanceResult; disabled: boolean; idPrefix: string; onChange: (b: BasisInput) => void }) {
  const kinds = EVIDENCE_BASIS_KINDS.filter((k) => (result === "unverified" ? k === "unverified" : k !== "unverified"));
  const set = (patch: Partial<BasisInput>) => onChange({ ...value, ...patch });
  const missing = basisMissing(value);
  const text = (key: "reference" | "command" | "result" | "target", label: string, hint: string, rows = 1) => (
    <Field label={label} hint={hint}>
      {rows > 1 ? (
        <textarea id={`${idPrefix}-${key}`} rows={rows} maxLength={BASIS_LIMITS[key]} className={`${inputCls} font-mono`} value={value[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.value })} />
      ) : (
        <input id={`${idPrefix}-${key}`} maxLength={BASIS_LIMITS[key]} className={`${inputCls} font-mono`} value={value[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.value })} />
      )}
    </Field>
  );
  return (
    <div className="space-y-2">
      <Field label="根拠の種類" hint={EVIDENCE_BASIS_HINT[value.kind]}>
        <select className={inputCls} value={value.kind} disabled={disabled || kinds.length < 2} onChange={(e) => set({ kind: e.target.value as EvidenceBasisKind })}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {EVIDENCE_BASIS_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      {value.kind === "read" && text("reference", "読んだもの（必須）", "読んだコード・資料・画面と、確かめた内容", 2)}
      {value.kind === "machine" && (
        <>
          {text("command", "検査のコマンド（必須）", "実行したコマンド")}
          {text("result", "検査の結果（必須）", "終了コードと結果。失敗もそのまま書きます", 2)}
          {text("target", "対象（必須）", "参照先とコミット（例: app:3f2a1c0）。未コミットならそう書きます")}
        </>
      )}
      {missing && <p className="text-base text-rose-600">{missing}</p>}
    </div>
  );
}
