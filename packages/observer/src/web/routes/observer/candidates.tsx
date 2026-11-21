import { Alert, Button, buttonCls, Empty, Field, inputCls, Loading, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { STARTING_LABEL, useStartOnce } from "@infodb/p3-shared/web/startOnce.ts";
import type { CandidateJob } from "../../../shared/candidates.ts";
import { fetchCandidates, listCandidates, startCandidates } from "../../lib/api.ts";

/**
 * /observer/candidates: AI に観測の候補を頼む（人が頼んだときだけ）。材料は人が確かめる品質基準・証拠が申告のみか未検証のまま済みになった
 * 受け入れ基準・最近の要望・今ある観測と、読むだけの参照先。候補ごとに期待・理由・根拠・近い既存の観測・推定の経緯を出し、「確かめて登録」で
 * 候補を入れた登録の画面へ移る（保存したものだけが観測になる）。依頼と結果は残るので、読み直しても最新の候補を出す
 */
export const Route = createFileRoute("/observer/candidates")({ component: Candidates });

function Candidates() {
  const [job, setJob] = useState<CandidateJob | null>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    listCandidates().then((l) => setJob((j) => j ?? l.candidates[0] ?? null), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (job?.status !== "running") return;
    const t = setTimeout(() => void fetchCandidates(job.id).then(setJob, (e: Error) => setError(e.message)), 700);
    return () => clearTimeout(t);
  }, [job]);
  const running = job?.status === "running";
  const once = useStartOnce("candidates");
  return (
    <div className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <h1 className="text-2xl font-bold">観測の候補</h1>
      <p className="text-slate-600 dark:text-slate-400">
        人が確かめる品質基準・証拠が申告のみか未検証のまま済みになった受け入れ基準・最近の要望・今ある観測と、プロジェクトの参照先（読むだけ）を材料に、AI に観測の候補を挙げてもらいます。候補を確かめて保存したものだけが観測になります。
      </p>
      <Field label="補足（任意）">
        <textarea className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Button variant="primary" disabled={running || once.pending} onClick={() => void once.start(() => startCandidates(note), setJob, (e) => setError(e.message))}>
        {once.pending ? STARTING_LABEL : running ? "候補を待っています…" : job ? "もう一度頼む" : "候補を頼む"}
      </Button>
      {error && <Alert>候補を頼めませんでした: {error}</Alert>}
      {job === undefined && <Loading />}
      {job?.status === "failed" && <Alert>{`候補を出せませんでした: ${job.error}`}</Alert>}
      {job?.status === "completed" && (
        <section aria-label="候補" className="space-y-3">
          {!job.candidates?.length && <Empty>候補はありませんでした（材料が少ないときは補足に書いて頼み直す）。</Empty>}
          {job.candidates?.map((c, i) => (
            <article key={i} aria-label={c.title} className="space-y-2 rounded-lg bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <h2 className="text-lg font-semibold">{c.title}</h2>
              <p>期待: {c.expected}</p>
              <p>理由: {c.reason}</p>
              <p>根拠: {c.evidence.join("・")}</p>
              {c.similar && <p>近い既存の観測: <Link to="/observer/$id" params={{ id: c.similar }} className={linkCls}>{job.material.observations.find((o) => o.id === c.similar)?.title ?? c.similar}</Link></p>}
              {c.estimatedOrigin && <p>推定の経緯: {c.estimatedOrigin.requests.join("・")}（{c.estimatedOrigin.basis}）</p>}
              <Link to="/observer/new" search={{ candidate: job.id, n: i }} className={buttonCls()}>
                確かめて登録
              </Link>
            </article>
          ))}
          {job.warnings?.map((w) => (
            <Alert key={w} warn>
              ⚠ {w}
            </Alert>
          ))}
        </section>
      )}
    </div>
  );
}
