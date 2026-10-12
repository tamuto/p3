import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RELATION_TYPES,
  type PreflightAssessment,
  type PreflightLogEntry,
  type PreflightRun,
  type ProposedTask,
  type Relation,
  type Request,
  type RelationType,
  type MaterializeResult,
  type Task,
} from "../../shared/types.ts";
import { absRef, normalizeTaskId, relRef } from "../../shared/refs.ts";
import type { ProjectIndex } from "../intel/index.ts";
import { nowIso, slugify, writeFileAtomic } from "../store/fsutil.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import type { Workspace } from "../store/workspace.ts";
import { supersedeCandidates } from "../supersede.ts";
import { redact } from "../redact.ts";
import { renderCarryover, selectCarryover } from "./carryover.ts";
import type { PreflightEngine, PreflightJob } from "./engine.ts";

/** 始められない理由をそのまま失敗にするエンジン（run の記録とログに残すため） */
const failing = (name: PreflightEngine["name"], message: string): PreflightEngine => ({
  name,
  status: async () => ({ name, ok: false, detail: message }),
  run: async () => Promise.reject(new Error(message)),
});

export class PreflightService {
  private active = new Map<string, { run: PreflightRun; abort: AbortController; done: Promise<void> }>();

  /** 最後に分かった既定のエンジン */
  private lastDefault: PreflightEngine["name"];

  /**
   * defaultEngine: 決まった名前か、読むたびに今の既定を返す関数（serve: 個人設定の preflight.engine を Preflight を始めるたびに読む）
   */
  constructor(
    private ws: Workspace,
    private index: ProjectIndex,
    private engines: Partial<Record<PreflightEngine["name"], PreflightEngine>>,
    defaultEngine: PreflightEngine["name"] | { load: () => Promise<PreflightEngine["name"]>; initial: PreflightEngine["name"] },
  ) {
    if (typeof defaultEngine === "string") {
      this.lastDefault = defaultEngine;
      this.loadDefault = async () => defaultEngine;
    } else {
      this.lastDefault = defaultEngine.initial;
      this.loadDefault = defaultEngine.load;
    }
  }

  private loadDefault: () => Promise<PreflightEngine["name"]>;

  /** 既定のエンジン（最後に読めた値。画面の表示用） */
  get defaultEngine(): PreflightEngine["name"] {
    return this.lastDefault;
  }

  /** 今の既定のエンジン。読めなければ SettingsError など */
  private async currentDefault(): Promise<PreflightEngine["name"]> {
    this.lastDefault = await this.loadDefault();
    return this.lastDefault;
  }

  /** 既定のエンジンが使えるか（個人設定を読み直す。読めなければ直す場所を出す） */
  async engineStatus() {
    let name: PreflightEngine["name"];
    try {
      name = await this.currentDefault();
    } catch (e) {
      return { name: this.lastDefault, ok: false, detail: `個人設定を読めないので Preflight を始められません: ${(e as Error).message}` };
    }
    const e = this.engines[name];
    return e ? e.status() : { name, ok: false, detail: "エンジンがありません" };
  }

  availableEngines() {
    return Object.keys(this.engines) as PreflightEngine["name"][];
  }

  async list(requestId: string) {
    return this.ws.preflight.list(requestId);
  }

  async get(requestId: string, runId: string) {
    return this.active.get(runId)?.run ?? (await this.ws.preflight.get(requestId, runId));
  }

  /** 次の Preflight に引き継ぐもの（画面・CLI で実行前に見せる） */
  carryover(requestId: string) {
    this.ws.requests.require(requestId);
    return selectCarryover(this.ws, requestId);
  }

  /** Preflight へのメモを書き足す */
  async addNote(requestId: string, body: string, actor?: string) {
    this.ws.requests.require(requestId);
    const note = await this.ws.notes.add(requestId, body, actor);
    this.ws.emit({ type: "changed", kind: "note", request: requestId });
    return note;
  }

  async start(requestId: string, opts: { engine?: PreflightEngine["name"]; actor?: string } = {}): Promise<PreflightRun> {
    const request = this.ws.requests.require(requestId);
    if ([...this.active.values()].some((a) => a.run.requestId === requestId)) {
      throw new Error(`${requestId} の preflight は実行中です`);
    }
    // 既定のエンジンは始めるたびに個人設定から決める。読めなければ、この run を設定のエラーとして失敗にする
    // （古い設定や Mock に落とさない。serve とほかの操作は続ける）
    let engine: PreflightEngine | undefined;
    if (opts.engine) engine = this.engines[opts.engine];
    else {
      try {
        engine = this.engines[await this.currentDefault()];
      } catch (e) {
        const message = `個人設定を読めないので Preflight を始めません（Docker は起動していません）: ${(e as Error).message}`;
        engine = failing(this.lastDefault, message);
      }
    }
    if (!engine) throw new Error(`engine ${opts.engine} は利用できません`);
    // 始めるときの設定に決める（この run の間は個人設定が変わっても使い続ける）
    if (engine.snapshot) {
      const from = engine;
      engine = await from.snapshot!().catch((e: Error) => failing(from.name, e.message));
    }

    const stamp = nowIso().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const id = `PF-${stamp}-${randomBytes(2).toString("hex")}`;
    // 関連項目の選定: 要望本文・領域・既に張られた関係を起点に
    const context = this.index.related({
      text: `${request.title}\n${request.body}`,
      areas: request.areas,
      seeds: request.relations.map((r) => absRef(r.target, request.id)).filter((x): x is string => !!x),
      exclude: [request.id],
      limit: 10,
    });
    // 前回の結果とその後のメモ。開始の時点で選んで固定する（実行中に足されたメモは次回に回る）
    const carry = await selectCarryover(this.ws, requestId);
    const carryover = renderCarryover(carry);
    const run: PreflightRun = {
      id,
      requestId,
      engine: engine.name,
      status: "running",
      startedAt: nowIso(),
      startedBy: opts.actor,
      previous: carry.previous?.id,
      notes: carry.notes.length ? carry.notes.map((n) => n.id) : undefined,
      context,
      log: [],
      drafts: [],
    };
    const runDir = this.ws.preflight.runDir(requestId, id);
    await this.ws.preflight.save(run);
    if (carryover) await writeFileAtomic(join(runDir, "carryover.md"), carryover);
    const carried = carryover ? { text: carryover, previous: carry.previous, notes: carry.notes } : undefined;
    if (carry.previous) this.log(run, { kind: "info", text: `前回 ${carry.previous.id} の結果を引き継ぎます` });
    else if (carry.previousSkipped) this.log(run, { kind: "info", text: `前回の結果は引き継ぎません（${carry.previousSkipped}）` });
    if (carry.notes.length) this.log(run, { kind: "info", text: `メモ ${carry.notes.length} 件を渡します: ${carry.notes.map((n) => n.id).join(", ")}` });
    for (const n of carry.invalidNotes) this.log(run, { kind: "error", text: `読めないメモを除きました: ${n.file}（${n.error}）` });
    // 要望のスナップショットと文脈をファイルとして残す（後から「何を根拠に判断したか」を辿れる）
    await writeFileAtomic(join(runDir, "request.md"), `# ${request.id} ${request.title}\n\n${request.body}`);
    await writeFileAtomic(
      join(runDir, "context.md"),
      `# Context for ${request.id}\n\n${context.map((c) => `- ${c.ref} ${c.title} (${c.score}) — ${c.reasons.join(" / ")}`).join("\n")}\n`,
    );
    // ステータスを動かすのはタスク化する前の要望だけ。進行中・完了の要望で再評価しても状態は変えない
    const before = request.status;
    const early = before === "draft" || before === "preflight" || before === "reviewed";
    await this.ws.requests.update(requestId, early ? { status: "preflight", lastPreflight: id } : { lastPreflight: id }, { actor: opts.actor });
    this.ws.emit({ type: "changed", kind: "request", request: requestId });

    const abort = new AbortController();
    const after = (ok: boolean) => (early ? (ok ? "reviewed" : before === "reviewed" ? "reviewed" : "draft") : before);
    const done = this.execute(engine, run, runDir, carried, abort.signal, after);
    this.active.set(id, { run, abort, done });
    return run;
  }

  /** 実行中の run の完了を待つ（CLI 用）。完了後の run を返す */
  async wait(requestId: string, runId: string): Promise<PreflightRun | undefined> {
    await this.active.get(runId)?.done;
    return this.ws.preflight.get(requestId, runId);
  }

  cancel(runId: string) {
    this.active.get(runId)?.abort.abort();
  }

  private log(run: PreflightRun, e: Omit<PreflightLogEntry, "at">) {
    // トークンらしいもの（Codex のエラーが一部を見せるキーなど）は残さない
    const entry = { ...e, text: redact(e.text), at: nowIso() };
    run.log.push(entry);
    this.ws.emit({ type: "preflight-log", runId: run.id, entry });
  }

  private async execute(
    engine: PreflightEngine,
    run: PreflightRun,
    runDir: string,
    carryover: PreflightJob["carryover"],
    signal: AbortSignal,
    after: (ok: boolean) => Request["status"],
  ) {
    const repoRoot = this.ws.repoRoot;
    try {
      this.log(run, { kind: "info", text: `関連項目 ${run.context.length} 件を文脈として選定` });
      const outcome = await engine.run(
        {
          project: this.ws.project,
          request: this.ws.requests.require(run.requestId),
          context: run.context,
          repoRoot,
          dataDir: this.ws.dataDir,
          runDir,
          carryover,
        },
        (e) => this.log(run, e),
        signal,
      );
      // 書いてよい範囲の外が変更されていないか確かめる
      const stray = outcome.changed.filter((p) => !p.startsWith(`${runDir}/`));
      for (const p of stray) {
        const inRepo = relative(repoRoot, p);
        const shown = inRepo.startsWith("..") || isAbsolute(inRepo) ? p : inRepo;
        this.log(run, { kind: "error", text: `想定外の変更: ${shown}（確認して必要なら元に戻してください）` });
      }

      run.assessment = parseAssessment(await readFile(join(runDir, "assessment.json"), "utf8"));
      run.drafts = await this.ws.preflight.loadDrafts(run.requestId, run.id);
      run.status = "completed";
    } catch (e) {
      run.status = "failed";
      run.error = redact((e as Error).message);
      this.log(run, { kind: "error", text: run.error });
    } finally {
      run.finishedAt = nowIso();
      await this.ws.preflight.save(run);
      // 評価中にした要望だけ、終わったら評価済み（失敗なら元）へ戻す。実行中に人や AI が変えたステータス
      // （進行中に戻した・完了済にしたなど）や、評価中にしていない要望（進行中・対応済など）は上書きしない
      const status = after(run.status === "completed");
      if (this.ws.requests.get(run.requestId)?.status === "preflight" && status !== "preflight") {
        await this.ws.requests.update(run.requestId, { status });
      }
      // 保存が終わってから実行中の一覧から外す（先に外すと wait() が保存前のファイルを読む）
      this.active.delete(run.id);
      this.ws.emit({ type: "preflight-status", runId: run.id, status: run.status });
      this.ws.emit({ type: "changed", kind: "request", request: run.requestId });
    }
  }

  async updateDraft(requestId: string, runId: string, key: string, patch: Partial<ProposedTask>) {
    const run = await this.ws.preflight.get(requestId, runId);
    const draft = run?.drafts.find((d) => d.key === key);
    if (!run || !draft) throw new Error(`${runId}/${key} not found`);
    const next = { ...draft, ...patch, key };
    await this.ws.preflight.saveDraft(requestId, runId, next);
    return next;
  }

  /** タスク化の前に見せるもの: 採用する案と、置き換えられる既存タスク（ファイルは変えない） */
  async previewMaterialize(requestId: string, runId: string) {
    const run = await this.ws.preflight.get(requestId, runId);
    if (!run) throw new NotFoundError(runId);
    return {
      include: run.drafts.filter((d) => d.include).map((d) => d.key),
      candidates: supersedeCandidates(this.ws, run),
      materialized: run.materialized ?? [],
    };
  }

  /**
   * タスク化: 採用されたタスク案を、要望のフォルダの tasks/T00x.md として書き出し、関係を張る。
   *   - 同じ run 内の dependsOn → depends_on（要望の中なので相対参照 T00x）
   *   - 案が持つ既存項目への関係 → 存在するものだけ（origin: preflight）。置き換え（supersedes）もここで各タスクに残る
   *   - 評価の impacts → 要望側の relations に記録（作業ツリー単位の影響として扱う）
   *   - archive: 置き換えられるタスク（previewMaterialize の候補）のうちアーカイブするもの。既定はどれも残す。
   *     確定の時点で候補を読み直し、候補でない・rev が変わったものがあれば何も変えずに失敗する
   *
   * 古いタスクを先に外さないよう、新しいタスクと関係を保存してからアーカイブする。途中経過は run.json の
   * materialization に残し、途中で失敗したら同じ呼び出しでやり直せる（作った案は作り直さず、アーカイブも重ねない）。
   */
  async materialize(
    requestId: string,
    runId: string,
    actor = "preflight",
    opts: { archive?: { id: string; rev?: number }[] } = {},
  ): Promise<MaterializeResult> {
    const run = await this.ws.preflight.get(requestId, runId);
    if (!run || run.status !== "completed") throw new Error("完了した preflight のみタスク化できます");
    const resuming = run.materialization && !run.materialization.done;
    if (!resuming && run.materialized?.length) throw new Error(`既にタスク化済みです: ${run.materialized.join(", ")}`);
    const request = this.ws.requests.require(requestId);
    const tasks = this.ws.tasksOf(requestId);
    const drafts = resuming ? run.drafts.filter((d) => d.key in run.materialization!.created || d.include) : run.drafts.filter((d) => d.include);
    if (!drafts.length) throw new Error("採用したタスク案がありません");

    const candidates = supersedeCandidates(this.ws, run);
    if (!resuming) {
      const chosen: string[] = [];
      for (const sel of opts.archive ?? []) {
        const id = normalizeTaskId(sel.id) ?? sel.id;
        const c = candidates.find((x) => x.id === id);
        if (!c) throw new Error(`${id} は置き換えられるタスクの候補ではありません（もう一度確認してください）`);
        if (sel.rev !== undefined && sel.rev !== c.rev) throw new ConflictError(`${requestId}/${id}`, sel.rev, c.rev);
        if (!chosen.includes(id)) chosen.push(id);
      }
      run.materialization = { created: {}, archive: chosen, archived: [], done: false };
      await this.ws.preflight.save(run);
    }
    const state = run.materialization!;

    const keyToId = new Map<string, string>();
    const created: Task[] = [];
    // Codex が書いた参照を、存在するものだけ、ファイルに書く形（相対/絶対）にそろえる
    const toRel = (target: string) => {
      const abs = absRef(target, requestId);
      return abs && abs !== requestId && this.ws.exists(abs) ? relRef(abs, requestId) : undefined;
    };
    const keepExisting = (rels: Relation[]): Relation[] =>
      rels.flatMap((r) => {
        const target = toRel(r.target);
        return target ? [{ ...r, target, origin: "preflight" as const }] : [];
      });

    for (const d of drafts) {
      const marker = `> preflight: ${runId} / ${d.key}`;
      // やり直しでは、前回作ったタスク（本文の印で分かる）を使う
      const made = tasks.get(state.created[d.key] ?? "") ?? tasks.list().find((t) => t.body.includes(marker));
      const t =
        made ??
        (await tasks.create(
          {
            title: d.title,
            status: "todo",
            labels: [],
            areas: d.areas,
            outputs: [],
            relations: keepExisting(d.relations),
            body: `${d.description}\n\n${marker}`,
          },
          actor,
        ));
      if (state.created[d.key] !== t.id) {
        state.created[d.key] = t.id;
        await this.ws.preflight.save(run);
      }
      keyToId.set(d.key, t.id);
      created.push(t);
    }
    // 依存は全タスクの ID が決まってから張る
    for (const d of drafts) {
      const id = keyToId.get(d.key)!;
      const cur = tasks.require(id);
      const deps: Relation[] = d.dependsOn
        .map((k) => keyToId.get(k))
        .filter((t): t is string => !!t && !cur.relations.some((r) => r.type === "depends_on" && r.target === t))
        .map((target) => ({ type: "depends_on", target, origin: "preflight" }));
      if (deps.length) {
        const t = await tasks.update(id, { relations: [...cur.relations, ...deps] }, { actor });
        created[created.findIndex((c) => c.id === id)] = t;
      }
    }

    const impactRels = keepExisting(
      (run.assessment?.impacts ?? []).map((i) => ({ type: i.type, target: i.target, note: i.reason, confidence: i.confidence })),
    ).filter((i) => !request.relations.some((r) => absRef(r.target, requestId) === absRef(i.target, requestId) && r.type === i.type));
    const p = this.ws.project;
    // 日本語のタイトルは slug にならないので、そのときは区切りごと落とす (req/261009-k7m3x)
    const slug = slugify(request.title);
    const branch = p.branchPattern
      .replace("{id}", requestId)
      .replace(slug ? "{slug}" : /[-_/]?\{slug\}/, slug);
    await this.ws.requests.update(
      requestId,
      {
        status: "active",
        areas: [...new Set([...request.areas, ...(run.assessment?.areas ?? [])])],
        relations: [...request.relations, ...impactRels],
        workstream: request.workstream ?? { branch, worktree: `${p.worktreeDir}/${requestId}` },
      },
      { actor },
    );
    run.materialized = created.map((t) => t.id);
    await this.ws.preflight.save(run);

    // 新しいタスクと関係を保存してから、選んだ置き換えられるタスクをアーカイブする
    for (const id of state.archive) {
      if (state.archived.includes(id)) continue;
      if (tasks.get(id)) await tasks.archive(id);
      state.archived.push(id);
      await this.ws.preflight.save(run);
    }
    state.done = true;
    await this.ws.preflight.save(run);

    this.index.invalidate();
    this.ws.emit({ type: "changed", kind: "task", request: requestId });
    this.ws.emit({ type: "changed", kind: "request", request: requestId });
    return { tasks: created, archived: state.archived, kept: candidates.filter((c) => !state.archive.includes(c.id)) };
  }
}

function clampScore(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** LLM の出力は形が揺れるので、厳密に弾かず正規化する */
export function parseAssessment(text: string): PreflightAssessment {
  let a: Record<string, any>;
  try {
    a = JSON.parse(text);
  } catch (e) {
    throw new Error(`assessment.json が JSON として読めません: ${(e as Error).message}`);
  }
  const verdict = ["go", "clarify", "no_go"].includes(a.verdict) ? a.verdict : "clarify";
  return {
    summary: String(a.summary ?? ""),
    verdict,
    validity: { score: clampScore(a.validity?.score), reasons: strs(a.validity?.reasons) },
    feasibility: { score: clampScore(a.feasibility?.score), reasons: strs(a.feasibility?.reasons) },
    risks: strs(a.risks),
    questions: strs(a.questions),
    areas: strs(a.areas),
    impacts: (Array.isArray(a.impacts) ? a.impacts : [])
      .filter((i: any) => i && typeof i.target === "string" && i.type in RELATION_TYPES)
      .map((i: any) => ({
        target: i.target,
        type: i.type as RelationType,
        reason: String(i.reason ?? ""),
        confidence: Math.max(0, Math.min(1, Number(i.confidence ?? 0.5))),
      })),
  };
}
