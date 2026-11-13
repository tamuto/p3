import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QUALITY_LIMITS, type QualityCheck, type QualityStandard, type QualityTemplate } from "../../shared/quality.ts";
import { api, ApiError, saveErrorText, type QualityViewData } from "../lib/api.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { Badge, Button, cx, Field, inputCls, Section } from "./ui.tsx";
import { ImprovementButton } from "./ImprovementDialog.tsx";

/**
 * 設定の「品質基準」（project.yaml の quality。CLI の p3 quality と同じ core の操作）。
 *   未設定: 未設定のまま続けられることを示し、基準を直接足す・テンプレートを見る・空のまま設定する（init）を選べる（init は先に要らない）
 *   保存済み: 基準の文を見出しにして、対象・確認の方法・適用（除外）・出典を項目ごとに並べる。Q 番号は履歴を追う ID（点数・順位ではない）
 *   編集: 対象は「全参照先」か「参照先を選ぶ（複数）」。保存すると一覧を丸ごと置き換える（ID は残し、新しい行に振る）
 * 保存は編集を始めたときの版で送り、他で変わっていれば断られる（入力は残す）。P3 はコマンドを実行しない
 */

interface Row {
  key: string;
  id?: string;
  text: string;
  /** all は全参照先（repos は空で保存）、some は repos の参照先だけ */
  scope: "all" | "some";
  repos: string[];
  check: QualityCheck;
  exempt: boolean;
  reason: string;
  source?: QualityStandard["source"];
}

let rowSeq = 0;
const rowsOf = (list: readonly QualityStandard[]): Row[] =>
  list.map((s) => ({
    key: s.id,
    id: s.id,
    text: s.text,
    scope: s.repos?.length ? "some" : "all",
    repos: s.repos ?? [],
    check: s.check,
    exempt: !!s.exempt,
    reason: s.exempt?.reason ?? "",
    ...(s.source ? { source: s.source } : {}),
  }));
const reposOf = (r: Row) => (r.scope === "all" ? [] : r.repos);
const sig = (rows: readonly Row[]) => JSON.stringify(rows.map((r) => [r.id, r.text, reposOf(r), r.check, r.exempt, r.reason, r.source]));
const blankRow = (): Row => ({ key: `new-${++rowSeq}`, text: "", scope: "all", repos: [], check: { kind: "manual", reference: "" }, exempt: false, reason: "" });
const rowName = (r: Row, i: number) => r.id ?? `新しい基準 ${i + 1}`;

/** 何が足りないか（保存の前に確かめる。無ければ undefined） */
function rowProblem(r: Row): string | undefined {
  if (!r.text.trim()) return "何を守るかが空です";
  if (r.check.kind === "machine" ? !r.check.command.trim() || !r.check.success.trim() : !r.check.reference.trim()) return "確認の方法の欄が空です";
  if (r.scope === "some" && !r.repos.length) return "対象の参照先を1つ以上選んでください（全部なら「全参照先」）";
  if (r.exempt && !r.reason.trim()) return "除外の理由が空です";
  return undefined;
}

export function QualityPanel({ tick, repoNames, onDirtyChange }: { tick: number; repoNames: string[]; onDirtyChange?: (dirty: boolean) => void }) {
  const [view, setView] = useState<QualityViewData>();
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 編集の下書き（null は編集していない） */
  const [draft, setDraft] = useState<{ baseVersion: string; base: Row[]; rows: Row[]; templates: { id: string; version: number }[] } | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [preview, setPreview] = useState<QualityTemplate | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(latestOnly());
  const dirty = !!draft && (sig(draft.rows) !== sig(draft.base) || draft.templates.length > 0);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    try {
      const r = await latest.current.run(() => api.quality());
      if (r === STALE) return;
      setView(r);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const q = view?.quality;
  const saved = q?.state === "set" ? q.config.standards : [];
  const baseDraft = () => (view ? { baseVersion: view.version, base: rowsOf(saved), rows: rowsOf(saved), templates: [] } : null);
  const startEdit = (withBlank = false) => {
    const d = draft ?? baseDraft();
    if (d) setDraft(withBlank ? { ...d, rows: [...d.rows, blankRow()] } : d);
    setMsg(null);
  };
  const changedElsewhere = !!draft && !!view && view.version !== draft.baseVersion;
  const templateTitle = (id: string) => view?.templates.find((t) => t.id === id)?.title ?? id;

  async function send(ops: Parameters<typeof api.updateQuality>[0], version: string, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      setView(await api.updateQuality(ops, version));
      setDraft(null);
      setPreview(null);
      setShowTemplates(false);
      setMsg({ ok: true, text: done });
    } catch (e) {
      const conflict = e instanceof ApiError && (e.body as { code?: string } | null)?.code === "quality_conflict";
      setMsg({ ok: false, text: conflict ? "品質基準が他で変わったので保存しませんでした。入力は残してあります。「元に戻す」で最新を読み直せます" : saveErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const at = draft.rows.findIndex((r) => rowProblem(r));
    if (at >= 0) return setMsg({ ok: false, text: `${rowName(draft.rows[at], at)}: ${rowProblem(draft.rows[at])}` });
    void send(
      [
        {
          op: "replace",
          standards: draft.rows.map((r) => ({
            ...(r.id ? { id: r.id } : {}),
            text: r.text,
            repos: reposOf(r),
            check: r.check,
            ...(r.exempt ? { exemptReason: r.reason } : {}),
            ...(r.source && !r.id ? { source: r.source } : {}),
          })),
          ...(draft.templates.length ? { templates: draft.templates } : {}),
        },
      ],
      draft.baseVersion,
      "品質基準を保存しました",
    );
  }

  async function showTemplate(id: string) {
    try {
      setPreview(await api.qualityTemplate(id));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  function addTemplate(t: QualityTemplate) {
    const base = draft ?? baseDraft();
    if (!base) return;
    setDraft({
      ...base,
      rows: [
        ...base.rows,
        ...t.items.map((i): Row => ({ key: `new-${++rowSeq}`, text: i.text, scope: "all", repos: [], check: structuredClone(i.check), exempt: false, reason: "", source: { template: t.id, version: t.version, key: i.key } })),
      ],
      templates: [...base.templates.filter((x) => x.id !== t.id), { id: t.id, version: t.version }],
    });
    setPreview(null);
    setShowTemplates(false);
  }

  const setRow = (key: string, patch: Partial<Row>) => setDraft((d) => d && { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const adopted = new Set([...(q?.state === "set" ? (q.config.templates ?? []).map((t) => t.id) : []), ...(draft?.templates ?? []).map((t) => t.id)]);
  const startButtons = (
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy} onClick={() => startEdit(true)}>
        基準を追加
      </Button>
      <Button disabled={busy} aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
        テンプレートを見る
      </Button>
    </div>
  );

  return (
    <Section title="品質基準">
      <div className="space-y-5">
        <p>プロジェクトで守る条件と、その確かめ方を記録します。タスクの受け入れ基準とレビューで参照します。P3 は検査のコマンドを実行しません。</p>
        <details className="rounded-md bg-white px-3 py-2 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
          <summary className="cursor-pointer font-medium">品質基準について</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600 dark:text-slate-300">
            <li>規約・構成・検証・文書など、プロジェクトとして守る最低限の水準を書きます。CI や特定の製品・フォルダを必須にはしません</li>
            <li>確認の方法は、機械の検査（作業する側が実行するコマンドと成功の条件）か、人の確認（確かめ方・参照の資料）です</li>
            <li>テンプレートは版つきの例で、業界の標準への認証ではありません。採用すると写した基準を自由に直せます</li>
            <li>CLI でも同じ操作ができます（p3 quality。複数の参照先は --repo を繰り返す）</li>
          </ul>
        </details>
        {loadError && <p role="alert" className="text-rose-600">読み込めません: {loadError}</p>}

        {q?.state === "invalid" && (
          <div role="alert" className="space-y-2 rounded-lg bg-rose-50 p-4 text-rose-800 ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900">
            <p className="text-lg font-semibold">品質基準が読めません</p>
            <p>project.yaml の quality を直してください。読めるまでは未設定として扱い、ここから保存しても消しません。</p>
            <ul className="list-disc pl-5">
              {q.problems.map((p) => (
                <li key={p} className="break-words">
                  {p}
                </li>
              ))}
            </ul>
            <ImprovementButton source={{ type: "project" }} />
          </div>
        )}

        {q?.state === "unset" && !draft && (
          <>
            <div role="status" className="space-y-3 rounded-lg bg-indigo-50 p-4 ring-1 ring-indigo-200 dark:bg-indigo-950/60 dark:ring-indigo-900">
              <p className="text-lg font-semibold">品質基準は未設定です</p>
              <p>未設定のまま作業を続けられます。必要な基準を自分で追加するか、テンプレートの例から選べます。P3 は検査のコマンドを実行しません。</p>
              {startButtons}
            </div>
            <div className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
              <p className="text-lg font-semibold">基準を設けないと決めた場合</p>
              <p>「空のまま設定する」は、意図して基準を設けないことを記録する操作です。追加・採用の前に行う必要はありません。</p>
              <Button disabled={busy || !view} onClick={() => view && void send([{ op: "init" }], view.version, "品質基準を空のまま設定しました")}>
                空のまま設定する
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer font-medium">品質基準を決めるための要望を作る</summary>
              <div className="mt-2 space-y-2">
                <p className="text-slate-600 dark:text-slate-300">決めること自体を要望にするなら、改善要望の案を確かめて登録できます。</p>
                <ImprovementButton source={{ type: "project" }} />
              </div>
            </details>
          </>
        )}

        {q?.state === "set" && q.warnings?.map((w) => (
          <p key={w} className="text-amber-700 dark:text-amber-400">
            ⚠ {w}
          </p>
        ))}
        {view?.diffs.map((d) => (
          <div key={d.template} className="flex flex-wrap items-center gap-2 rounded-md bg-sky-50 px-3 py-2 dark:bg-sky-950">
            テンプレート {templateTitle(d.template)}（{d.template}）に新しい版があります（{d.from} → {d.to}。足す {d.added.length}・変わる {d.changed.length}・消える {d.removed.length}）。
            <Button disabled={busy || dirty} onClick={() => void send([{ op: "upgrade", template: d.template }], view.version, `テンプレート ${d.template} の差分を当てました`)}>
              差分を当てる
            </Button>
          </div>
        ))}

        {/* 保存済みの一覧（意図して空を含む） */}
        {q?.state === "set" && !draft && (
          <div className="space-y-4">
            <p className="text-slate-600 dark:text-slate-300">
              保存済み: {saved.length} 件{saved.length ? "。Q1 などの番号は基準の履歴を追う ID で、点数や順位ではありません（消した番号は使い直しません）" : ""}
            </p>
            {!saved.length && <p>品質基準を意図して空にしています。必要になったら基準を追加するか、テンプレートから選べます。</p>}
            {saved.length ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => startEdit()}>
                  品質基準を編集
                </Button>
                <Button aria-expanded={showTemplates} onClick={() => setShowTemplates((v) => !v)}>
                  テンプレートを見る
                </Button>
                {saved.some((x) => x.exempt) && <ImprovementButton source={{ type: "project" }} label="除外を見直す要望の案を確認" />}
              </div>
            ) : (
              startButtons
            )}
            <ul className="space-y-3" aria-label="保存済みの品質基準">
              {saved.map((s) => (
                <li key={s.id} className="min-w-0 space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                  <div className="flex flex-wrap items-start gap-2">
                    <h4 className="min-w-0 flex-1 text-lg font-semibold break-words">{s.text}</h4>
                    {s.exempt && <Badge tone="amber">除外</Badge>}
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-400" data-aux>
                    ID: <span className="font-mono">{s.id}</span>
                  </p>
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
                    <Item label="対象">{s.repos?.length ? s.repos.join("、") : "全参照先"}</Item>
                    <Item label="確認の方法">
                      {s.check.kind === "machine" ? (
                        <>
                          機械の検査（作業する側が実行）
                          <span className="block break-all">
                            コマンド: <code className="font-mono">{s.check.command}</code>
                          </span>
                          <span className="block">成功の条件: {s.check.success}</span>
                        </>
                      ) : (
                        <>
                          人の確認
                          <span className="block">{s.check.reference}</span>
                        </>
                      )}
                    </Item>
                    <Item label="適用">{s.exempt ? <span className="text-amber-800 dark:text-amber-300">除外（理由: {s.exempt.reason}）</span> : "適用する"}</Item>
                    <Item label="出典">{s.source ? `テンプレート ${templateTitle(s.source.template)}（${s.source.template}@${s.source.version}）` : "独自に追加した基準"}</Item>
                  </dl>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* テンプレート（開いたときだけ。中身を確かめてから編集中の一覧へ足す） */}
        {view && q?.state !== "invalid" && showTemplates && (
          <section aria-label="テンプレート" className="space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
            <p className="text-lg font-semibold">テンプレート</p>
            <p className="text-slate-600 dark:text-slate-300">版つきの例です。中身を確かめて編集中の一覧へ足し、保存すると採用になります。</p>
            <ul className="space-y-2">
              {view.templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{t.title}</span>
                  <span data-aux className="text-sm text-slate-600 dark:text-slate-400">
                    {t.id}@{t.version}・{t.items} 件
                  </span>
                  {adopted.has(t.id) ? <Badge tone="emerald">採用済み</Badge> : <Button onClick={() => void showTemplate(t.id)}>採用する前に中身を確かめる</Button>}
                </li>
              ))}
            </ul>
            {preview && (
              <section aria-label={`テンプレート ${preview.title}`} className="space-y-2 rounded-md bg-slate-50 p-3 dark:bg-slate-800/50">
                <p className="font-semibold">
                  {preview.title}（{preview.id}@{preview.version}）
                </p>
                <p className="text-slate-600 dark:text-slate-300">{preview.description}</p>
                <ul className="list-disc space-y-1 pl-5">
                  {preview.items.map((i) => (
                    <li key={i.key} className="break-words">
                      {i.text}
                      <span className="block text-slate-600 dark:text-slate-300">
                        {i.check.kind === "machine" ? `機械の検査: ${i.check.command}（${i.check.success}）` : `人の確認: ${i.check.reference}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => addTemplate(preview)}>
                    編集中の一覧へ足す
                  </Button>
                  <Button onClick={() => setPreview(null)}>閉じる</Button>
                </div>
              </section>
            )}
          </section>
        )}

        {/* 編集 */}
        {draft && (
          <div className="space-y-4">
            <p className="text-lg font-semibold">品質基準を編集</p>
            {draft.rows.map((r, i) => (
              <fieldset key={r.key} aria-label={rowName(r, i)} className="min-w-0 space-y-3 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                <legend className="sr-only">{rowName(r, i)}</legend>
                <p className="text-lg font-semibold break-words">{r.text.trim() || "新しい基準"}</p>
                <p data-aux className="text-sm text-slate-600 dark:text-slate-400">
                  {r.id ? (
                    <>
                      ID: <span className="font-mono">{r.id}</span>（保存しても変わりません）
                    </>
                  ) : (
                    "ID は保存すると振られます"
                  )}
                  {r.source ? `・出典 ${templateTitle(r.source.template)}（${r.source.template}@${r.source.version}）` : ""}
                </p>
                <Field label="何を守るか">
                  <textarea rows={2} className={inputCls} maxLength={QUALITY_LIMITS.text} value={r.text} aria-label={`${rowName(r, i)} の文`} onChange={(e) => setRow(r.key, { text: e.target.value })} />
                </Field>
                <fieldset className="min-w-0 space-y-2">
                  <legend className="font-medium text-slate-700 dark:text-slate-300">対象</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name={`${r.key}-scope`} checked={r.scope === "all"} onChange={() => setRow(r.key, { scope: "all" })} />
                    全参照先
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" name={`${r.key}-scope`} checked={r.scope === "some"} disabled={!repoNames.length} onChange={() => setRow(r.key, { scope: "some" })} />
                    参照先を選ぶ（複数選べます）
                  </label>
                  {r.scope === "some" && (
                    <div className="flex flex-wrap gap-x-4 gap-y-2 pl-6" role="group" aria-label={`${rowName(r, i)} の対象の参照先`}>
                      {repoNames.map((n) => (
                        <label key={n} className="flex items-center gap-2 break-all">
                          <input
                            type="checkbox"
                            checked={r.repos.includes(n)}
                            onChange={(e) => setRow(r.key, { repos: e.target.checked ? [...r.repos.filter((x) => x !== n), n] : r.repos.filter((x) => x !== n) })}
                          />
                          {n}
                        </label>
                      ))}
                    </div>
                  )}
                </fieldset>
                <Field label="確認の方法">
                  <select
                    className={inputCls}
                    value={r.check.kind}
                    aria-label={`${rowName(r, i)} の確認の方法`}
                    onChange={(e) => setRow(r.key, { check: e.target.value === "machine" ? { kind: "machine", command: "", success: "" } : { kind: "manual", reference: "" } })}
                  >
                    <option value="machine">機械の検査（作業する側が実行する）</option>
                    <option value="manual">人の確認</option>
                  </select>
                </Field>
                {r.check.kind === "machine" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="コマンド">
                      <input className={`${inputCls} font-mono`} value={r.check.command} onChange={(e) => r.check.kind === "machine" && setRow(r.key, { check: { ...r.check, command: e.target.value } })} />
                    </Field>
                    <Field label="成功の条件">
                      <input className={inputCls} value={r.check.success} onChange={(e) => r.check.kind === "machine" && setRow(r.key, { check: { ...r.check, success: e.target.value } })} />
                    </Field>
                  </div>
                ) : (
                  <Field label="確かめ方・参照の資料">
                    <textarea rows={2} className={inputCls} value={r.check.reference} onChange={(e) => r.check.kind === "manual" && setRow(r.key, { check: { ...r.check, reference: e.target.value } })} />
                  </Field>
                )}
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={r.exempt} onChange={(e) => setRow(r.key, { exempt: e.target.checked })} />
                  適用から除外する（理由が要ります）
                </label>
                {r.exempt && (
                  <Field label="除外の理由">
                    <input className={inputCls} value={r.reason} maxLength={QUALITY_LIMITS.reason} onChange={(e) => setRow(r.key, { reason: e.target.value })} />
                  </Field>
                )}
                <Button onClick={() => setDraft((d) => d && { ...d, rows: d.rows.filter((x) => x.key !== r.key) })}>この基準を消す</Button>
              </fieldset>
            ))}
            {!draft.rows.length && <p>基準がありません。このまま保存すると、意図して空にしたことになります。</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setDraft((d) => d && { ...d, rows: [...d.rows, blankRow()] })}>基準を足す</Button>
              {!showTemplates && <Button onClick={() => setShowTemplates(true)}>テンプレートを見る</Button>}
            </div>
            {changedElsewhere && (
              <p role="status" className="text-amber-700 dark:text-amber-400">
                編集中に品質基準が他で変わりました。入力は残してあります。このままでは保存できません（「元に戻す」で最新を読み直せます）。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy || !dirty || changedElsewhere} onClick={save}>
                品質基準を保存
              </Button>
              <Button disabled={busy} onClick={() => (setDraft(null), setPreview(null), setMsg(null))}>
                元に戻す
              </Button>
              {dirty && <span className="text-slate-600 dark:text-slate-300">保存していない変更があります</span>}
            </div>
          </div>
        )}
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={cx("break-words", msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600")}>
            {msg.text}
          </p>
        )}

        {/* 技術的な情報（版・採用したテンプレート）は主な内容から分けて、開いたときに見る */}
        {view && q?.state === "set" && (
          <details>
            <summary className="cursor-pointer font-medium">設定の版・テンプレートの採用状況</summary>
            <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Item label="設定の版">
                <span className="font-mono text-sm" data-aux>
                  {view.version}
                </span>
                <span className="block text-slate-600 dark:text-slate-300">保存のたびに変わります（CLI の --version に渡すと、他で変わっていれば保存しません）</span>
              </Item>
              <Item label="採用したテンプレート">
                {q.config.templates?.length ? q.config.templates.map((t) => `${templateTitle(t.id)}（${t.id}@${t.version}）`).join("、") : "なし"}
              </Item>
            </dl>
          </details>
        )}
      </div>
    </Section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold text-slate-700 dark:text-slate-300">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
