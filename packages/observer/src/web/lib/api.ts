import type { DefinitionInput, DefinitionProblem, ObservationDefinition } from "../../shared/definition.ts";
import { OBSERVER_API, type ObserverStatus } from "../../shared/status.ts";
import { observerScope } from "./scope.ts";

/** 観測の API の失敗（code と、入力の誤りなら problems、版の競合なら current） */
export class ObserverApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly problems: DefinitionProblem[] = [],
    readonly current?: ObservationDefinition,
  ) {
    super(message);
  }
}

export interface DefinitionTargetInfo {
  project: string | null;
  dataDir: string;
  dir: string;
}
export interface DefinitionListing {
  target: DefinitionTargetInfo;
  definitions: ObservationDefinition[];
  unreadable: { file: string; reason: string }[];
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; problems?: DefinitionProblem[]; current?: ObservationDefinition };
  if (!res.ok) throw new ObserverApiError(data.error ?? `${res.status} ${res.statusText}`, res.status, data.code, data.problems ?? [], data.current);
  return data;
}

function project() {
  const s = observerScope();
  if (s.kind !== "project") throw new Error("プロジェクトを選んでから観測の定義を開いてください");
  return s;
}

export const fetchStatus = () => call<ObserverStatus>(`${OBSERVER_API}/status`);
export const fetchDefinitions = () => call<DefinitionListing>(`${project().apiBase}/definitions`, { headers: project().headers });
export const fetchDefinition = (id: string) =>
  call<{ target: DefinitionTargetInfo; definition: ObservationDefinition }>(`${project().apiBase}/definitions/${encodeURIComponent(id)}`, { headers: project().headers });
export const createDefinition = (input: unknown) =>
  call<ObservationDefinition>(`${project().apiBase}/definitions`, { method: "POST", headers: project().headers, body: JSON.stringify(input) });
export const updateDefinition = (id: string, rev: number, input: unknown) =>
  call<ObservationDefinition>(`${project().apiBase}/definitions/${encodeURIComponent(id)}`, { method: "PUT", headers: project().headers, body: JSON.stringify({ rev, definition: input }) });

export type { DefinitionInput };
