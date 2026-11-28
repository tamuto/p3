import { Alert, Badge, Button, Empty, Field, inputCls, Loading, linkCls, Section } from "@infodb/p3-shared/web/ui.tsx";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { formatGuide, formatValue, METRIC_AGGREGATE_LABEL, METRIC_TYPE_LABEL, parseValueText, type MetricKey, type MetricValue } from "../../../shared/metric.ts";
import { KeyForm } from "../../components/KeyForm.tsx";
import { fieldErrors, observerApi } from "../../lib/api.ts";
import { useLoad } from "../../lib/useLoad.ts";

/** /observer/$key?m=: 項目キーの設定と値の一覧（新しい順。推移はトップのカードに出す）。利用者の項目は変える・消す・値を足す・消すができる（システムの項目は p3 が記録するので見るだけ） */
export const Route = createFileRoute("/observer/$key")({
  component: KeyDetail,
  validateSearch: (s: Record<string, unknown>): { m?: string } => ({ m: typeof s.m === "string" && s.m ? s.m : undefined }),
});

function KeyDetail() {
  const { key } = Route.useParams();
  const { m } = Route.useSearch();
  const navigate = useNavigate();
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const load = useLoad(() => observerApi.key(key, m), `${key}|${m ?? ""}|${tick}`);
  const reload = () => setTick((t) => t + 1);
  async function act(f: () => Promise<unknown>) {
    setError(undefined);
    try {
      await f();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6 lg:p-8">
      <Link to="/observer" search={{ m }} className={linkCls}>
        ← 観測の一覧
      </Link>
      {load.kind === "loading" && <Loading />}
      {load.kind === "error" && <Alert>観測の項目を読めませんでした: {load.message}</Alert>}
      {load.kind === "ok" && (
        <>
          <div className="space-y-1">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-bold">
              {load.value.key.name}
              {load.value.key.system && <Badge>システム</Badge>}
            </h1>
            <p className="font-mono break-all text-fg-3">{load.value.key.key}</p>
          </div>
          {error && <Alert box>{error}</Alert>}
          {editing ? (
            <KeyForm
              current={load.value.key}
              submitLabel="変える"
              onCancel={() => setEditing(false)}
              onSubmit={async (input) => {
                await observerApi.updateKey(key, input);
                setEditing(false);
                reload();
              }}
            />
          ) : (
            <KeyInfo k={load.value.key} count={load.value.values.length} onEdit={() => setEditing(true)} onDelete={() => void act(async () => (await observerApi.deleteKey(key, load.value.key.rev), void navigate({ to: "/observer" })))} />
          )}
          {!load.value.key.system && <AddValue k={load.value.key} milestone={m} onAdded={reload} />}
          <Section title={`値 ${load.value.values.length} 件${m ? `（マイルストーン ${m}）` : ""}`}>
            <Values k={load.value.key} values={load.value.values} onDelete={(id) => void act(() => observerApi.deleteValue(key, id))} />
          </Section>
        </>
      )}
    </div>
  );
}

function KeyInfo({ k, count, onEdit, onDelete }: { k: MetricKey; count: number; onEdit: () => void; onDelete: () => void }) {
  const guide = formatGuide(k);
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-fg-3">値の形</dt>
        <dd>
          {METRIC_TYPE_LABEL[k.type]}
          {k.unit ? `（${k.unit}）` : ""}
        </dd>
        {k.description && (
          <>
            <dt className="text-fg-3">説明</dt>
            <dd className="whitespace-pre-wrap">{k.description}</dd>
          </>
        )}
        <dt className="text-fg-3">カードに出す数</dt>
        <dd>{METRIC_AGGREGATE_LABEL[k.aggregate ?? "last"]}</dd>
        {guide && (
          <>
            <dt className="text-fg-3">目安</dt>
            <dd>{guide}（並べて見せるだけで、判定はしません）</dd>
          </>
        )}
        {!k.system && (
          <>
            <dt className="text-fg-3">版</dt>
            <dd>{k.rev}</dd>
          </>
        )}
      </dl>
      {k.system ? (
        <p className="text-fg-3">システムの項目です。要望・タスクの操作のときに p3 が記録します（手で足す・消すことはできません）。</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button onClick={onEdit}>項目を変える</Button>
          <Button onClick={() => window.confirm(`項目 ${k.key} を消しますか`) && onDelete()} disabled={count > 0} title={count > 0 ? "値があるあいだは消せません（先に値を消す）" : undefined}>
            項目を消す
          </Button>
        </div>
      )}
    </div>
  );
}


function AddValue({ k, milestone, onAdded }: { k: MetricKey; milestone?: string; onAdded: () => void }) {
  const empty = { value: "", at: "", target: "", milestone: milestone ?? "", note: "" };
  const [d, setD] = useState(empty);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> }>();
  async function submit() {
    try {
      await observerApi.addValue(k.key, { ...d, value: parseValueText(k.type, d.value) });
      setD(empty);
      setError(undefined);
      onAdded();
    } catch (e) {
      setError({ message: (e as Error).message, fields: fieldErrors(e) });
    }
  }
  const text = (key: "at" | "target" | "milestone" | "note", label: string, hint?: string) => (
    <Field label={label} hint={hint} error={error?.fields[key]}>
      <input className={inputCls} value={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </Field>
  );
  return (
    <Section title="値を足す">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Alert box>{error.message}</Alert>}
        <Field label={`値（${METRIC_TYPE_LABEL[k.type]}）`} hint={k.type === "json" ? "JSON のオブジェクトか配列" : undefined} error={error?.fields.value}>
          {k.type === "boolean" ? (
            <select className={inputCls} value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })}>
              <option value="">選んでください</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : k.type === "json" || k.type === "string" ? (
            <textarea className={`${inputCls} font-mono`} rows={k.type === "json" ? 4 : 2} value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })} />
          ) : (
            <input className={inputCls} inputMode="decimal" value={d.value} onChange={(e) => setD({ ...d, value: e.target.value })} />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {text("at", "いつの値か（任意）", "YYYY-MM-DD か日時。省くと今。期間の値は期間の終わりの日")}
          {text("milestone", "マイルストーン（任意）")}
          {text("target", "対象（任意）", "要望 ID・タスク ID など")}
          {text("note", "メモ（任意）")}
        </div>
        <Button type="submit" variant="primary">
          足す
        </Button>
      </form>
    </Section>
  );
}

function Values({ k, values, onDelete }: { k: MetricKey; values: MetricValue[]; onDelete: (id: string) => void }) {
  if (!values.length) return <Empty>まだ値がありません。</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-fg-3">
          <tr>
            <th className="py-1 pr-3 font-normal">いつ</th>
            <th className="py-1 pr-3 font-normal">値</th>
            <th className="py-1 pr-3 font-normal">対象・マイルストーン・メモ</th>
            <th className="py-1 pr-3 font-normal">登録</th>
            {!k.system && <th className="py-1 font-normal">操作</th>}
          </tr>
        </thead>
        <tbody>
          {values.map((v) => (
            <tr key={v.id} className="border-t border-line align-top">
              <td className="py-2 pr-3 whitespace-nowrap">{v.at.slice(0, 16).replace("T", " ")}</td>
              <td className="py-2 pr-3 font-mono break-all">
                {formatValue(v.value)}
                {k.unit ? ` ${k.unit}` : ""}
              </td>
              <td className="py-2 pr-3 break-all">{[v.target, v.milestone, v.note].filter(Boolean).join("・") || <span className="text-fg-4">なし</span>}</td>
              <td className="py-2 pr-3 break-all">
                {v.by}
                <div data-aux className="font-mono text-sm text-fg-4">{v.id}</div>
              </td>
              {!k.system && (
                <td className="py-2">
                  <Button onClick={() => window.confirm(`値 ${v.id} を消しますか`) && onDelete(v.id)}>消す</Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
