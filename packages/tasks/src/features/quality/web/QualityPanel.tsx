import { useCallback, useEffect, useRef, useState } from "react";
import { QUALITY_LIMITS, type QualityStandard } from "../shared/quality.ts";
import { api, ApiError, saveErrorText, type QualityViewData } from "../../../web/lib/api.ts";
import { latestOnly, STALE } from "../../../web/lib/latest.ts";
import { Alert, Badge, Button, CheckGroup, Field, inputCls, Section } from "@infodb/p3-shared/web/ui.tsx";

/**
 * 設定の「品質基準」（project.yaml の quality。CLI の p3 quality と同じ core の操作）。
 *   項目は ID・文・対象の参照先（選ばなければ全参照先）・確かめ方（任意）だけ。Q 番号は履歴を追う ID（点数・順位ではない）
 *   保存すると一覧を丸ごと置き換える（ID は残し、新しい行に振る）。編集を始めたときの一覧を添えて送り、他で変わっていれば断られる（入力は残す）。
 *   タスクを作るときに、作業先に当てはまる基準を受け入れ基準に足す
 *   （基準を変えても既にあるタスクは変えない）。P3 はコマンドを実行しない
 */

interface Row {
  key: string;
  id?: string;
  text: string;
  /** 対象の参照先（空は全参照先） */
  repos: string[];
  how: string;
}

let rowSeq = 0;
const rowsOf = (list: readonly QualityStandard[]): Row[] => list.map((s) => ({ key: s.id, id: s.id, text: s.text, repos: s.repos ?? [], how: s.how ?? "" }));
const sig = (rows: readonly Row[]) => JSON.stringify(rows.map((r) => [r.id, r.text, r.repos, r.how]));
const blankRow = (): Row => ({ key: `new-${++rowSeq}`, text: "", repos: [], how: "" });
const rowName = (r: Row, i: number) => r.id ?? `新しい基準 ${i + 1}`;

export function QualityPanel({ tick, repoNames, onDirtyChange }: { tick: number; repoNames: string[]; onDirtyChange?: (dirty: boolean) => void }) {
  const [view, setView] = useState<QualityViewData>();
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 編集の下書き（null は編集していない） */
  const [draft, setDraft] = useState<{ saved: QualityStandard[]; base: Row[]; rows: Row[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(latestOnly());
  const dirty = !!draft && sig(draft.rows) !== sig(draft.base);
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
  const startEdit = (withBlank = false) => {
    const d = draft ?? { saved, base: rowsOf(saved), rows: rowsOf(saved) };
    setDraft(withBlank ? { ...d, rows: [...d.rows, blankRow()] } : d);
    setMsg(null);
  };
  const setRow = (key: string, patch: Partial<Row>) => setDraft((d) => (d ? { ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) } : d));

  async function save() {
    if (!draft) return;
    const at = draft.rows.findIndex((r) => !r.text.trim());
    if (at >= 0) return setMsg({ ok: false, text: `${rowName(draft.rows[at], at)}: 文を書いてください` });
    setBusy(true);
    setMsg(null);
    try {
      const standards = draft.rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), text: r.text, repos: r.repos, how: r.how }));
      setView(await api.updateQuality([{ op: "replace", standards, base: draft.saved }]));
      setDraft(null);
      setMsg({ ok: true, text: "品質基準を保存しました" });
    } catch (e) {
      const conflict = e instanceof ApiError && (e.body as { code?: string } | null)?.code === "quality_conflict";
      setMsg({ ok: false, text: conflict ? "品質基準が他で変わったので保存しませんでした。入力は残してあります。「元に戻す」で最新を読み直せます" : saveErrorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="品質基準">
      <p className="text-base text-fg-3">
        プロジェクトとして守る水準です。タスクを作るときに、作業先に当てはまる基準を受け入れ基準として足します（基準を変えても既にあるタスクは変えません）。P3 は確かめ方のコマンドを実行しません。
      </p>
      {loadError && <Alert>品質基準を読み込めませんでした: {loadError}</Alert>}
      {msg && (msg.ok ? <p role="status" className="text-base text-ok-strong">{msg.text}</p> : <Alert>{msg.text}</Alert>)}
      {q?.state === "invalid" && (
        <Alert box>
          project.yaml の品質基準が読めません。ファイルを直すまで変えられず、タスクも作れません: {q.problems.join(" / ")}
        </Alert>
      )}
      {q?.state === "set" && (q.warnings ?? []).map((w) => <Alert key={w} warn>{w}</Alert>)}
      {!draft && q && q.state !== "invalid" && (
        <>
          {saved.length ? (
            <ul aria-label="保存済みの品質基準" className="space-y-2">
              {saved.map((s) => (
                <li key={s.id} className="space-y-1 rounded-md border border-line p-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge>{s.id}</Badge>
                    <span className="min-w-0 break-words">{s.text}</span>
                  </p>
                  <p className="text-base text-fg-3">対象: {s.repos?.length ? s.repos.join(", ") : "全参照先"}</p>
                  {s.how && <p className="text-base break-words text-fg-3">確かめ方: {s.how}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-base text-fg-4">品質基準はありません（無くても作業は続けられます）。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => startEdit(!saved.length)}>{saved.length ? "品質基準を編集" : "基準を足す"}</Button>
          </div>
        </>
      )}
      {draft && (
        <div className="space-y-3">
          {draft.rows.map((r, i) => (
            <fieldset key={r.key} className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-base font-medium">{rowName(r, i)}</legend>
              <Field label={`${rowName(r, i)} の文`}>
                <textarea className={inputCls} rows={2} maxLength={QUALITY_LIMITS.text} value={r.text} disabled={busy} onChange={(e) => setRow(r.key, { text: e.target.value })} />
              </Field>
              <Field label="確かめ方（任意）" hint="コマンドでも人の手順でも、文1つで書きます">
                <input className={inputCls} maxLength={QUALITY_LIMITS.how} value={r.how} disabled={busy} onChange={(e) => setRow(r.key, { how: e.target.value })} />
              </Field>
              <CheckGroup
                label={`${rowName(r, i)} の対象の参照先`}
                options={repoNames.map((n) => ({ value: n, label: n }))}
                value={r.repos}
                onChange={(repos) => setRow(r.key, { repos })}
                hint="選ばなければ全参照先（作業先なしのタスクにも当てはまる）"
                empty="参照先がありません（全参照先に当てはまります）。"
              />
              <Button variant="cancel" disabled={busy} onClick={() => setDraft((d) => (d ? { ...d, rows: d.rows.filter((x) => x.key !== r.key) } : d))}>
                この基準を消す
              </Button>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => setDraft((d) => (d ? { ...d, rows: [...d.rows, blankRow()] } : d))}>
              基準を足す
            </Button>
            <Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? "保存中…" : "品質基準を保存"}
            </Button>
            <Button variant="cancel" disabled={busy} onClick={() => (setDraft(null), void load())}>
              元に戻す
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
