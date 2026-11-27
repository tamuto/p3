import type { KeySummary, MetricKey, MetricValue, Problem } from "../../shared/metric.ts";
import { observerScope } from "./scope.ts";

/** 観測の API の失敗（code と、入力の誤りなら problems） */
export class ObserverApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly problems: Problem[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { apiBase, headers } = observerScope();
  const res = await fetch(`${apiBase}${path}`, { method, cache: "no-store", headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; problems?: Problem[] };
  if (!res.ok) throw new ObserverApiError(data.error ?? `${res.status} ${res.statusText}`, res.status, data.code, data.problems ?? []);
  return data;
}

const q = (milestone?: string) => (milestone ? `?milestone=${encodeURIComponent(milestone)}` : "");
const k = (key: string) => `/keys/${encodeURIComponent(key)}`;

export interface KeyListing {
  keys: KeySummary[];
  milestones: string[];
  unreadable: { file: string; reason: string }[];
}

export const observerApi = {
  keys: (milestone?: string) => call<KeyListing>("GET", `/keys${q(milestone)}`),
  key: (key: string, milestone?: string) => call<{ key: MetricKey; values: MetricValue[] }>("GET", `${k(key)}${q(milestone)}`),
  createKey: (input: Record<string, unknown>) => call<MetricKey>("POST", "/keys", input),
  updateKey: (key: string, input: Record<string, unknown>) => call<MetricKey>("PUT", k(key), input),
  deleteKey: (key: string, rev: number) => call<{ deleted: string }>("DELETE", `${k(key)}?rev=${rev}`),
  addValue: (key: string, input: Record<string, unknown>) => call<MetricValue>("POST", `${k(key)}/values`, input),
  deleteValue: (key: string, id: string) => call<{ deleted: string }>("DELETE", `${k(key)}/values/${encodeURIComponent(id)}`),
};

/** 入力の誤りを項目の場所ごとに */
export const fieldErrors = (e: unknown): Record<string, string> => Object.fromEntries((e instanceof ObserverApiError ? e.problems : []).map((p) => [p.path, p.message]));
