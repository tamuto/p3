import type { DefinitionInput, DefinitionProblem, ObservationDefinition } from "../../shared/definition.ts";
import { OBSERVER_API, type ObserverStatus } from "../../shared/status.ts";
import type { SuggestionContext, SuggestionJob } from "../../shared/suggestion.ts";
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

export interface DefinitionListing {
  definitions: ObservationDefinition[];
  unreadable: { file: string; reason: string }[];
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; problems?: DefinitionProblem[]; current?: ObservationDefinition };
  if (!res.ok) throw new ObserverApiError(data.error ?? `${res.status} ${res.statusText}`, res.status, data.code, data.problems ?? [], data.current);
  return data;
}

const project = observerScope;

export const fetchStatus = () => call<ObserverStatus>(`${OBSERVER_API}/status`);
export const fetchDefinitions = () => call<DefinitionListing>(`${project().apiBase}/definitions`, { headers: project().headers });
export const fetchDefinition = (id: string) =>
  call<{ definition: ObservationDefinition }>(`${project().apiBase}/definitions/${encodeURIComponent(id)}`, { headers: project().headers });
export const createDefinition = (input: unknown) =>
  call<ObservationDefinition>(`${project().apiBase}/definitions`, { method: "POST", headers: project().headers, body: JSON.stringify(input) });
export const updateDefinition = (id: string, rev: number, input: unknown) =>
  call<ObservationDefinition>(`${project().apiBase}/definitions/${encodeURIComponent(id)}`, { method: "PUT", headers: project().headers, body: JSON.stringify({ rev, definition: input }) });

export type { DefinitionInput };

export interface DraftRecord {
  version: number;
  basedOnRev: number;
  input: unknown;
  savedAt: string;
}
const def = (id: string) => `${project().apiBase}/definitions/${encodeURIComponent(id)}`;
export const fetchDraft = (id: string) => call<{ draft: DraftRecord | null }>(`${def(id)}/draft`, { headers: project().headers });
export const saveDraft = (id: string, version: number | null, basedOnRev: number, input: unknown) =>
  call<DraftRecord>(`${def(id)}/draft`, { method: "PUT", headers: project().headers, body: JSON.stringify({ version, basedOnRev, input }) });
export const fetchSuggestionContext = () => call<SuggestionContext>(`${project().apiBase}/suggestions/context`, { headers: project().headers });
export const listSuggestions = (id: string) => call<{ suggestions: SuggestionJob[] }>(`${def(id)}/suggestions`, { headers: project().headers });
export const startSuggestion = (id: string, body: { definition: unknown; note?: string; basedOnRev: number }) =>
  call<SuggestionJob>(`${def(id)}/suggestions`, { method: "POST", headers: project().headers, body: JSON.stringify(body) });
export const fetchSuggestion = (id: string, sid: string) => call<SuggestionJob>(`${def(id)}/suggestions/${sid}`, { headers: project().headers });
export const cancelSuggestion = (id: string, sid: string) => call<{ cancelled: boolean }>(`${def(id)}/suggestions/${sid}/cancel`, { method: "POST", headers: project().headers });
