import { Alert, Button, Field, inputCls } from "@infodb/p3-shared/web/ui.tsx";
import { useState } from "react";
import { METRIC_AGGREGATE_LABEL, METRIC_AGGREGATES, METRIC_TYPE_LABEL, METRIC_TYPES, type MetricAggregate, type MetricKey, type MetricType } from "../../shared/metric.ts";
import { fieldErrors } from "../lib/api.ts";

interface Draft {
  key: string;
  name: string;
  type: MetricType;
  unit: string;
  description: string;
  min: string;
  max: string;
  expected: string;
  aggregate: MetricAggregate;
}

const draftOf = (k?: MetricKey): Draft => ({
  key: k?.key ?? "",
  name: k?.name ?? "",
  type: k?.type ?? "number",
  unit: k?.unit ?? "",
  description: k?.description ?? "",
  min: k?.guide?.min === undefined ? "" : String(k.guide.min),
  max: k?.guide?.max === undefined ? "" : String(k.guide.max),
  expected: k?.guide?.expected === undefined ? "" : String(k.guide.expected),
  aggregate: k?.aggregate ?? "last",
});

/** 項目キーの登録・変更の入力（検証は API。誤りは項目の下に出す）。current を渡すと変更（キーは変えられない） */
export function KeyForm({ current, submitLabel, onSubmit, onCancel }: { current?: MetricKey; submitLabel: string; onSubmit: (input: Record<string, unknown>) => Promise<void>; onCancel?: () => void }) {
  const [d, setD] = useState(() => draftOf(current));
  const [error, setError] = useState<{ message: string; fields: Record<string, string> }>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const text = (key: "key" | "name" | "unit" | "min" | "max" | "expected", label: string, hint?: string, path: string = key) => (
    <Field label={label} hint={hint} error={error?.fields[path]}>
      <input className={inputCls} value={d[key]} aria-invalid={!!error?.fields[path]} onChange={(e) => set({ [key]: e.target.value })} />
    </Field>
  );
  async function submit() {
    setBusy(true);
    try {
      const guide = d.type === "number" ? { min: d.min, max: d.max } : d.type === "json" ? undefined : { expected: d.expected };
      await onSubmit({ ...(current ? { rev: current.rev } : { key: d.key.trim() }), name: d.name, type: d.type, unit: d.unit, description: d.description, guide, aggregate: d.type === "number" ? d.aggregate : "last" });
    } catch (e) {
      setError({ message: (e as Error).message, fields: fieldErrors(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error && <Alert box>{error.message}</Alert>}
      {!current && text("key", "項目キー", "英小文字・数字・.・_・- だけ（例: cost.ai_usage）。値を入れる側（CI・スクリプト・人）がこのキーを指定します。p3. で始まるキーはシステム用です")}
      {text("name", "名前")}
      <Field label="値の形" hint={current ? "値があるあいだは変えられません" : undefined} error={error?.fields.type}>
        <select className={inputCls} value={d.type} onChange={(e) => set({ type: e.target.value as MetricType })}>
          {METRIC_TYPES.map((t) => (
            <option key={t} value={t}>
              {METRIC_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </Field>
      {text("unit", "単位（任意）", "例: 円・件・ms")}
      <Field label="説明（任意）" error={error?.fields.description}>
        <textarea className={inputCls} rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      {d.type === "number" && (
        <Field label="カードに出す数" hint="観測のトップのカードに大きく出す数。値1つが1件の出来事なら合計、毎回の測った値なら平均か最後の値" error={error?.fields.aggregate}>
          <select className={inputCls} value={d.aggregate} onChange={(e) => set({ aggregate: e.target.value as MetricAggregate })}>
            {METRIC_AGGREGATES.map((a) => (
              <option key={a} value={a}>
                {METRIC_AGGREGATE_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {d.type === "number" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("min", "目安の下限（任意）", undefined, "guide.min")}
          {text("max", "目安の上限（任意）", undefined, "guide.max")}
        </div>
      )}
      {d.type === "string" && text("expected", "目安の期待する値（任意）", undefined, "guide.expected")}
      {d.type === "boolean" && (
        <Field label="目安の期待する値（任意）" error={error?.fields["guide.expected"]}>
          <select className={inputCls} value={d.expected} onChange={(e) => set({ expected: e.target.value })}>
            <option value="">なし</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </Field>
      )}
      {error?.fields.guide && <p className="text-base text-danger">{error.fields.guide}</p>}
      <p className="text-fg-3">目安は値と並べて見せるだけです。p3 は値を目安と比べた判定をしません。</p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel && <Button onClick={onCancel}>やめる</Button>}
      </div>
    </form>
  );
}
