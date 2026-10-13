import { useCallback, useEffect, useRef, useState } from "react";
import type { ReleaseGeneration, ReleaseWarning } from "../../../shared/types.ts";
import { api, ApiError, conflictNote, type ReleaseNoteDetail } from "../../lib/api.ts";
import { useAppData } from "../../lib/appData.tsx";
import { copyText, COPY_MESSAGE } from "../../lib/copy.ts";
import { fmtTime } from "../../lib/format.ts";
import { latestOnly, STALE } from "../../lib/latest.ts";
import { useServerEvents } from "../../lib/live.ts";
import {
  applyGenerated,
  asNew,
  confirmBeforeReplace,
  conflicted,
  discardNote,
  editNote,
  isNoteDirty,
  noteDraftOf,
  saveArgs,
  savedNote,
  syncNote,
  type NoteDraft,
} from "../../lib/releaseNoteDraft.ts";
import { Button, buttonCls, cx, inputCls } from "../ui.tsx";
import { MaterialView, Warnings } from "./MaterialView.tsx";

/**
 * 1つのマイルストーンのリリースノート。対象の要望（MaterialView）、要約の生成（左）、本文の編集と保存（右）。
 *
 *   - 生成の結果は編集欄に勝手に入れない（「編集欄へ反映」で入れ、未保存の入力があれば確かめる）
 *   - 編集中に外で保存・削除・読めなくなったら、入力を残して知らせ、見比べ・コピー・読み直しを選べる（lib/releaseNoteDraft.ts）
 *   - 保存は編集を始めたときの版で行う（外で変わっていれば競合。最新の版に差し替えない）
 *   - 保存しても要望・マイルストーンの状態は変えない
 */
export function ReleaseNotePanel({ milestone }: { milestone: string }) {
  const { tick } = useAppData();
  const [detail, setDetail] = useState<ReleaseNoteDetail>();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>();
  const [gen, setGen] = useState<ReleaseGeneration | null>(null);
  /** 編集欄の本文の元にした材料（生成の結果を入れたらその材料、ほかは画面で見ている材料） */
  const [basedOn, setBasedOn] = useState<string | undefined>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; warnings?: ReleaseWarning[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(latestOnly());

  const load = useCallback(async () => {
    try {
      const d = await latest.current.run(() => api.releaseNote(milestone));
      if (d === STALE) return;
      setDetail(d);
      setLoadError(null);
      setDraft((cur) => (cur ? syncNote(cur, d) : noteDraftOf(d)));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [milestone]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  // 最後の生成（serve のメモリにある分）。生成の状態が変わったら取り直す
  const loadGen = useCallback(
    async (id?: string) => {
      const g = id ? await api.releaseGeneration(id).catch(() => null) : ((await api.releaseGenerations(milestone).catch(() => []))[0] ?? null);
      setGen(g);
    },
    [milestone],
  );
  useEffect(() => {
    void loadGen();
  }, [loadGen]);
  useServerEvents((e) => {
    if (e.type === "release-generation" && e.milestone === milestone) void loadGen(e.id);
  });

  if (!detail || !draft)
    return loadError ? (
      <div className="space-y-2">
        <p className="text-rose-600">読み込めませんでした: {loadError}</p>
        <Button onClick={() => void load()}>もう一度読み込む</Button>
      </div>
    ) : (
      <p className="text-slate-500">Loading…</p>
    );

  const m = detail.material.milestone;
  const hasSources = detail.material.sources.some((s) => s.tasks.length);

  async function generate() {
    setMsg(null);
    try {
      setGen(await api.generateReleaseNote(milestone));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }

  function takeGenerated() {
    if (!gen?.markdown || !draft) return;
    if (confirmBeforeReplace(draft) && !window.confirm("編集欄に保存していない入力があります。生成の結果で置き換えますか？（置き換える前の入力は戻せません）")) return;
    setDraft(applyGenerated(draft, gen.markdown));
    setBasedOn(gen.materialHash);
    setMsg(null);
  }

  async function save(d: NoteDraft) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.saveReleaseNote(milestone, { ...saveArgs(d), basedOn: basedOn ?? detail!.material.hash });
      setDraft(savedNote(r.note));
      setBasedOn(undefined);
      setMsg({ ok: true, text: "保存しました", warnings: r.warnings });
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDraft(conflicted(d, conflictNote(e)));
        setMsg({ ok: false, text: "保存できませんでした。編集を始めた後に、別の操作でノートが保存されています（入力は残っています）" });
      } else if (e instanceof ApiError && e.status === 404) {
        setDraft(conflicted(d, null));
        setMsg({ ok: false, text: "保存できませんでした。ノートが消されています（入力は残っています）" });
      } else setMsg({ ok: false, text: `保存できませんでした: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold break-words">
          {m.title} <span className="font-mono text-base text-slate-500">{m.id}</span>
        </h2>
        <p className="text-slate-500 dark:text-slate-400">
          {m.due ? `期限 ${m.due}・` : ""}
          {m.done ? "リリース済み" : "未リリース"}・
          {detail.note ? `保存済み（${fmtTime(detail.note.updatedAt)}${detail.note.updatedBy ? ` · ${detail.note.updatedBy}` : ""}）` : detail.noteError ? "ノートを読めません" : "ノートなし"}
        </p>
        {detail.materialChanged && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
            ⚠ 保存のあとで要望・タスクが変わっています。本文は自動では変えていません。必要なら生成し直して確かめてから保存してください。
          </p>
        )}
        {loadError && <p className="text-sm text-rose-600">取り直せませんでした（表示は前の内容のまま）: {loadError}</p>}
      </header>

      <MaterialView material={detail.material} />

      <div className="grid gap-6 xl:grid-cols-2">
        <GenerationView gen={gen} currentHash={detail.material.hash} hasSources={hasSources} onGenerate={generate} onTake={takeGenerated} />
        <NoteEditor
          milestone={milestone}
          detail={detail}
          draft={draft}
          busy={busy}
          msg={msg}
          onEdit={(v) => setDraft(editNote(draft, v))}
          onSave={() => void save(draft)}
          onSaveAsNew={() => void save(asNew(draft))}
          onDiscard={() => {
            if (isNoteDirty(draft) && !window.confirm("保存していない入力を捨てて、保存されている最新の本文に戻しますか？（入力は戻せません。必要ならコピーしてから）")) return;
            setDraft(discardNote(detail));
            setBasedOn(undefined);
            setMsg(null);
          }}
          onReload={() => void load()}
        />
      </div>
    </div>
  );
}

/** 要約の生成（案）。保存はしない */
function GenerationView({
  gen,
  currentHash,
  hasSources,
  onGenerate,
  onTake,
}: {
  gen: ReleaseGeneration | null;
  currentHash: string;
  hasSources: boolean;
  onGenerate: () => void;
  onTake: () => void;
}) {
  const running = gen?.status === "running";
  // 生成のあとで（生成中も）材料が変わったか。終わったときの判定（materialChanged）に加えて、今の材料と比べる
  const stale = !!gen && gen.materialHash !== currentHash;
  return (
    <section aria-labelledby="rn-gen" className="min-w-0 space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <h3 id="rn-gen" className="text-lg font-semibold">
        機能の要約（案）
      </h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        収録する要望のタスクの変更の記録から Codex が要約します。保存はされず、編集欄にも勝手には入りません。
      </p>
      {!hasSources && !gen && <p className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900">要約の材料（変更の記録のある完了したタスク）がありません。本文を手で書いて保存してください。</p>}

      {gen && (
        <div className="space-y-2" aria-live="polite">
          {running && (
            <p className="flex items-center gap-2">
              <span aria-hidden className="size-3 animate-pulse rounded-full bg-indigo-500" />
              生成しています…（編集欄の入力はそのままです）
            </p>
          )}
          {gen.status === "failed" && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300">
              生成できませんでした（{FAILURE_LABEL[gen.failure ?? "error"]}）: {gen.error}
            </p>
          )}
          {gen.status === "cancelled" && <p className="text-sm text-slate-500">取り消しました。</p>}
          {stale && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              ⚠ {running ? "生成中に" : "生成のあとで"}要望・タスクが変わりました。この案は古い材料からのものです。
            </p>
          )}
          {gen.status === "completed" && gen.items && (
            <div className="space-y-2">
              <ul className="list-disc space-y-1.5 pl-5">
                {gen.items.map((x, i) => (
                  <li key={i}>
                    <span className="break-words">{x.text}</span>
                    <span className="block font-mono text-xs break-all text-slate-500">出典: {x.sources.join(", ")}</span>
                  </li>
                ))}
              </ul>
              <Warnings items={gen.warnings.filter((w) => w.code !== "material_changed")} />
              <p className="text-xs text-slate-500">
                {gen.engine === "mock" ? "Mock（要約していません）・" : ""}
                {fmtTime(gen.finishedAt ?? gen.startedAt)} に生成・出典は公開する本文には入りません
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {gen?.status === "completed" && (
          <Button variant="primary" onClick={onTake}>
            生成の結果を編集欄へ反映
          </Button>
        )}
        {running ? (
          <Button onClick={() => void api.cancelReleaseGeneration(gen!.id)}>生成を取り消す</Button>
        ) : (
          <Button variant={gen?.status === "completed" ? "secondary" : "primary"} disabled={!hasSources} onClick={onGenerate}>
            {gen?.status === "failed" || gen?.status === "cancelled" ? "もう一度生成する" : gen ? "生成し直す" : "機能の要約を生成"}
          </Button>
        )}
      </div>
    </section>
  );
}

const FAILURE_LABEL = { unavailable: "Codex を使えません", usage_limit: "使用量の上限", timeout: "時間切れ", invalid_output: "結果の形が違います", error: "エラー" } as const;

/** 本文（公開する Markdown）の編集と保存・ダウンロード。外での変更は入力を残して見比べられる */
function NoteEditor({
  milestone,
  detail,
  draft,
  busy,
  msg,
  onEdit,
  onSave,
  onSaveAsNew,
  onDiscard,
  onReload,
}: {
  milestone: string;
  detail: ReleaseNoteDetail;
  draft: NoteDraft;
  busy: boolean;
  msg: { ok: boolean; text: string; warnings?: ReleaseWarning[] } | null;
  onEdit: (v: string) => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const dirty = isNoteDirty(draft);
  const [copied, setCopied] = useState<string | null>(null);
  const ext = draft.external;
  // 読めないファイルがあるときは保存しない（新規でも更新でも上書きしない。直してから読み直す）
  const blocked = ext?.kind === "invalid";
  const copy = async () => setCopied(COPY_MESSAGE[await copyText(draft.value, navigator.clipboard)].replace("ID", "本文"));
  return (
    <section aria-labelledby="rn-edit" className="min-w-0 space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <h3 id="rn-edit" className="text-lg font-semibold">
        本文（公開する Markdown）
      </h3>

      {ext && (
        <div role="alert" className="space-y-2 rounded-md bg-rose-50 p-3 text-rose-900 dark:bg-rose-950 dark:text-rose-200">
          {ext.kind === "changed" && (
            <>
              <p className="font-medium">
                {dirty ? "編集中に" : ""}別の操作でノートが保存されました（{fmtTime(ext.note.updatedAt)}
                {ext.note.updatedBy ? ` · ${ext.note.updatedBy}` : ""}）。あなたの入力は残っています。見比べてから選んでください。
              </p>
              <details className="rounded bg-white p-2 text-slate-800 dark:bg-slate-900 dark:text-slate-200">
                <summary className="cursor-pointer text-sm font-medium">外で保存された本文を見る</summary>
                <pre className="mt-2 max-h-72 overflow-auto text-sm break-words whitespace-pre-wrap">{ext.note.body || "（本文なし）"}</pre>
              </details>
            </>
          )}
          {ext.kind === "deleted" && <p className="font-medium">保存されていたノートが消されました。あなたの入力は残っています（空のノートとして自動では保存しません）。</p>}
          {ext.kind === "invalid" && (
            <p className="font-medium break-words">
              ノートのファイルを読めません: {ext.error}。直すまで保存できません（上書きしません）。入力は残っています。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy()}>入力をコピー</Button>
            {ext.kind === "changed" && (
              <Button onClick={onDiscard}>最新の本文を読み直す</Button>
            )}
            {ext.kind === "deleted" && <Button onClick={onSaveAsNew}>この入力で新しく保存する</Button>}
            <Button variant="ghost" onClick={onReload}>
              もう一度読み込む
            </Button>
          </div>
          {copied && <p className="text-sm">{copied}</p>}
        </div>
      )}

      <label className="block space-y-1">
        <span className="sr-only">本文</span>
        <textarea
          rows={14}
          value={draft.value}
          onChange={(e) => onEdit(e.target.value)}
          placeholder={"## 最初のリリース\n\n- …できるようになった"}
          className={cx(inputCls, "font-mono text-sm")}
        />
      </label>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {dirty ? "保存していない変更があります。対象の要望と内容を確かめてから保存してください。" : detail.note ? "保存されている本文です。" : "まだ保存されていません。"}
      </p>

      {msg && (
        <div className="space-y-1">
          <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>
            {msg.text}
          </p>
          {msg.warnings && <Warnings items={msg.warnings} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {/* 外で保存・削除されたら、この版では保存できない（読み直すか、消えたなら新しく保存する） */}
        <Button variant="primary" disabled={busy || !dirty || blocked || ext?.kind === "deleted" || ext?.kind === "changed"} onClick={onSave}>
          {busy ? "保存しています…" : "保存"}
        </Button>
        <Button disabled={!dirty} onClick={onDiscard}>
          編集を捨てる
        </Button>
        {!ext && dirty && (
          <Button variant="ghost" onClick={() => void copy()}>
            入力をコピー
          </Button>
        )}
        {detail.note ? (
          <a href={api.releaseNoteExportUrl(milestone)} download className={buttonCls("secondary")}>
            保存した本文をダウンロード
          </a>
        ) : (
          <span className={buttonCls("secondary", "cursor-not-allowed opacity-50")} aria-disabled title="保存すると出力できます">
            保存した本文をダウンロード
          </span>
        )}
      </div>
      {!ext && copied && <p className="text-sm text-slate-500">{copied}</p>}
      <p className="text-xs text-slate-500">ダウンロードは保存した本文だけです（保存していない変更・出典は含みません）。保存しても要望やマイルストーンの状態は変わりません。</p>
    </section>
  );
}
