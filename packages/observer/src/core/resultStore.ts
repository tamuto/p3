import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createExclusive, newRequestId, nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import { git } from "@infodb/p3-shared/node/usage.ts";
import { DefinitionError, type DefinitionStore, type PreparationStore } from "./definitionStore.ts";
import { isDefinitionId } from "../shared/definition.ts";
import { isResultId, judge, prerequisiteState, RESULT_FORMAT, RESULTS_DIR, resultSummary, type ResultSummary, snapshotOf, validateStep, type EnvRepo, type ObservationResult, type PrerequisiteState } from "../shared/result.ts";

/** 参照先ごとの今のコミット・ブランチ・未コミットの変更（読めないものは commit が無い） */
export function readEnvironment(repos: [string, string | undefined][]): EnvRepo[] {
  return repos.map(([name, path]) => {
    if (!path) return { name };
    const commit = git(path, "rev-parse", "HEAD");
    const branch = commit && git(path, "rev-parse", "--abbrev-ref", "HEAD");
    const dirty = commit ? !!git(path, "status", "--porcelain") : undefined;
    return { name, ...(commit ? { commit } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}), ...(dirty ? { dirty } : {}) };
  });
}

/**
 * 観測の結果の保存（docs/architecture.md「p3-observer」の観測の実行と結果）。observer/results/<観測ID>/<結果ID>.json に1件ずつ。
 * 開始で写しを持つ結果を作り（O_EXCL）、段の記録は足すだけ、完了・中断した結果は変えない。書き込みは定義と同じ observer/.lock の中で行う。
 * 観測の定義のファイルには触れない（版も履歴も増えない）
 */
export class ResultStore {
  private readonly lock: string;
  constructor(
    readonly dataDir: string,
    private readonly defs: DefinitionStore,
    private readonly preps: PreparationStore,
  ) {
    this.lock = join(dataDir, "observer", ".lock");
  }
  private dir = (obs: string) => join(this.dataDir, RESULTS_DIR, obs);
  private file = (obs: string, rid: string) => join(this.dir(obs), `${rid}.json`);
  private locked = <T>(fn: () => Promise<T>) => withFileLock(this.lock, fn, { busyMessage: "観測の結果のロックを待ちきれませんでした（別のプロセスが更新しています）" });
  private save = (r: ObservationResult) => writeFileAtomic(this.file(r.observation, r.id), `${JSON.stringify(r, null, 2)}\n`);

  async get(obs: string, rid: string): Promise<ObservationResult> {
    if (!isDefinitionId(obs) || !isResultId(rid)) throw new DefinitionError("not_found", `観測の結果がありません: ${obs}/${rid}`);
    let text: string;
    try {
      text = await readFile(this.file(obs, rid), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DefinitionError("not_found", `観測の結果がありません: ${obs}/${rid}`);
      throw new DefinitionError("unreadable", `観測の結果 ${rid} を読めません: ${(e as Error).message}`);
    }
    const r = JSON.parse(text) as ObservationResult;
    if (r.format !== RESULT_FORMAT || r.id !== rid || r.observation !== obs) throw new DefinitionError("unreadable", `観測の結果 ${rid} の形が違います（format: ${JSON.stringify(r.format)}）`);
    return r;
  }

  /** 新しい順。読めないファイルは理由だけ返す */
  async list(obs: string): Promise<{ results: ObservationResult[]; unreadable: { file: string; reason: string }[] }> {
    if (!isDefinitionId(obs)) throw new DefinitionError("not_found", `観測の定義の ID ではありません: ${obs}`);
    const names = await readdir(this.dir(obs)).catch(() => [] as string[]);
    const results: ObservationResult[] = [];
    const unreadable: { file: string; reason: string }[] = [];
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        results.push(await this.get(obs, n.slice(0, -5)));
      } catch (e) {
        unreadable.push({ file: n, reason: (e as Error).message });
      }
    }
    results.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    return { results, unreadable };
  }

  /** 始める: 今の定義と使う準備を写した結果を running で作る。終了した観測は始めない */
  async start(obs: string, actor: string, env: { repos: EnvRepo[]; note?: string }): Promise<ObservationResult> {
    return this.locked(async () => {
      const d = await this.defs.get(obs);
      if (d.ended) throw new DefinitionError("invalid", `観測 ${obs} は終了しています（${d.ended.reason}）。終えた観測は実行しません`);
      const preps = d.preparations?.length ? (await this.preps.list()).items : [];
      const missing = (d.preparations ?? []).filter((id) => !preps.some((p) => p.id === id));
      if (missing.length) throw new DefinitionError("unreadable", `使う準備を読めません: ${missing.join("・")}`);
      for (let i = 0; i < 20; i++) {
        const at = nowIso();
        const r: ObservationResult = { format: RESULT_FORMAT, id: `res-${newRequestId()}`, observation: obs, rev: d.rev, snapshot: snapshotOf(d, preps), status: "running", startedAt: at, startedBy: actor, environment: { repos: env.repos, ...(env.note?.trim() ? { note: env.note.trim() } : {}) }, steps: [] };
        if (await createExclusive(this.file(obs, r.id), `${JSON.stringify(r, null, 2)}\n`)) return r;
      }
      throw new Error("観測の結果の ID を採番できませんでした（もう一度実行してください）");
    });
  }

  private running(r: ObservationResult) {
    if (r.status !== "running") throw new DefinitionError("conflict", `観測の結果 ${r.id} は${r.status === "completed" ? "完了" : "中断"}しています。変えられません（新しく実行してください）`);
  }

  /** 段を1つ記録する（足すだけ。同じ段を記録し直すと判定には後のものを使う） */
  record(obs: string, rid: string, input: unknown, actor: string): Promise<ObservationResult> {
    return this.locked(async () => {
      const r = await this.get(obs, rid);
      this.running(r);
      const v = validateStep(input, r.snapshot);
      if (!v.ok) throw new DefinitionError("invalid", "段の記録に誤りがあります", v.problems);
      const next = { ...r, steps: [...r.steps, { ...v.value, at: nowIso(), by: actor }] };
      await this.save(next);
      return next;
    });
  }

  /** 完了して判定する。前提の観測は今の版で完了した最後の結果を照らし、その状態も残す */
  finish(obs: string, rid: string, actor: string): Promise<ObservationResult> {
    return this.locked(async () => {
      const r = await this.get(obs, rid);
      this.running(r);
      const prerequisites = await this.prerequisites(r);
      const j = judge(r, prerequisites);
      const next: ObservationResult = { ...r, status: "completed", prerequisites, verdict: j.verdict, reason: j.reason, ...(j.teardownProblems.length ? { teardownProblems: j.teardownProblems } : {}), finishedAt: nowIso(), finishedBy: actor };
      await this.save(next);
      return next;
    });
  }

  /** 観測ごとの要約（一覧で後から読む。読めない結果は数えない） */
  async summaries(defs: { id: string; rev: number }[]): Promise<Record<string, ResultSummary>> {
    const out: Record<string, ResultSummary> = {};
    for (const d of defs) out[d.id] = resultSummary((await this.list(d.id)).results, d.rev);
    return out;
  }

  /** 前提の観測の今の状態（今の版で完了した最後の結果の判定） */
  prerequisites(r: ObservationResult): Promise<PrerequisiteState[]> {
    return Promise.all(
      r.snapshot.prerequisites.map(async (id) => {
        const cur = await this.defs.get(id).catch(() => undefined);
        return prerequisiteState(id, cur, cur ? (await this.list(id)).results : []);
      }),
    );
  }

  /** 中断として閉じる（途中で止めた・続けられない）。判定しない */
  async interrupt(obs: string, rid: string, actor: string, reason: string): Promise<ObservationResult> {
    if (!reason.trim()) throw new DefinitionError("invalid", "中断の理由を書いてください", [{ path: "reason", message: "中断の理由を書いてください" }]);
    return this.locked(async () => {
      const r = await this.get(obs, rid);
      this.running(r);
      const next: ObservationResult = { ...r, status: "interrupted", interruptedReason: reason.trim(), finishedAt: nowIso(), finishedBy: actor };
      await this.save(next);
      return next;
    });
  }
}
