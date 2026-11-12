import { useCallback, useEffect, useRef, useState } from "react";
import { checkLine, QUALITY_LIMITS, type QualityCheck, type QualityStandard, type QualityTemplate } from "../../shared/quality.ts";
import { api, ApiError, saveErrorText, type QualityViewData } from "../lib/api.ts";
import { latestOnly, STALE } from "../lib/latest.ts";
import { Badge, Button, cx, Field, inputCls, Section } from "./ui.tsx";

/**
 * 設定の「品質基準」（project.yaml の quality。CLI の p3 quality と同じ core の操作）。未設定なら案内し、テンプレートを採用する前に中身を
 * 確かめて編集中の一覧へ足せる。対象・確認の方法・除外の理由を直し、保存すると一覧を丸ごと置き換える（ID は残し、新しい行に振る）。
 * 保存は編集を始めたときの版で送り、他で変わっていれば断られる（入力は残す）。P3 はコマンドを実行しない
 */

interface Row {
  key: string;
  id?: string;
  text: string;
  repos: string[];
  check: QualityCheck;
  exempt: boolean;
  reason: string;
  source?: QualityStandard["source"];
}

let rowSeq = 0;
const rowsOf = (list: readonly QualityStandard[]): Row[] =>
  list.map((s) => ({ key: s.id, id: s.id, text: s.text, repos: s.repos ?? [], check: s.check, exempt: !!s.exempt, reason: s.exempt?.reason ?? "", ...(s.source ? { source: s.source } : {}) }));
const sig = (rows: readonly Row[]) => JSON.stringify(rows.map(({ key: _k, ...r }) => r));

export function QualityPanel({ tick, repoNames, onDirtyChange }: { tick: number; repoNames: string[]; onDirtyChange?: (dirty: boolean) => void }) {
  const [view, setView] = useState<QualityViewData>();
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 編集の下書き（null は編集していない） */
  const [draft, setDraft] = useState<{ baseVersion: string; base: Row[]; rows: Row[]; templates: { id: string; version: number }[] } | null>(null);
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
  const startEdit = () => view && setDraft({ baseVersion: view.version, base: rowsOf(saved), rows: rowsOf(saved), templates: [] });
  const changedElsewhere = !!draft && !!view && view.version !== draft.baseVersion;

  async function send(ops: Parameters<typeof api.updateQuality>[0], version: string, done: string) {
    setBusy(true);
    setMsg(null);
    try {
      setView(await api.updateQuality(ops, version));
      setDraft(null);
      setPreview(null);
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
    const bad = draft.rows.find((r) => !r.text.trim() || (r.exempt && !r.reason.trim()) || (r.check.kind === "machine" ? !r.check.command.trim() || !r.check.success.trim() : !r.check.reference.trim()));
    if (bad) return setMsg({ ok: false, text: `${bad.id ?? "新しい基準"} に空の欄があります（文・確認の方法・除外の理由）` });
    void send(
      [
        {
          op: "replace",
          standards: draft.rows.map((r) => ({
            ...(r.id ? { id: r.id } : {}),
            text: r.text,
            repos: r.repos,
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
    const base = draft ?? (view ? { baseVersion: view.version, base: rowsOf(saved), rows: rowsOf(saved), templates: [] } : null);
    if (!base) return;
    setDraft({
      ...base,
      rows: [...base.rows, ...t.items.map((i) => ({ key: `new-${++rowSeq}`, text: i.text, repos: [], check: structuredClone(i.check), exempt: false, reason: "", source: { template: t.id, version: t.version, key: i.key } }))],
      templates: [...base.templates.filter((x) => x.id !== t.id), { id: t.id, version: t.version }],
    });
    setPreview(null);
  }

  const setRow = (key: string, patch: Partial<Row>) => setDraft((d) => d && { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const adopted = new Set([...(q?.state === "set" ? (q.config.templates ?? []).map((t) => t.id) : []), ...(draft?.templates ?? []).map((t) => t.id)]);

  return (
    <Section title="品質基準">
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          プロジェクトとして守る最低限の水準（規約・構成・検証・文書など）。確認の方法は機械の検査（コマンドと成功の条件）か人の確認で、P3 はコマンドを実行しません。CI
          や特定の製品・フォルダを必須にはしません。テンプレートは版つきの例で、業界の標準への認証ではありません。
        </p>
        {loadError && <p role="alert" className="text-sm text-rose-600">読み込めません: {loadError}</p>}
        {q?.state === "unset" && !draft && (
          <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            品質基準は未設定です（初めて作ったときの状態に任せています）。未設定のまま作業を続けることもできます。テンプレートの中身を確かめて採用するか、空のまま設定できます。
          </div>
        )}
        {q?.state === "invalid" && (
          <div role="alert" className="space-y-1 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            <p>project.yaml の quality が読めません（未設定として扱い、保存しても消しません）。ファイルを直してください:</p>
            <ul className="list-disc pl-5">
              {q.problems.map((p) => (
                <li key={p} className="break-words">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        )}
        {view && q?.state !== "invalid" && (
          <p className="text-sm text-slate-500">
            保存済み: {q?.state === "unset" ? "未設定" : `${saved.length} 件`}・版 <span className="font-mono">{view.version}</span>
            {q?.state === "set" && q.config.templates?.length ? `・テンプレート ${q.config.templates.map((t) => `${t.id}@${t.version}`).join(", ")}` : ""}
          </p>
        )}
        {q?.state === "set" && q.warnings?.map((w) => (
          <p key={w} className="text-sm text-amber-700 dark:text-amber-400">
            ⚠ {w}
          </p>
        ))}
        {view?.diffs.map((d) => (
          <div key={d.template} className="flex flex-wrap items-center gap-2 rounded-md bg-sky-50 px-3 py-2 text-sm dark:bg-sky-950">
            テンプレート {d.template} に新しい版があります（{d.from} → {d.to}。足す {d.added.length}・変わる {d.changed.length}・消える {d.removed.length}）。
            <Button className="text-sm" disabled={busy || dirty} onClick={() => void send([{ op: "upgrade", template: d.template }], view.version, `テンプレート ${d.template} の差分を当てました`)}>
              差分を当てる
            </Button>
          </div>
        ))}

        {/* テンプレート */}
        {view && q?.state !== "invalid" && (
          <div className="space-y-2">
            <p className="font-medium">テンプレート</p>
            <ul className="space-y-1">
              {view.templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">
                    {t.id}@{t.version}
                  </span>
                  <span>{t.title}</span>
                  <span className="text-sm text-slate-500">{t.items} 件</span>
                  {adopted.has(t.id) ? <Badge tone="emerald">採用済み</Badge> : <Button className="text-sm" onClick={() => void showTemplate(t.id)}>採用する前に中身を確かめる</Button>}
                </li>
              ))}
            </ul>
            {preview && (
              <section aria-label={`テンプレート ${preview.title}`} className="space-y-2 rounded-md bg-slate-50 p-3 dark:bg-slate-800/50">
                <p className="font-medium">
                  {preview.title}（{preview.id}@{preview.version}）
                </p>
                <p className="text-sm text-slate-500">{preview.description}</p>
                <ul className="space-y-1 text-sm">
                  {preview.items.map((i) => (
                    <li key={i.key} className="break-words">
                      {i.text}
                      <span className="block text-slate-500">{checkLine(i.check)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button className="text-sm" variant="primary" onClick={() => addTemplate(preview)}>
                    編集中の一覧へ足す
                  </Button>
                  <Button className="text-sm" onClick={() => setPreview(null)}>
                    閉じる
                  </Button>
                </div>
              </section>
            )}
            {q?.state === "unset" && !draft && (
              <Button className="text-sm" disabled={busy} onClick={() => void send([{ op: "init" }], view.version, "品質基準を空のまま設定しました")}>
                空のまま設定する
              </Button>
            )}
          </div>
        )}

        {/* 一覧と編集 */}
        {q?.state !== "invalid" && !draft && q?.state === "set" && (
          <div className="space-y-2">
            {!saved.length && <p className="text-sm text-slate-400">（品質基準を意図して空にしています）</p>}
            <ul className="space-y-1">
              {saved.map((s) => (
                <li key={s.id} className="min-w-0 break-words">
                  <span className="font-mono text-sm text-slate-500">{s.id}</span> {s.text}
                  {s.repos?.length ? <span className="text-sm text-slate-500"> [{s.repos.join(", ")}]</span> : null}
                  {s.exempt && <Badge tone="amber" className="ml-1">除外</Badge>}
                  <span className="block text-sm text-slate-500">{checkLine(s.check)}</span>
                  {s.exempt && <span className="block text-sm text-amber-700 dark:text-amber-400">除外の理由: {s.exempt.reason}</span>}
                </li>
              ))}
            </ul>
            <Button className="text-sm" onClick={startEdit}>
              品質基準を編集
            </Button>
          </div>
        )}
        {draft && (
          <div className="space-y-3">
            {draft.rows.map((r) => (
              <fieldset key={r.key} className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700">
                <legend className="px-1 font-mono text-sm text-slate-500">{r.id ?? "新しい基準"}{r.source ? `（${r.source.template}@${r.source.version}）` : ""}</legend>
                <Field label="何を守るか">
                  <textarea rows={2} className={inputCls} maxLength={QUALITY_LIMITS.text} value={r.text} aria-label={`${r.id ?? "新しい基準"} の文`} onChange={(e) => setRow(r.key, { text: e.target.value })} />
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="対象（参照先。選ばなければ全部）">
                    <select
                      multiple
                      className={cx(inputCls, "h-20")}
                      value={r.repos}
                      aria-label={`${r.id ?? "新しい基準"} の対象`}
                      onChange={(e) => setRow(r.key, { repos: [...e.target.selectedOptions].map((o) => o.value) })}
                    >
                      {repoNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="確認の方法">
                    <select
                      className={inputCls}
                      value={r.check.kind}
                      aria-label={`${r.id ?? "新しい基準"} の確認の方法`}
                      onChange={(e) => setRow(r.key, { check: e.target.value === "machine" ? { kind: "machine", command: "", success: "" } : { kind: "manual", reference: "" } })}
                    >
                      <option value="machine">機械の検査（作業する側が実行する）</option>
                      <option value="manual">人の確認</option>
                    </select>
                  </Field>
                </div>
                {r.check.kind === "machine" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
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
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={r.exempt} onChange={(e) => setRow(r.key, { exempt: e.target.checked })} />
                  適用から除外する（理由が要ります）
                </label>
                {r.exempt && (
                  <Field label="除外の理由">
                    <input className={inputCls} value={r.reason} maxLength={QUALITY_LIMITS.reason} onChange={(e) => setRow(r.key, { reason: e.target.value })} />
                  </Field>
                )}
                <Button className="text-sm" onClick={() => setDraft((d) => d && { ...d, rows: d.rows.filter((x) => x.key !== r.key) })}>
                  この基準を消す
                </Button>
              </fieldset>
            ))}
            <Button
              className="text-sm"
              onClick={() => setDraft((d) => d && { ...d, rows: [...d.rows, { key: `new-${++rowSeq}`, text: "", repos: [], check: { kind: "manual", reference: "" }, exempt: false, reason: "" }] })}
            >
              基準を足す
            </Button>
            {changedElsewhere && (
              <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                編集中に品質基準が他で変わりました。入力は残してあります。このままでは保存できません（「元に戻す」で最新を読み直せます）。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy || !dirty || changedElsewhere} onClick={save}>
                品質基準を保存
              </Button>
              <Button disabled={busy} onClick={() => (setDraft(null), setMsg(null))}>
                元に戻す
              </Button>
              {dirty && <span className="text-sm text-slate-500">保存していない変更があります</span>}
            </div>
          </div>
        )}
        {msg && (
          <p role={msg.ok ? "status" : "alert"} className={cx("text-sm break-words", msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600")}>
            {msg.text}
          </p>
        )}
      </div>
    </Section>
  );
}
