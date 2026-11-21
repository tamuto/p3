import { randomBytes } from "node:crypto";
import { nowIso } from "@infodb/p3-shared/node/fsutil.ts";
import type { WorkStore } from "./workStore.ts";
import { SUGGEST_TIMEOUT_MS, type SuggestAdapter } from "./suggest.ts";
import { CANDIDATE_INSTRUCTIONS, candidatePrompt, InvalidCandidates, mockCandidates, parseCandidates, type CandidateJob, type CandidateMaterial } from "../shared/candidates.ts";
import { SuggestionError } from "../shared/suggestion.ts";

/**
 * 観測の候補の提案の実行（人が頼んだときだけ。docs/architecture.md「p3-observer」の観測の候補と表示の速さ）。材料はアプリが作り（material）、
 * 頼む先は手順の提案と同じアダプター。依頼（材料・補足）を保存してから始め、結果を保存してから完了にする。定義は書かない
 */
export class CandidateService {
  private done = new Map<string, Promise<CandidateJob>>();
  constructor(
    private readonly adapter: SuggestAdapter,
    private readonly opts: { store: WorkStore; material: () => Promise<CandidateMaterial>; timeoutMs?: number },
  ) {}

  async start(note?: string): Promise<CandidateJob> {
    const job: CandidateJob = { id: `cd-${randomBytes(6).toString("hex")}`, status: "running", engine: "", startedAt: nowIso(), ...(note?.trim() ? { note: note.trim() } : {}), material: await this.opts.material() };
    await this.opts.store.saveCandidates(job);
    this.done.set(job.id, this.execute(job));
    return job;
  }

  /** 始めて終わるまで待つ（CLI） */
  async run(note?: string): Promise<CandidateJob> {
    const job = await this.start(note);
    return this.done.get(job.id)!;
  }

  private async execute(job: CandidateJob): Promise<CandidateJob> {
    const timeoutMs = this.opts.timeoutMs ?? SUGGEST_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    let end: Partial<CandidateJob>;
    try {
      const ctx = await this.adapter.context();
      if (!ctx.engine.ok) throw new SuggestionError("unavailable", ctx.engine.detail);
      const readable = ctx.repos.filter((r) => r.available);
      const r = await this.adapter.ask(
        { instructions: CANDIDATE_INSTRUCTIONS, prompt: candidatePrompt(job.material, readable.map((x) => x.path ?? x.name), ctx.project, job.note), repos: readable.map((x) => x.name), mock: () => mockCandidates(job.material), label: "観測の候補の提案" },
        () => {},
        signal,
      );
      end = { engine: r.engine, status: "completed", ...parseCandidates(r.message, job.material) };
    } catch (e) {
      if (signal.aborted) end = { status: "failed", failure: "timeout", error: `時間切れです（${Math.round(timeoutMs / 1000)} 秒）` };
      else if (e instanceof SuggestionError) end = { status: "failed", failure: e.kind, error: e.message };
      else if (e instanceof InvalidCandidates) end = { status: "failed", failure: "invalid_output", error: `応答の形が違います: ${e.message}` };
      else end = { status: "failed", failure: "error", error: (e as Error)?.message ?? String(e) };
    }
    const next = { ...job, ...end, finishedAt: nowIso() };
    await this.opts.store.saveCandidates(next).catch(() => {});
    return next;
  }
}
