import { Alert, Button, Field, inputCls, linkCls } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createDefinition, fetchCandidates, ObserverApiError } from "../../lib/api.ts";
import type { ObservationCandidate } from "../../../shared/candidates.ts";
import { RefPicker, type Refs } from "../../components/RefPicker.tsx";
import type { DefinitionProblem } from "../../../shared/definition.ts";

/** /observer/new: タイトルと観測内容（カテゴリは任意）で観測を先に保存して ID を付け、編集の画面へ移る（手順・測定項目・AI の提案はそこで） */
export const Route = createFileRoute("/observer/new")({
  component: NewDefinition,
  // candidate・n: 観測の候補の「確かめて登録」から開いたとき
  validateSearch: (s: Record<string, unknown>): { candidate?: string; n?: number } => ({ candidate: typeof s.candidate === "string" ? s.candidate : undefined, n: typeof s.n === "number" ? s.n : undefined }),
});

function NewDefinition() {
  const navigate = useNavigate();
  const { candidate, n } = Route.useSearch();
  const [v, setV] = useState({ title: "", category: "", description: "", expected: "" });
  const [cand, setCand] = useState<ObservationCandidate>();
  const [origin, setOrigin] = useState(false);
  useEffect(() => {
    if (!candidate) return;
    void fetchCandidates(candidate).then((j) => {
      const c = j.candidates?.[n ?? 0];
      if (!c) return;
      setCand(c);
      setV((x) => ({ ...x, title: c.title, description: c.description, expected: c.expected }));
    });
  }, [candidate, n]);
  const [refs, setRefs] = useState<Refs>({ prerequisites: [], preparations: [] });
  const [error, setError] = useState<{ message: string; problems: DefinitionProblem[]; fields: Record<string, string> }>();
  async function submit() {
    try {
      const d = await createDefinition({ ...v, ...refs }, cand && candidate ? { candidate, n: n ?? 0, origin } : undefined);
      void navigate({ to: "/observer/$id/edit", params: { id: d.id } });
    } catch (e) {
      const problems = e instanceof ObserverApiError ? e.problems : [];
      setError({ message: (e as Error).message, problems, fields: Object.fromEntries(problems.map((p) => [p.path, p.message])) });
    }
  }
  const field = (key: keyof typeof v, label: string, hint?: string, rows?: number) => (
    <Field label={label} hint={hint} error={error?.fields[key]}>
      {rows ? (
        <textarea className={inputCls} rows={rows} value={v[key]} aria-invalid={!!error?.fields[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
      ) : (
        <input className={inputCls} value={v[key]} aria-invalid={!!error?.fields[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
      )}
    </Field>
  );
  return (
    <form
      className="w-full space-y-4 px-4 py-6 sm:px-6 lg:p-8"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Link to="/observer" className={linkCls}>
        ← 観測の一覧
      </Link>
      <h1 className="text-2xl font-bold">観測を登録</h1>
      <p className="text-slate-600 dark:text-slate-400">まずタイトルと観測内容で保存します。測定項目・確認の手順・AI への提案の依頼は、保存したあとの編集の画面で行います。</p>
      {cand && (
        <p className="text-slate-600 dark:text-slate-400">
          AI の観測の候補を入れています（理由: {cand.reason}・根拠: {cand.evidence.join("・")}）。確かめて直してから保存してください。
        </p>
      )}
      {cand?.estimatedOrigin && (
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1.5" checked={origin} onChange={(e) => setOrigin(e.target.checked)} />
          <span>
            推定の経緯を確かめたので残す（この期待は {cand.estimatedOrigin.requests.join("・")} で決まった。根拠: {cand.estimatedOrigin.basis}）。実際に作業した要望としては扱いません
          </span>
        </label>
      )}
      {error && <Alert box>{error.message}</Alert>}
      {field("title", "タイトル")}
      {field("category", "カテゴリ（任意）", "例: 性能・可用性・品質・使い勝手")}
      {field("description", "観測内容", "何を観測するか（目的・対象・観測したい状態）", 4)}
      {field("expected", "期待する結果（任意）", "どうなっていれば期待どおりか（判定のもとになる）", 3)}
      <RefPicker value={refs} onChange={setRefs} problems={error?.problems ?? []} />
      <Button type="submit" variant="primary">
        保存して続ける
      </Button>
    </form>
  );
}
