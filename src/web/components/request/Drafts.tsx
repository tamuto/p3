import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { relationRole, type ProposedTask, type Request, type SupersedeCandidate } from "../../../shared/types.ts";
import { Badge, Button, buttonCls, cx, inputCls, Empty, Id, Section } from "../ui.tsx";
import { api, type RunInfo } from "../../lib/api.ts";
import { archiveSelection } from "../../lib/supersede.ts";
import { type AppCtx } from "../../lib/appCtx.ts";
import { draftAnchor, uiShortage } from "../../lib/uiMaterials.ts";
import { NO_REPO, repoChoices } from "../../../shared/workTarget.ts";
import { isMaterialized } from "../../../shared/preflightInput.ts";
import { materializeErrorText } from "../../lib/requestEdit.ts";

/** タスク案とタスク化（置き換えられる既存タスクの選択を含む） */

/** タスク案を依存の深さで段に並べる（細分化の構造が一目で分かるように） */
function levels(drafts: ProposedTask[]) {
  const by = new Map(drafts.map((d) => [d.key, d]));
  const memo = new Map<string, number>();
  const depth = (k: string, seen = new Set<string>()): number => {
    if (memo.has(k)) return memo.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const d = by.get(k);
    const v = d && d.dependsOn.length ? 1 + Math.max(...d.dependsOn.filter((x) => by.has(x)).map((x) => depth(x, seen)), -1) : 0;
    memo.set(k, v);
    return v;
  };
  const out: ProposedTask[][] = [];
  for (const d of drafts) (out[depth(d.key)] ??= []).push(d);
  return out.filter(Boolean);
}

export function Drafts({
  ctx,
  request,
  run,
  onChanged,
  blocked,
}: {
  ctx: AppCtx;
  request: Request;
  run: RunInfo;
  onChanged: (r: RunInfo) => void;
  blocked: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = isMaterialized(run);
  // 評価のあとでタイトル・本文が変わった（か確かめられない）run からはタスク化しない。評価・案は読める
  const stale = !!run.inputMatch && run.inputMatch.status !== "same";
  const stopped = stale ? "この評価は今の要望と違うので、タスク化できません。もう一度 Preflight を実行してください" : blocked;
  const included = run.drafts.filter((d) => d.include);
  // 置き換えられる既存タスク。採否を変えたら・外で変わったら読み直す。アーカイブは選んだものだけ（既定は残す）
  const [candidates, setCandidates] = useState<SupersedeCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const includeKey = run.drafts.map((d) => `${d.key}:${d.include}`).join(",");
  useEffect(() => {
    if (done) return setCandidates([]);
    void api.previewMaterialize(request.id, run.id).then((p) => setCandidates(p.candidates), () => setCandidates([]));
  }, [request.id, run.id, includeKey, done, ctx.tick]);

  async function patch(d: ProposedTask, p: Partial<ProposedTask>) {
    try {
      const next = await api.patchDraft(request.id, run.id, d.key, p);
      setError(null);
      onChanged({ ...run, drafts: run.drafts.map((x) => (x.key === d.key ? next : x)) });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // 共有の参照先があるときだけ、案ごとに作業先を選ぶ
  const multi = ctx.info.project.repos.length > 0;

  async function materialize() {
    setBusy(true);
    setError(null);
    try {
      await api.materialize(request.id, run.id, archiveSelection(candidates, selected));
      onChanged(await api.run(request.id, run.id));
      ctx.reload();
    } catch (e) {
      // 評価のあとで要望が変わった（stale_input）か、確定の時点で置き換えの候補が変わった（rev_conflict）。どちらも読み直す
      setError(materializeErrorText(e));
      void api.run(request.id, run.id).then(onChanged, () => undefined);
      void api.previewMaterialize(request.id, run.id).then((p) => setCandidates(p.candidates), () => setCandidates([]));
    } finally {
      setBusy(false);
    }
  }

  if (!run.drafts.length) return <Section title="タスク案"><Empty>タスク案はありません</Empty></Section>;

  return (
    <Section
      title={`タスク案 (${included.length}/${run.drafts.length} 件を採用)`}
      aside={<span className="min-w-0 font-mono text-sm break-all text-slate-400">requests/{request.id}/preflight/{run.id}/drafts/*.md</span>}
    >
      {/* 段（依存の深さ）ごとの列。広い画面では列を広げ（最大 28rem）、入りきらなければこの中だけ横にスクロールする */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {levels(run.drafts).map((lv, i) => (
          <div key={i} className="flex max-w-md min-w-72 flex-1 shrink-0 flex-col gap-2">
            <span className="text-sm text-slate-500">段階 {i + 1}</span>
            {lv.map((d) => (
              <div
                key={d.key}
                id={draftAnchor(d.key)}
                className={cx(
                  "scroll-mt-4 space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 target:ring-2 target:ring-indigo-500 dark:bg-slate-900 dark:ring-slate-800",
                  !d.include && "opacity-50",
                )}
              >
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={d.include} disabled={done} onChange={(e) => patch(d, { include: e.target.checked })} />
                  <span className="font-mono text-sm text-slate-500">{d.key}</span>
                  {d.dependsOn.length > 0 && <span className="text-sm text-slate-400">← {d.dependsOn.join(", ")}</span>}
                </div>
                {multi && (
                  <label className="flex items-center gap-2 text-sm text-slate-500">
                    作業先
                    <select
                      className={`${inputCls} !w-auto min-w-0 flex-1 py-0.5 text-sm`}
                      disabled={done}
                      value={d.repo ?? NO_REPO}
                      onChange={(e) => void patch(d, { repo: e.target.value === NO_REPO ? null : e.target.value })}
                    >
                      {repoChoices(ctx.info.project, d.repo).map((c) => (
                        <option key={c.value} value={c.value} disabled={c.invalid}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <textarea
                  rows={2}
                  disabled={done}
                  defaultValue={d.title}
                  onBlur={(e) => e.target.value !== d.title && patch(d, { title: e.target.value })}
                  className="w-full resize-none rounded bg-transparent px-1 leading-snug font-medium hover:ring-1 hover:ring-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none dark:hover:ring-slate-700"
                />
                <details>
                  <summary className="cursor-pointer text-sm text-slate-500">内容</summary>
                  <p className="mt-1 text-sm whitespace-pre-wrap break-words text-slate-600 dark:text-slate-400">{d.description}</p>
                </details>
                <div className="flex flex-wrap gap-1">
                  {d.areas.map((a) => (
                    <Badge key={a} className="max-w-full font-mono" title={a}>
                      <span className="truncate">{a}</span>
                    </Badge>
                  ))}
                  {d.relations.map((r) => (
                    <Badge key={`${r.type}-${r.target}`} tone="amber" className="max-w-full" title={`${relationRole(r.type, "out")} ${r.target}${r.note ? `: ${r.note}` : ""}`}>
                      <span className="shrink-0">{relationRole(r.type, "out")}</span>
                      <span className="truncate font-mono">{r.target}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!done && candidates.length > 0 && (
        <div className="space-y-2 rounded-lg bg-amber-50 p-4 dark:bg-amber-950/40">
          <p className="font-medium">置き換えられる既存タスク（チェックしたものをタスク化と一緒にアーカイブします。チェックしなければ残します）</p>
          <ul className="space-y-1.5">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`${c.id} をアーカイブ`}
                  checked={selected.has(c.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(c.id);
                    else next.delete(c.id);
                    setSelected(next);
                  }}
                />
                <Id id={c.id} onClick={() => ctx.open(c.ref)} />
                <span>{c.title}</span>
                {c.status === "doing" && (
                  <Badge tone="amber" title="アーカイブしても、進めている作業そのものは止まりません">
                    作業中
                  </Badge>
                )}
                <span className="text-sm text-slate-500">
                  {c.reasons.map((r) => (r.source === "draft" ? `案 ${r.draft}` : "評価")).join(" · ")}
                  {c.reasons[0]?.note ? ` — ${c.reasons[0].note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!done && uiShortage(run) && (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900">
          {uiShortage(run)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        {done ? (
          <p className="flex flex-wrap items-center gap-2 text-emerald-700 dark:text-emerald-400">
            ✓ この評価から {run.materialized!.join(", ")} をタスク化しました
            {run.materialization?.archived.length ? `（置き換えられた ${run.materialization.archived.join(", ")} をアーカイブ）` : ""}
            <Link to="/requests/$requestId/board" params={{ requestId: request.id }} className={buttonCls("ghost", "underline")}>
              タスクボードで見る
            </Link>
          </p>
        ) : (
          <>
            <Button variant="primary" disabled={busy || !included.length || !!stopped} onClick={materialize}>
              {included.length} 件をタスク化{selected.size && candidates.some((c) => selected.has(c.id)) ? `（${archiveSelection(candidates, selected).length} 件をアーカイブ）` : ""}
            </Button>
            <span className={stopped ? "text-amber-700 dark:text-amber-400" : "text-slate-500"}>
              {stopped ?? "依存関係・影響関係も一緒に登録され、作業ツリー（ブランチ）が割り当てられます。"}
            </span>
          </>
        )}
        {error && <span className="text-rose-600">{error}</span>}
      </div>
    </Section>
  );
}

