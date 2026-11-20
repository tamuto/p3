import { hostname } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso, withFileLock, writeFileAtomic } from "@infodb/p3-shared/node/fsutil.ts";
import { DefinitionError } from "./definitionStore.ts";
import { migrateSuggestion, type SuggestionJob } from "../shared/suggestion.ts";

/**
 * 観測ごとの作業の記録（docs/architecture.md「p3-observer」）。確定した定義（observer/definitions/）とは別に、観測の ID に結び付けて
 * observer/work/<ID>/ に置く。
 *   draft.json            編集途中の入力（検証の前の不完全な入力もそのまま。version で古い画面からの上書きを断る）
 *   suggestions/<SID>.json 提案の依頼（頼んだときの定義・版・補足）と結果。依頼を保存してから始め、結果を保存してから完了にする
 * どれも置き換え書き込みで、更新は observer/.lock の中で行う。
 */
export interface Draft {
  version: number;
  /** この入力のもとにした定義の版 */
  basedOnRev: number;
  input: unknown;
  savedAt: string;
  savedBy: string;
}

const alive = (o: SuggestionJob["owner"]) => {
  if (!o || o.host !== hostname()) return true;
  try {
    process.kill(o.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class WorkStore {
  private readonly lock: string;
  constructor(readonly dataDir: string) {
    this.lock = join(dataDir, "observer", ".lock");
  }
  private dir = (id: string) => join(this.dataDir, "observer", "work", id);
  private locked = <T>(fn: () => Promise<T>) => withFileLock(this.lock, fn, { busyMessage: "観測の記録のロックを待ちきれませんでした（別のプロセスが更新しています）" });

  private async read<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DefinitionError("unreadable", `${file} を読めません: ${(e as Error).message}`);
    }
  }
  private write = (file: string, v: unknown) => writeFileAtomic(file, `${JSON.stringify(v, null, 2)}\n`);

  readDraft(id: string): Promise<Draft | undefined> {
    return this.read<Draft>(join(this.dir(id), "draft.json"));
  }

  /** 編集途中の入力を保存する。expected は読んだときの版（無ければ新しく作る）。違えば conflict（今の入力を添える） */
  saveDraft(id: string, expected: number | null, input: unknown, basedOnRev: number, actor: string): Promise<Draft> {
    return this.locked(async () => {
      const file = join(this.dir(id), "draft.json");
      const cur = await this.read<Draft>(file);
      if ((cur?.version ?? null) !== expected) {
        throw new DefinitionError("conflict", `編集途中の入力はほかで保存されています（今の版 ${cur?.version ?? "なし"}・添えた版 ${expected ?? "なし"}）。読み直してください`);
      }
      const next: Draft = { version: (cur?.version ?? 0) + 1, basedOnRev, input, savedAt: nowIso(), savedBy: actor };
      await this.write(file, next);
      return next;
    });
  }

  /** 提案の依頼を保存する（始める前） */
  async createSuggestion(job: SuggestionJob): Promise<void> {
    await this.locked(() => this.write(join(this.dir(job.definition!), "suggestions", `${job.id}.json`), { ...job, owner: { host: hostname(), pid: process.pid } }));
  }

  /** 終わりを保存する。もう終わっている（取り消し・中断を記録済み）なら上書きしない */
  finishSuggestion(job: SuggestionJob): Promise<SuggestionJob> {
    return this.locked(async () => {
      const file = join(this.dir(job.definition!), "suggestions", `${job.id}.json`);
      const cur = await this.read<SuggestionJob>(file);
      if (cur && cur.status !== "running") return cur;
      const next = { ...cur, ...job, owner: cur?.owner };
      await this.write(file, next);
      return next;
    });
  }

  /** 1件。実行していたプロセスが終わっていれば interrupted と読む */
  async getSuggestion(id: string, sid: string): Promise<SuggestionJob | undefined> {
    if (!/^sg-[0-9a-f]{12}$/.test(sid)) return undefined;
    const raw = await this.read<SuggestionJob>(join(this.dir(id), "suggestions", `${sid}.json`));
    const j = raw && migrateSuggestion(raw);
    return j && (j.status === "running" && !alive(j.owner) ? { ...j, status: "interrupted", error: "実行していたプロセスが終わっています（中断）。同じ入力で頼み直せます" } : j);
  }

  /** 新しい順 */
  async listSuggestions(id: string): Promise<SuggestionJob[]> {
    const names = await readdir(join(this.dir(id), "suggestions")).catch(() => [] as string[]);
    const all = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.getSuggestion(id, n.slice(0, -5))));
    return all.filter((j): j is SuggestionJob => !!j).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
