import type { DefinitionInput, DefinitionProblem, FileState, ObservationDefinition, References } from "../../shared/definition.ts";
import type { Preparation, Slot } from "../../shared/preparation.ts";
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
    readonly current?: { rev: number },
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
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; problems?: DefinitionProblem[]; current?: { rev: number } };
  if (!res.ok) throw new ObserverApiError(data.error ?? `${res.status} ${res.statusText}`, res.status, data.code, data.problems ?? [], data.current);
  return data;
}

const project = observerScope;

export const fetchStatus = () => call<ObserverStatus>(`${OBSERVER_API}/status`);
export const fetchDefinitions = () => call<DefinitionListing>(`${project().apiBase}/definitions`, { headers: project().headers });
export const fetchDefinition = (id: string) =>
  call<{ definition: ObservationDefinition; references: References }>(`${project().apiBase}/definitions/${encodeURIComponent(id)}`, { headers: project().headers });
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
export const fetchFiles = (keys: string[]) =>
  call<{ files: Record<string, { state: FileState; checkedAt: string }> }>(`${project().apiBase}/files?${keys.map((k) => `ref=${encodeURIComponent(k)}`).join("&")}`, { headers: project().headers });
export const switchProcedure = (id: string, pid: string, rev: number, invoke: string, evidence: string) =>
  call<ObservationDefinition>(`${def(id)}/procedures/${pid}/switch`, { method: "POST", headers: project().headers, body: JSON.stringify({ rev, invoke, evidence }) });
export const fetchSuggestionContext = () => call<SuggestionContext>(`${project().apiBase}/suggestions/context`, { headers: project().headers });
export const listSuggestions = (id: string) => call<{ suggestions: SuggestionJob[] }>(`${def(id)}/suggestions`, { headers: project().headers });
export const startSuggestion = (id: string, body: { definition: unknown; note?: string; basedOnRev: number }) =>
  call<SuggestionJob>(`${def(id)}/suggestions`, { method: "POST", headers: project().headers, body: JSON.stringify(body) });
export const fetchSuggestion = (id: string, sid: string) => call<SuggestionJob>(`${def(id)}/suggestions/${sid}`, { headers: project().headers });
export const cancelSuggestion = (id: string, sid: string) => call<{ cancelled: boolean }>(`${def(id)}/suggestions/${sid}/cancel`, { method: "POST", headers: project().headers });

export interface PreparationDetail {
  preparation: Preparation;
  usedBy: { definitions: { id: string; title: string; rev: number }[]; unreadable: DefinitionListing["unreadable"] };
}
const prep = (id = "") => `${project().apiBase}/preparations${id ? `/${encodeURIComponent(id)}` : ""}`;
export const fetchPreparations = () => call<{ items: Preparation[]; unreadable: DefinitionListing["unreadable"] }>(prep(), { headers: project().headers });
export const fetchPreparation = (id: string) => call<PreparationDetail>(prep(id), { headers: project().headers });
export const createPreparation = (input: unknown) => call<Preparation>(prep(), { method: "POST", headers: project().headers, body: JSON.stringify(input) });
export const updatePreparation = (id: string, rev: number, input: unknown) => call<Preparation>(prep(id), { method: "PUT", headers: project().headers, body: JSON.stringify({ rev, preparation: input }) });
export const deletePreparation = (id: string, rev: number) => call<{ deleted: string }>(`${prep(id)}?rev=${rev}`, { method: "DELETE", headers: project().headers });
export const switchSlot = (id: string, slot: Slot, rev: number, invoke: string, evidence: string) =>
  call<Preparation>(`${prep(id)}/${slot}/switch`, { method: "POST", headers: project().headers, body: JSON.stringify({ rev, invoke, evidence }) });
