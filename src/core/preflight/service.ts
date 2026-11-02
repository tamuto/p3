import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  type PreflightAssessment,
  type PreflightLogEntry,
  type PreflightRun,
  type ProposedTask,
  type Relation,
  type Request,
  type MaterializeResult,
  type AdoptionResult,
  type PreflightInput,
  type ProposedChild,
  type Task,
  type Evidence,
  type FixedAttachment,
  type InputMatch,
  type PreflightPulse,
} from "../../shared/types.ts";
import { normalizeTaskId, REQUEST_ID } from "../../shared/refs.ts";
import { newRequestId, nowIso, withFileLock, writeFileAtomic } from "../store/fsutil.ts";
import { ConflictError, NotFoundError } from "../store/collection.ts";
import type { Workspace } from "../store/workspace.ts";
import { supersedeCandidates } from "../supersede.ts";
import { hierarchyNow, reopenAncestors } from "../requestStatus.ts";
import { archivedRequestIds, inheritFrom, withHierarchyLock } from "../hierarchy.ts";
import { childBody, childrenVersion, draftProblems, parseSplit, splitMarker } from "./split.ts";
import { redact } from "../redact.ts";
import { renderCarryover, selectCarryover } from "./carryover.ts";
import type { PreflightEngine, PreflightJob } from "./engine.ts";
import { LOCAL_INSTRUCTIONS_FILE, LOCAL_OUTPUTS, localInstructions } from "./instructions.ts";
import { renderManuscripts, type Renderer } from "./uiRender.ts";
import { repoTargetProblem } from "../../shared/workTarget.ts";
import { refScope, type ResolvedRef } from "../repoRefs.ts";
import { checkRepoTarget, planWorkstreams, workstreamPatch } from "../workTargets.ts";
import { hideConfigPath } from "../userConfig.ts";
import { extractXlsx, XlsxError } from "./xlsx.ts";
import { applyUiShortage, IMAGE_TYPES, loadUiMaterials, readUiImage, UI_DIR, UiMaterialError } from "./uiMaterials.ts";
import { compareFamily, compareInput, inputHash, normalizeInput, renderRequestSnapshot, runInput, StaleInputError } from "./input.ts";
import { changedLabel } from "../../shared/preflightInput.ts";
import { PREFLIGHT_CANCELLED } from "../../shared/directTask.ts";

/** 始められない理由をそのまま失敗にするエンジン（run の記録とログに残すため） */
const failing = (name: PreflightEngine["name"], message: string): PreflightEngine => ({
  name,
  status: async () => ({ name, ok: false, detail: message }),
  run: async () => Promise.reject(new Error(message)),
});

/** 同じ要望の Preflight が実行中（エンジンを使えないのとは別） */
export class PreflightBusyError extends Error {}

/** タスク案の題が、編集を始めたあとに外で変わった（409 code: rev_conflict。current に今の案） */
export class DraftConflictError extends Error {
  constructor(readonly current: ProposedTask) {
    super(`${current.key} の題が他で変わりました（今の題: ${current.title}）`);
  }
}

/** 子の案の題が他で変わった（画面の編集。409 rev_conflict） */
export class ChildConflictError extends Error {
  constructor(readonly current: ProposedChild) {
    super(`${current.key} の題が他で変わりました（今の題: ${current.title}）`);
  }
}

/** 確認したときから子の案が変わった（採用は何も書いていない。409 drafts_changed） */
export class ChildDraftsChangedError extends Error {
  readonly code = "drafts_changed";
  constructor(runId: string) {
    super(`${runId} の子の案が確認したあとで変わりました。何も作っていません。読み直して確かめてから、もう一度採用してください`);
  }
}

/** pulse の問い合わせの ID の形が違う（400） */
export class PulseInputError extends Error {}

export class PreflightService {
  private active = new Map<string, { run: PreflightRun; abort: AbortController; done: Promise<void> }>();

  /** 最後に分かった既定のエンジン */
  private lastDefault: PreflightEngine["name"];

  /**
   * defaultEngine: 決まった名前か、読むたびに今の既定を返す関数（serve: 個人設定の preflight.engine を Preflight を始めるたびに読む）
   */
  constructor(
    private ws: Workspace,
    private engines: Partial<Record<PreflightEngine["name"], PreflightEngine>>,
    defaultEngine: PreflightEngine["name"] | { load: () => Promise<PreflightEngine["name"]>; initial: PreflightEngine["name"] },
    /** 手元のエージェントの取り込みで画面イメージを描くとき: パスの対応（codex.pathMap）と、テスト用の描画の差し替え */
    private renderOpts: { pathMap: () => Promise<[string, string][]>; render?: Renderer } = { pathMap: async () => [] },
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
    return this.locked(requestId, async () => {
      const fixed = await this.fix(requestId);
      // 既定のエンジンは始めるたびに個人設定から決める。読めなければ、この run を設定のエラーとして失敗にする
      // （古い設定や Mock に落とさない。serve とほかの操作は続ける）
      let engine: PreflightEngine | undefined;
      if (opts.engine) engine = this.engines[opts.engine];
      else {
        try {
          engine = this.engines[await this.currentDefault()];
        } catch (e) {
          const message = `個人設定を読めないので Preflight を始めません（Docker は起動していません）: ${hideConfigPath(e)}`;
          engine = failing(this.lastDefault, message);
        }
      }
      if (!engine) throw new Error(`engine ${opts.engine} は利用できません`);
      // 始めるときの設定に決める（この run の間は個人設定が変わっても使い続ける）
      if (engine.snapshot) {
        const from = engine;
        engine = await from.snapshot!().catch((e: Error) => failing(from.name, e.message));
      }
      const opened = await this.open(fixed, engine.name, opts.actor);
      const abort = new AbortController();
      const done = this.execute(engine, opened, abort.signal);
      this.active.set(opened.run.id, { run: opened.run, abort, done });
      return opened.run;
    });
  }

  /**
   * 手元の対話エージェント（Claude Code など）に評価を頼む準備: 評価対象・参照先・親子・添付・メモ・前回の結果を通常の Preflight と
   * 同じ方法で固定し、指示のファイル（instructions.md）を run のフォルダに書いて、評価を待つ run（engine: local・running）を残して返す。
   * モデル・Codex・Docker は使わない。取り込みは complete、やめるのは cancelLocal（別のプロセスからでもよい）
   */
  async prepare(requestId: string, opts: { actor?: string } = {}): Promise<{ run: PreflightRun; runDir: string; instructions: string; outputs: string[] }> {
    return this.locked(requestId, async () => {
      const opened = await this.open(await this.fix(requestId), "local", opts.actor);
      const { run, runDir } = opened;
      run.local = { before: opened.before };
      await this.extractAttachments(run, runDir);
      const instructions = join(runDir, LOCAL_INSTRUCTIONS_FILE);
      await writeFileAtomic(instructions, localInstructions(this.job(opened)));
      this.log(run, { kind: "info", text: `手元のエージェントの評価を待っています（指示: ${LOCAL_INSTRUCTIONS_FILE}。取り込みは p3 preflight ${requestId} --complete --run ${run.id}）` });
      await this.ws.preflight.save(run);
      this.ws.emit({ type: "changed", kind: "preflight", request: requestId });
      return { run, runDir, instructions, outputs: LOCAL_OUTPUTS.map((o) => join(runDir, o)) };
    });
  }

  /**
   * 手元のエージェントが書いた結果を取り込む。指定した run（engine: local で評価を待っているもの）の成果物だけを確かめ、通常の Preflight と
   * 同じ取り込み（評価・案・分割・根拠・画面資料）で完了にする。成果物に問題があれば何も確定せず LocalResultError（直して同じ run で
   * やり直せる）。取り込み済みなら何もせずに返す（already）
   */
  async complete(requestId: string, runId: string): Promise<{ run: PreflightRun; already: boolean }> {
    return this.locked(requestId, async () => {
      const run = await this.localRun(requestId, runId);
      if (run.status === "completed") return { run, already: true };
      if (run.status !== "running") {
        throw new LocalRunError(`${runId} は${run.error === PREFLIGHT_CANCELLED ? "取り消し済み" : "失敗した run"}です。評価し直すなら p3 preflight ${requestId} --prepare から`);
      }
      const runDir = this.ws.preflight.runDir(requestId, runId);
      const refs = this.ws.refs();
      const problems = await localProblems(this.ws, run, runDir);
      if (problems.length) {
        run.local = { ...run.local!, rejected: (run.local?.rejected ?? 0) + 1 };
        for (const p of problems) this.log(run, { kind: "error", text: `取り込めません: ${p}` });
        await this.ws.preflight.save(run);
        throw new LocalResultError(problems);
      }
      // 画面イメージ: 原稿があるときだけ描画のコンテナを使う。描けなくても評価は残す（取り込みで不足として扱う）
      await renderManuscripts(runDir, { pathMap: await this.renderOpts.pathMap().catch(() => []), log: (e) => this.log(run, e), render: this.renderOpts.render });
      await this.ingest(run, runDir, refs);
      run.status = "completed";
      await this.finish(run, run.local!.before);
      return { run, already: false };
    });
  }

  /** 手元のエージェントの評価を待つ run をやめる（取り込まない。成果物のファイルは残す）。取り消し済みなら何もしない */
  async cancelLocal(requestId: string, runId: string): Promise<{ run: PreflightRun; already: boolean }> {
    return this.locked(requestId, async () => {
      const run = await this.localRun(requestId, runId);
      if (run.status === "completed") throw new LocalRunError(`${runId} は取り込み済みです（取り消せません）`);
      if (run.status === "failed") return { run, already: true };
      run.status = "failed";
      run.error = PREFLIGHT_CANCELLED;
      run.ui = withCurrent({ status: "missing", reason: "評価が終わらなかったので、画面資料を取り込んでいません", targets: [], items: [], problems: [] }, run);
      this.log(run, { kind: "error", text: run.error });
      await this.finish(run, run.local!.before);
      return { run, already: false };
    });
  }

  private async localRun(requestId: string, runId: string): Promise<PreflightRun> {
    if (!/^PF-[\w-]+$/.test(runId)) throw new NotFoundError(runId);
    this.ws.requests.require(requestId);
    const run = await this.ws.preflight.get(requestId, runId);
    if (!run) throw new NotFoundError(`${requestId}/${runId}`);
    if (run.engine !== "local" || !run.local) throw new LocalRunError(`${runId} は手元のエージェントの run ではありません（engine: ${run.engine}）`);
    return run;
  }

  /** 同じ要望の Preflight の開始・準備・取り込み・取消を、プロセスを跨いで1つずつにする */
  private locked<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    if (!REQUEST_ID.test(requestId)) throw new NotFoundError(requestId);
    return withFileLock(join(this.ws.requestsDir, `.preflight-${requestId}.lock`), fn, {
      timeoutMs: 10_000,
      busyMessage: `${requestId} の Preflight を別の操作が変えています。少し待ってからやり直してください`,
    });
  }

  /**
   * 同じ要望の Preflight が動いているか。このプロセスで実行中、手元のエージェントの評価を待っている、ほかのプロセス（serve・CLI）で
   * 実行中（開始から STALE_RUNNING_MS まで。それより古いものは落ちたプロセスのものとして扱う）なら、その理由
   */
  private async busy(requestId: string): Promise<string | undefined> {
    if ([...this.active.values()].some((a) => a.run.requestId === requestId)) return `${requestId} の preflight は実行中です`;
    const last = this.ws.requests.get(requestId)?.lastPreflight;
    if (!last) return undefined;
    const run = await this.ws.preflight.get(requestId, last);
    if (run?.status !== "running") return undefined;
    if (run.engine === "local") {
      return `${requestId} の preflight ${last} は手元のエージェントの評価を待っています（取り込む: p3 preflight ${requestId} --complete --run ${last} / やめる: p3 preflight ${requestId} --cancel --run ${last}）`;
    }
    if (Date.now() - Date.parse(run.startedAt) < STALE_RUNNING_MS) return `${requestId} の preflight ${last} が別のプロセスで実行中です`;
    return undefined;
  }

  /** 評価対象を固定する（ディスクから読み直す）。同じ要望の Preflight が動いていれば PreflightBusyError */
  private async fix(requestId: string) {
    // 評価対象はディスクから読み直して固定する（監視していない外部の編集も取り込む）。この後に変わっても、この run は固定した内容で評価する
    await this.ws.requests.reload(requestId);
    const current = this.ws.requests.require(requestId);
    const text = normalizeInput(current);
    const request: Request = { ...current, ...text };
    // 親子の評価対象も固定する: 子なら親の目的、親なら今の子（分割の採用・子のタスク化の直前に比べる。input.ts の compareFamily）
    const parent = current.parent ? this.ws.requests.get(current.parent) : undefined;
    const kids = hierarchyNow(this.ws).children(requestId);
    const input: PreflightInput = {
      ...text,
      ...(parent ? { parent: { id: parent.id, hash: inputHash(parent) } } : {}),
      children: kids.map((c) => ({ id: c.id, hash: inputHash(c) })),
    };
    const busy = await this.busy(requestId);
    if (busy) throw new PreflightBusyError(busy);
    return { request, input, parent, kids };
  }

  /** run を作る: 前回の結果とメモ・参照先・添付を固定し、要望を評価中にする（エンジンによらず同じ） */
  private async open(fixed: Awaited<ReturnType<PreflightService["fix"]>>, engine: PreflightRun["engine"], actor?: string) {
    const { request, input, parent, kids } = fixed;
    const requestId = request.id;
    const stamp = nowIso().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const id = `PF-${stamp}-${randomBytes(2).toString("hex")}`;
    // 前回の結果とその後のメモ。開始の時点で選んで固定する（実行中に足されたメモは次回に回る）
    const carry = await selectCarryover(this.ws, requestId);
    const carryover = renderCarryover(carry);
    // 読む参照先は始めるときに決める（読めないものは理由を記録に残す。このマシンのパスは残さない）
    const refs = this.ws.refs();
    const run: PreflightRun = {
      id,
      requestId,
      engine,
      status: "running",
      startedAt: nowIso(),
      startedBy: actor,
      previous: carry.previous?.id,
      notes: carry.notes.length ? carry.notes.map((n) => n.id) : undefined,
      log: [],
      drafts: [],
      scope: refs.map(refScope),
      ui: { status: "generating", targets: [], items: [], problems: [] },
      input,
    };
    const runDir = this.ws.preflight.runDir(requestId, id);
    // 添付は始める時点のものを run の中にコピーして固定する。途中で変わったら始めない（原本は残るので、そのまま再試行できる）
    try {
      const fixedAttachments = await this.ws.attachments.snapshot(requestId, runDir);
      if (fixedAttachments.length) run.attachments = fixedAttachments;
    } catch (e) {
      await rm(runDir, { recursive: true, force: true });
      throw e;
    }
    await this.ws.preflight.save(run);
    if (carryover) await writeFileAtomic(join(runDir, "carryover.md"), carryover);
    const carried = carryover ? { text: carryover, previous: carry.previous, notes: carry.notes } : undefined;
    if (carry.previous) this.log(run, { kind: "info", text: `前回 ${carry.previous.id} の結果を引き継ぎます` });
    if (carry.previous && carry.requestChange) {
      const m = carry.requestChange.match;
      this.log(run, {
        kind: "info",
        text: m.status === "changed"
          ? `前回の評価のあとで要望の${changedLabel(m.changed)}が変わりました。今の内容を基準に評価し、変わったことを資料として渡します`
          : `前回が何を評価したか確かめられません（${m.reason ?? "不明"}）。今の内容を基準に評価します`,
      });
    }
    else if (carry.previousSkipped) this.log(run, { kind: "info", text: `前回の結果は引き継ぎません（${carry.previousSkipped}）` });
    if (carry.notes.length) this.log(run, { kind: "info", text: `メモ ${carry.notes.length} 件を渡します: ${carry.notes.map((n) => n.id).join(", ")}` });
    if (run.attachments) this.log(run, { kind: "info", text: `添付 ${run.attachments.length} 件を固定して渡します: ${run.attachments.map((a) => `${a.id}（${a.name}）`).join(", ")}` });
    for (const n of carry.invalidNotes) this.log(run, { kind: "error", text: `読めないメモを除きました: ${n.file}（${n.error}）` });
    for (const s of run.scope ?? []) if (s.status !== "ok") this.log(run, { kind: "info", text: `見ていない参照先: ${s.name}（${s.reason}）` });
    if (refs.length && !refs.some((r) => r.status === "ok")) {
      this.log(run, { kind: "info", text: "読める参照先がありません。要望と P3 のデータだけで評価します（コードは確かめられません）" });
    }
    // 要望のスナップショットと文脈をファイルとして残す（後から「何を根拠に判断したか」を辿れる）
    await writeFileAtomic(join(runDir, "request.md"), renderRequestSnapshot(request.id, input));
    // ステータスを動かすのはタスク化する前の要望だけ。進行中・完了の要望で再評価しても状態は変えない
    const before = request.status;
    await this.ws.requests.update(requestId, isEarly(before) ? { status: "preflight", lastPreflight: id } : { lastPreflight: id }, { actor });
    this.ws.emit({ type: "changed", kind: "request", request: requestId });
    const family = {
      ...(parent ? { parent: { id: parent.id, title: parent.title, body: parent.body } } : {}),
      ...(kids.length ? { children: kids.map((c) => ({ id: c.id, title: c.title, status: c.status })) } : {}),
    };
    return { run, request, runDir, carried, refs, family, before };
  }

  /** エンジンに渡す仕事（始めたときに固定したもの） */
  private job(o: Awaited<ReturnType<PreflightService["open"]>>): PreflightJob {
    return {
      project: this.ws.project,
      // 始めたときに固定した要望（実行中に本文が変わっても、request.md・run.input と同じものを渡す）
      request: o.request,
      refs: o.refs,
      dataDir: this.ws.dataDir,
      runDir: o.runDir,
      carryover: o.carried,
      attachments: o.run.attachments ?? [],
      ...o.family,
    };
  }

  /** 実行中の run の完了を待つ（CLI 用）。完了後の run を返す */
  async wait(requestId: string, runId: string): Promise<PreflightRun | undefined> {
    await this.active.get(runId)?.done;
    return this.ws.preflight.get(requestId, runId);
  }

  cancel(runId: string) {
    this.active.get(runId)?.abort.abort();
  }

  /** 実行中の run の数 */
  running(): number {
    return this.active.size;
  }

  /** 実行中の run が全部終わるまで待つ（cancel: 先に全部を取り消す）。serve を止める・登録から外れたプロジェクトを閉じる前に */
  async settle(opts: { cancel?: boolean } = {}): Promise<void> {
    const jobs = [...this.active.values()];
    if (opts.cancel) for (const j of jobs) j.abort.abort();
    await Promise.allSettled(jobs.map((j) => j.done));
  }

  private log(run: PreflightRun, e: Omit<PreflightLogEntry, "at">) {
    // トークンらしいもの（Codex のエラーが一部を見せるキーなど）は残さない
    const entry = { ...e, text: redact(e.text), at: nowIso() };
    run.log.push(entry);
    this.ws.emit({ type: "preflight-log", runId: run.id, entry });
  }

  /** 共有の記録に出すパス: 参照先の中なら <参照先>:<パス>、データのフォルダの中なら data:<パス>（このマシンのパスは出さない） */
  private shownPath(p: string, refs: ResolvedRef[]): string {
    const inside = (dir: string) => {
      const rel = relative(dir, p);
      return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
    };
    for (const r of refs) {
      const rel = r.local ? inside(r.local) : undefined;
      if (rel !== undefined) return `${r.name}:${rel}`;
    }
    const data = inside(this.ws.dataDir);
    if (data !== undefined) return `data:${data}`;
    return p.startsWith("/workspace") ? p : "（参照先の外）";
  }

  private async execute(engine: PreflightEngine, opened: Awaited<ReturnType<PreflightService["open"]>>, signal: AbortSignal) {
    const { run, runDir, refs } = opened;
    try {
      await this.extractAttachments(run, runDir);
      const outcome = await engine.run(this.job(opened), (e) => this.log(run, e), signal);
      // 書いてよい範囲の外が変更されていないか確かめる
      const stray = outcome.changed.filter((p) => !p.startsWith(`${runDir}/`));
      for (const p of stray) this.log(run, { kind: "error", text: `想定外の変更: ${this.shownPath(p, refs)}（確認して必要なら元に戻してください）` });
      await this.ingest(run, runDir, refs);
      run.status = "completed";
    } catch (e) {
      run.status = "failed";
      run.ui = withCurrent({ status: "missing", reason: "評価が終わらなかったので、画面資料を取り込んでいません", targets: [], items: [], problems: [] }, run);
      // 取消はエンジンによらず同じ言い方で残す（失敗とは分けて扱う。shared/directTask.ts）
      run.error = signal.aborted ? PREFLIGHT_CANCELLED : redact((e as Error).message);
      this.log(run, { kind: "error", text: run.error });
    } finally {
      await this.finish(run, opened.before);
    }
  }

  /** run のフォルダの成果物（評価・案・子の案・画面資料）を取り込む。評価が読めなければ例外 */
  private async ingest(run: PreflightRun, runDir: string, refs: ResolvedRef[]) {
    run.assessment = parseAssessment(await readFile(join(runDir, "assessment.json"), "utf8"), refs);
    run.drafts = await this.ws.preflight.loadDrafts(run.requestId, run.id);
    // 子の案（分割の run）: 確かめて、問題があれば残す（採用しない）
    const children = await this.ws.preflight.loadChildren(run.requestId, run.id);
    if (children) {
      run.children = children;
      const problems = draftProblems(run, this.ws.tasksOf(run.requestId).list().map((t) => t.id));
      if (problems.length) run.draftProblems = problems;
      for (const p of problems) this.log(run, { kind: "error", text: `子の案の問題: ${p}` });
    }
    // 画面資料: 確かめて取り込む。不正なものは除いて理由を残す（評価は消さない）。必要な画面イメージが足りなければ go を clarify に
    run.ui = applyUiShortage(run.assessment, await loadUiMaterials(runDir, run.id, [...run.drafts, ...(run.children ?? [])].map((d) => d.key)));
    for (const p of run.ui.problems) this.log(run, { kind: "error", text: `画面資料を取り込めません: ${p}` });
    if (run.ui.status === "missing") this.log(run, { kind: "info", text: `画面資料が足りません: ${run.ui.reason}` });
    run.ui = withCurrent(run.ui, run);
    if (run.ui.verdictAdjusted) this.log(run, { kind: "info", text: "必要な画面イメージが足りないので、判定を go から clarify にしました" });
  }

  /** run を終える: 記録を保存し、評価中にした要望を評価済み（失敗なら元）へ戻す */
  private async finish(run: PreflightRun, before: Request["status"]) {
    run.finishedAt = nowIso();
    await this.ws.preflight.save(run);
    // 評価中にした要望だけ、終わったら評価済み（失敗なら元）へ戻す。実行中に人や AI が変えたステータス
    // （進行中に戻した・完了済にしたなど）や、評価中にしていない要望（進行中・対応済など）は上書きしない
    const status = statusAfter(before, run.status === "completed");
    if (this.ws.requests.get(run.requestId)?.status === "preflight" && status !== "preflight") {
      await this.ws.requests.update(run.requestId, { status });
    }
    // 保存が終わってから実行中の一覧から外す（先に外すと wait() が保存前のファイルを読む）
    this.active.delete(run.id);
    this.ws.emit({ type: "preflight-status", runId: run.id, status: run.status });
    this.ws.emit({ type: "changed", kind: "request", request: run.requestId });
  }

  /**
   * 最新の Preflight（lastPreflight）と、指定した run の今の状態。要望と run.json をディスクから読むだけで、読み込んだ内容
   * （キャッシュ）・ファイル・rev は変えない。監視が届かなくても、外（CLI など）で始めた run とその進み・終わりを画面が見つけるため。
   * ID の形が違えば使い方の誤り（パスは受け取らない）
   */
  async pulse(requestId: string, runId?: string): Promise<PreflightPulse> {
    if (!REQUEST_ID.test(requestId)) throw new PulseInputError(`要望 ID の形ではありません: ${requestId}`);
    if (runId !== undefined && !/^PF-[\w-]+$/.test(runId)) throw new PulseInputError(`run の ID の形ではありません: ${runId}`);
    const run = runId ? await this.ws.preflight.pulse(requestId, runId) : undefined;
    const read = await this.ws.requests.peek(requestId);
    if (!("item" in read)) return { requestId, state: "missing" in read ? "gone" : "broken", latest: null, ...(run ? { run } : {}) };
    const last = read.item.lastPreflight;
    const latest = last ? (last === runId ? run! : await this.ws.preflight.pulse(requestId, last)) : null;
    return { requestId, state: "ok", latest, ...(run ? { run } : {}) };
  }

  /**
   * 画面資料の画像（要望 / run / 資料 ID で決める。パスは受け取らない）。取り込んだときと同じ確かめ方をもう一度してから返す。
   * 原稿（HTML）は返さない
   */
  async uiImage(requestId: string, runId: string, materialId: string): Promise<{ data: Buffer; type: string; item: NonNullable<PreflightRun["ui"]>["items"][number] }> {
    if (!/^PF-[\w-]+$/.test(runId)) throw new NotFoundError(runId);
    this.ws.requests.require(requestId);
    const run = await this.get(requestId, runId);
    const item = run?.ui?.items.find((x) => x.id === materialId);
    if (!run || !item) throw new NotFoundError(`${requestId}/${runId}/${materialId}`);
    try {
      const { data, info } = await readUiImage(join(this.ws.preflight.runDir(requestId, runId), UI_DIR), item.file);
      return { data, type: IMAGE_TYPES[info.format], item };
    } catch (e) {
      if (e instanceof UiMaterialError) throw new NotFoundError(`${materialId}（${e.message}）`);
      throw e;
    }
  }

  /** 要望の添付を足す（CLI と API で同じ確かめ方） */
  async addAttachment(requestId: string, input: { data: Buffer; name: string; description?: string; source?: string }, actor?: string) {
    this.ws.requests.require(requestId);
    const a = await this.ws.attachments.add(requestId, input, actor);
    this.ws.emit({ type: "changed", kind: "attachment", request: requestId });
    return a;
  }

  async removeAttachment(requestId: string, id: string) {
    this.ws.requests.require(requestId);
    await this.ws.attachments.remove(requestId, id);
    this.ws.emit({ type: "changed", kind: "attachment", request: requestId });
  }

  /** run に固定した添付の原本（その run の資料。後で添付を消しても変わらない） */
  async fixedAttachment(requestId: string, runId: string, id: string): Promise<{ meta: FixedAttachment; data: Buffer }> {
    if (!/^PF-[\w-]+$/.test(runId)) throw new NotFoundError(runId);
    this.ws.requests.require(requestId);
    const run = await this.get(requestId, runId);
    const meta = run?.attachments?.find((a) => a.id === id);
    if (!meta) throw new NotFoundError(`${requestId}/${runId}/${id}`);
    const file = join(this.ws.preflight.runDir(requestId, runId), meta.path);
    const st = await lstat(file).catch(() => undefined);
    const data = st?.isFile() ? await readFile(file) : undefined;
    if (!data || data.length !== meta.bytes || createHash("sha256").update(data).digest("hex") !== meta.sha256) {
      throw new NotFoundError(`${id}（run に固定した原本が無いか、変わっています）`);
    }
    return { meta, data };
  }

  /** 固定した xlsx から、セルの文字と標準の埋め込み画像を取り出して run の中に置く（読めなくても評価は続ける） */
  private async extractAttachments(run: PreflightRun, runDir: string) {
    const xlsx = (run.attachments ?? []).filter((a) => a.format === "xlsx" && !a.extract);
    for (const a of xlsx) {
      try {
        const x = extractXlsx(await readFile(join(runDir, a.path)), `${a.name}（${a.id}）`);
        const text = `attachments/${a.id}.md`;
        await writeFileAtomic(join(runDir, text), x.text);
        const images = [];
        for (const [i, img] of x.images.entries()) {
          const file = `spec/${a.id}-${i + 1}.${img.format === "png" ? "png" : "jpg"}`;
          await mkdir(join(runDir, UI_DIR, "spec"), { recursive: true });
          await writeFile(join(runDir, UI_DIR, file), img.data);
          images.push({ id: `${a.id}-${i + 1}`, file, sheet: img.sheet, anchor: img.anchor, format: img.format, width: img.width, height: img.height, bytes: img.data.length });
        }
        a.extract = { text, sheets: x.sheets, cells: x.cells, unknownCells: x.unknownCells, images, truncated: x.truncated, unsupported: x.unsupported };
        this.log(run, {
          kind: "info",
          text: `${a.name}: シート ${x.sheets}・セル ${x.cells}・画像 ${images.length} を取り出しました${x.truncated.length ? `（打ち切り ${x.truncated.length}）` : ""}${x.unsupported.length ? `（扱っていないもの ${x.unsupported.length}）` : ""}`,
        });
      } catch (e) {
        const error = e instanceof XlsxError ? e.message : `読めません: ${(e as Error).message}`;
        a.extract = { sheets: 0, cells: 0, unknownCells: 0, images: [], truncated: [], unsupported: [], error };
        this.log(run, { kind: "error", text: `${a.name} の中身を取り出せません（未読として渡します）: ${error}` });
      }
    }
    if (xlsx.length) await this.ws.preflight.save(run);
  }

  /** run に固定した xlsx から取り出した内容（Markdown） */
  async fixedExtract(requestId: string, runId: string, id: string): Promise<string> {
    const { meta } = await this.fixedAttachment(requestId, runId, id);
    const rel = meta.extract?.text;
    if (!rel || rel !== `attachments/${meta.id}.md`) throw new NotFoundError(`${id} の取り出した内容`);
    const file = join(this.ws.preflight.runDir(requestId, runId), rel);
    const st = await lstat(file).catch(() => undefined);
    if (!st?.isFile()) throw new NotFoundError(`${id} の取り出した内容`);
    return readFile(file, "utf8");
  }

  /**
   * タスク案を直す（案のファイルを読み直してから書く）。opts.expectedTitle: 編集を始めたときの題。今の題と違えば（外で
   * 変わった）DraftConflictError で書かない。画面から題を変えるときは必ず渡す。CLI・内部の呼び出しは渡さなくてよい
   * （その場合は確かめない）。期待値はファイルに書かない。読んでから書くまでの間に外のプロセスが書くことまでは防げない
   */
  async updateDraft(requestId: string, runId: string, key: string, patch: Partial<ProposedTask>, opts: { expectedTitle?: string } = {}) {
    const run = await this.ws.preflight.get(requestId, runId);
    const draft = run?.drafts.find((d) => d.key === key);
    if (!run || !draft) throw new Error(`${runId}/${key} not found`);
    if (opts.expectedTitle !== undefined && draft.title !== opts.expectedTitle) throw new DraftConflictError(draft);
    // 作業先は作業先にできる参照先だけ（変える前に断る）
    if ("repo" in patch) checkRepoTarget(this.ws, patch.repo);
    const next = { ...draft, ...patch, key };
    await this.ws.preflight.saveDraft(requestId, runId, next);
    return next;
  }

  /**
   * run の評価対象と今の要望が同じか。fresh: 要望をディスクから読み直してから比べる（タスク化の直前など）。
   * 既定はメモリ上の要望（serve は変更を監視して取り込む）
   */
  async inputMatch(requestId: string, run: PreflightRun, opts: { fresh?: boolean } = {}): Promise<InputMatch> {
    // 親子も比べるので、読み直すときは要望の一覧ごと
    if (opts.fresh) await this.ws.requests.load();
    const request = this.ws.requests.require(requestId);
    const base = compareInput(await runInput(run, this.ws.preflight.runDir(requestId, run.id)), request);
    if (base.status === "unknown") return base;
    const parent = request.parent ? this.ws.requests.get(request.parent) : undefined;
    const family = compareFamily(run.input, run.id, request, parent, hierarchyNow(this.ws).children(requestId));
    const changed = [...(base.changed ?? []), ...family];
    return changed.length ? { status: "changed", changed } : { status: "same" };
  }

  /** run に今の要望との比較（inputMatch）を添える（画面・CLI・API の表示用。run.json には書かない） */
  async withInputMatch(requestId: string, run: PreflightRun): Promise<PreflightRun & { inputMatch: InputMatch }> {
    return { ...run, inputMatch: await this.inputMatch(requestId, run) };
  }

  /** タスク化の前に見せるもの: 採用する案と、置き換えられる既存タスク、評価対象が今の要望と同じか（ファイルは変えない） */
  async previewMaterialize(requestId: string, runId: string) {
    const run = await this.ws.preflight.get(requestId, runId);
    if (!run) throw new NotFoundError(runId);
    const inputMatch = await this.inputMatch(requestId, run, { fresh: true });
    if (run.children) {
      // 分割の run: 採用する子の案・その版・問題・途中経過（親は残す・子だけ作る・子の Preflight はまだ）
      const included = run.children.filter((c) => c.include);
      return {
        mode: "children" as const,
        include: included.map((c) => c.key),
        candidates: [],
        materialized: [],
        inputMatch,
        version: childrenVersion(run.children),
        problems: draftProblems(run, this.ws.tasksOf(requestId).list().map((t) => t.id)),
        adoption: run.adoption ?? null,
      };
    }
    return {
      mode: "tasks" as const,
      include: run.drafts.filter((d) => d.include).map((d) => d.key),
      candidates: supersedeCandidates(this.ws, run),
      materialized: run.materialized ?? [],
      inputMatch,
    };
  }

  /** 子の案を直す（題・本文・採否。案のファイルを読み直してから書く）。採用を始めた案は変えない */
  async updateChild(requestId: string, runId: string, key: string, patch: Partial<Pick<ProposedChild, "title" | "description" | "include">>, opts: { expectedTitle?: string } = {}) {
    const run = await this.ws.preflight.get(requestId, runId);
    const child = run?.children?.find((c) => c.key === key);
    if (!run || !child) throw new NotFoundError(`${runId}/${key}`);
    if (run.adoption) throw new Error(`${runId} は子の採用を始めています（案は変えられません）`);
    if (opts.expectedTitle !== undefined && child.title !== opts.expectedTitle) throw new ChildConflictError(child);
    const next = { ...child, ...patch, key };
    await this.ws.preflight.saveChild(requestId, runId, next);
    return next;
  }

  /**
   * 子の案の採用: 選んだ子の案ごとに、親の下に下書きの子の要望を作る（子のタスク化・Preflight は始めない。親のタスク・履歴は変えない）。
   *   - 親ごとに関係のロック（hierarchy.ts）の中で行い、直前に要望をディスクから読み直す。評価対象（題・本文）・始めたときの子の集合が
   *     違えば StaleInputError（別の run から採用した・子を足した・外した）、version（確認のときの案の版）が違えば ChildDraftsChangedError。
   *     どちらも何も書かない
   *   - 書く前に子の ID を予約して run.json の adoption に残し、子は splitFrom（<run>/<案>）を付けて決めた ID で作る。途中で落ちても、
   *     同じ採用をもう一度頼めば予約した ID を使い、splitFrom が一致する子は作り直さずに続ける。予約した ID に別のもの（splitFrom が
   *     違う・読めない）があれば上書きせず、その案を競合として止める
   *   - 結果は作った・失敗・未実行。全部を取り消すために作った子を消さない
   */
  async adopt(requestId: string, runId: string, actor = "preflight", opts: { version?: string } = {}): Promise<AdoptionResult> {
    return withHierarchyLock(this.ws, async () => {
      const run = await this.ws.preflight.get(requestId, runId);
      if (!run || run.status !== "completed") throw new Error("完了した preflight のみ採用できます");
      if (!run.children) throw new Error(`${runId} は子の案の run ではありません（タスク案は p3 accept でタスク化します）`);
      if (run.adoption?.done) throw new Error(`既に採用済みです: ${Object.values(run.adoption.reserved).join(", ")}`);
      const problems = draftProblems(run, this.ws.tasksOf(requestId).list().map((t) => t.id));
      if (problems.length) throw new Error(`子の案に問題があるので採用しません（直すか再評価してください）: ${problems.join(" / ")}`);
      const match = await this.inputMatch(requestId, run, { fresh: true });
      if (match.status !== "same") throw new StaleInputError(requestId, runId, match);
      const resuming = !!run.adoption;
      if (!resuming && opts.version !== undefined && opts.version !== childrenVersion(run.children)) throw new ChildDraftsChangedError(runId);
      // 新しい採用は案のキーの数の順（C1, C2, C10）に作り、その順で親の表示順に足す。キーの順は実行の順を表さない
      const keys = run.adoption?.keys ?? run.children.filter((c) => c.include).map((c) => c.key).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!keys.length) throw new Error("採用した子の案がありません");

      // ID の予約（書く前に run.json に残す）
      const state = run.adoption ?? { reserved: {}, created: [], keys, done: false };
      const taken = new Set([...this.ws.requests.list().map((r) => r.id), ...this.ws.requests.errors.keys(), ...(await archivedRequestIds(this.ws)), ...Object.values(state.reserved)]);
      for (const k of keys) {
        if (state.reserved[k]) continue;
        let id = newRequestId();
        while (taken.has(id)) id = newRequestId();
        taken.add(id);
        state.reserved[k] = id;
      }
      run.adoption = state;
      await this.ws.preflight.save(run);

      const parent = this.ws.requests.require(requestId);
      const result: AdoptionResult = { created: [], failed: [], pending: [] };
      for (const [i, key] of keys.entries()) {
        const id = state.reserved[key];
        const marker = splitMarker(runId, key);
        try {
          if (!state.created.includes(key)) {
            const c = run.children.find((x) => x.key === key);
            if (!c) throw new Error(`子の案 ${key} がありません`);
            const there = await this.ws.requests.peek(id);
            if ("item" in there) {
              // 作った直後に落ちた: 同じ採用で作ったものなら使う（上書きしない）
              if (there.item.splitFrom !== marker || there.item.parent !== requestId) {
                result.failed.push({ key, error: `予約した ${id} に別の要望があります（上書きしません）`, code: "conflict" });
                result.pending = keys.slice(i + 1);
                break;
              }
              await this.ws.requests.reload(id);
            } else if ("error" in there) {
              result.failed.push({ key, error: `予約した ${id} のファイルが読めません（上書きしません）: ${there.error}`, code: "conflict" });
              result.pending = keys.slice(i + 1);
              break;
            } else {
              const input = inheritFrom(parent, { title: c.title, body: childBody(parent, c, runId, state.reserved), status: "draft", areas: [], splitFrom: marker });
              const made = await this.ws.requests.createAt(id, input, actor);
              if (!made) throw new Error(`${id} を作れませんでした（既にあります）`);
            }
            // 作ったことを残す前に親の表示順に足す（落ちてやり直しても、足してあれば重ねない）
            await this.appendChildOrder(requestId, id, actor);
            state.created.push(key);
            await this.ws.preflight.save(run);
            this.ws.emit({ type: "changed", kind: "request", request: id });
          }
          result.created.push({ key, id });
        } catch (e) {
          result.failed.push({ key, error: (e as Error).message, code: "error" });
          result.pending = keys.slice(i + 1);
          break;
        }
      }
      if (!result.failed.length) {
        // 親は開始前なら進行中にする（親のタスク・本文は変えない）
        if (["draft", "preflight", "reviewed"].includes(parent.status)) await this.ws.requests.update(requestId, { status: "active" }, { actor });
        state.done = true;
        await this.ws.preflight.save(run);
        const up = await reopenAncestors(this.ws, requestId, actor);
        for (const a of up.reopened) this.ws.emit({ type: "changed", kind: "request", request: a });
        if (up.reopened.length) result.reopenedAncestors = up.reopened;
      }
      this.ws.emit({ type: "changed", kind: "request", request: requestId });
      return result;
    });
  }

  /**
   * 採用で作った子を親の表示順（childOrder）の末尾に足す。関係のロックの中で呼ぶ。今の並び（保存した順と、そこに無い子の作成順）を
   * そのまま前に残すので、既存の兄弟・人が保存した順は変わらない。既に並んでいれば何もしない
   */
  private async appendChildOrder(parentId: string, childId: string, actor: string) {
    await this.ws.requests.reload(parentId);
    const parent = this.ws.requests.require(parentId);
    if (parent.childOrder?.includes(childId)) return;
    const now = hierarchyNow(this.ws).children(parentId).map((c) => c.id).filter((id) => id !== childId);
    await this.ws.requests.update(parentId, { childOrder: [...now, childId] }, { actor });
  }

  /**
   * タスク化: 採用されたタスク案を、要望のフォルダの tasks/T00x.md として書き出し、関係を張る。
   *   - 同じ run 内の dependsOn → depends_on（要望の中なので相対参照 T00x）
   *   - 案が持つ既存項目への関係 → 存在するものだけ（origin: preflight）。置き換え（supersedes）もここで各タスクに残る
   *   - 案の supersedes → 同じ要望の今あるタスクへの supersedes（置き換え）
   *   - archive: 置き換えられるタスク（previewMaterialize の候補）のうちアーカイブするもの。既定はどれも残す。
   *     確定の時点で候補を読み直し、候補でない・rev が変わったものがあれば何も変えずに失敗する
   *
   * 古いタスクを先に外さないよう、新しいタスクと関係を保存してからアーカイブする。途中経過は run.json の
   * materialization に残し、途中で失敗したら同じ呼び出しでやり直せる（作った案は作り直さず、アーカイブも重ねない）。
   *
   * 評価対象（タイトル・本文）が今の要望と違う・確かめられない run からはタスク化しない（StaleInputError。やり直しも同じ）。
   * 直前に要望をディスクから読み直して比べ、断るときは何も書かない
   */
  async materialize(
    requestId: string,
    runId: string,
    actor = "preflight",
    opts: { archive?: { id: string; rev?: number }[] } = {},
  ): Promise<MaterializeResult> {
    const run = await this.ws.preflight.get(requestId, runId);
    if (!run || run.status !== "completed") throw new Error("完了した preflight のみタスク化できます");
    if (run.children) throw new Error(`${runId} は子の要望の案の run です（タスクではなく子を作ります。p3 accept で採用します）`);
    const resuming = run.materialization && !run.materialization.done;
    if (!resuming && run.materialized?.length) throw new Error(`既にタスク化済みです: ${run.materialized.join(", ")}`);
    const match = await this.inputMatch(requestId, run, { fresh: true });
    if (match.status !== "same") throw new StaleInputError(requestId, runId, match);
    const request = this.ws.requests.require(requestId);
    const tasks = this.ws.tasksOf(requestId);
    const drafts = resuming ? run.drafts.filter((d) => d.key in run.materialization!.created || d.include) : run.drafts.filter((d) => d.include);
    if (!drafts.length) throw new Error("採用したタスク案がありません");

    // 作業先: 手で直した案も、変える前に確かめる。割り当てるブランチもここで決めて run に残す（やり直しでも同じ）
    for (const d of drafts) checkRepoTarget(this.ws, d.repo);
    const draftRepo = (d: ProposedTask) => d.repo ?? null;
    const plan =
      resuming && run.materialization!.workstreams
        ? run.materialization!.workstreams
        : planWorkstreams(
            this.ws,
            requestId,
            drafts.map(draftRepo).filter((r): r is string => !!r),
          );

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
      run.materialization = { created: {}, archive: chosen, archived: [], done: false, workstreams: plan };
      await this.ws.preflight.save(run);
    }
    const state = run.materialization!;

    const keyToId = new Map<string, string>();
    const created: Task[] = [];
    // 置き換えは、同じ要望に今あるタスクだけ（Codex が書いた T3 / 3 も T003 にそろえる）
    const supersedes = (d: ProposedTask): Relation[] =>
      [...new Set(d.supersedes.map((x) => normalizeTaskId(x) ?? x))]
        .filter((id) => tasks.get(id))
        .map((target) => ({ type: "supersedes" as const, target, origin: "preflight" as const }));

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
            repo: draftRepo(d),
            labels: [],
            areas: d.areas,
            outputs: [],
            relations: supersedes(d),
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

    await this.ws.requests.update(
      requestId,
      {
        status: "active",
        areas: [...new Set([...request.areas, ...(run.assessment?.areas ?? [])])],
        // 採用した案の作業先の分だけブランチを割り当てる（既にあるものは変えない。作業先なしは割り当てない）
        ...workstreamPatch(this.ws, requestId, plan),
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

    this.ws.emit({ type: "changed", kind: "task", request: requestId });
    this.ws.emit({ type: "changed", kind: "request", request: requestId });
    // 子の要望をタスク化した: 対応済の祖先を進行中に戻す（完了済の祖先は警告）
    const up = await reopenAncestors(this.ws, requestId, actor);
    for (const a of up.reopened) this.ws.emit({ type: "changed", kind: "request", request: a });
    return {
      tasks: created,
      archived: state.archived,
      kept: candidates.filter((c) => !state.archive.includes(c.id)),
      ...(up.reopened.length ? { reopenedAncestors: up.reopened } : {}),
      ...(up.warnings.length ? { warnings: up.warnings } : {}),
    };
  }
}

/** ほかのプロセスで実行中の run を、落ちたものとみなすまでの時間（Codex の1ターンの上限 30 分に余裕を足す） */
const STALE_RUNNING_MS = 35 * 60_000;

/** ステータスを動かすのはタスク化する前の要望だけ */
const isEarly = (s: Request["status"]) => s === "draft" || s === "preflight" || s === "reviewed";

/** Preflight を終えたときの要望のステータス（評価中にしたものだけ。成功なら評価済み、失敗なら元） */
function statusAfter(before: Request["status"], ok: boolean): Request["status"] {
  return isEarly(before) ? (ok ? "reviewed" : before === "reviewed" ? "reviewed" : "draft") : before;
}

/** 手元のエージェントの run ではない・もう待っていない（使い方の誤り） */
export class LocalRunError extends Error {}

/** 手元のエージェントの成果物を取り込めない（何も確定していない。直して同じ run でやり直せる） */
export class LocalResultError extends Error {
  constructor(readonly problems: string[]) {
    super(`成果物を取り込めません（何も確定していません。直してから同じ run でもう一度 --complete）:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

/**
 * 手元のエージェントの成果物を取り込む前に確かめる（問題の一覧。無ければ空）: 成果物がシンボリックリンクでない（run の外を読ませない）、
 * 評価が JSON として読める、タスク案と子の案の形（キー・題・依存・作業先・混在）
 */
async function localProblems(ws: Workspace, run: PreflightRun, runDir: string): Promise<string[]> {
  const problems: string[] = [];
  const link = async (rel: string) => (await lstat(join(runDir, rel)).catch(() => undefined))?.isSymbolicLink();
  for (const rel of ["assessment.json", "drafts", "children", UI_DIR, `${UI_DIR}/src`, `${UI_DIR}/index.json`]) {
    if (await link(rel)) problems.push(`${rel} がシンボリックリンクです（run のフォルダの中にファイルとして書いてください）`);
  }
  for (const dir of ["drafts", "children"]) {
    if (await link(dir)) continue;
    const files = await readdir(join(runDir, dir)).catch(() => [] as string[]);
    for (const f of files) if (await link(`${dir}/${f}`)) problems.push(`${dir}/${f} がシンボリックリンクです`);
  }
  if (problems.length) return problems;
  const text = await readFile(join(runDir, "assessment.json"), "utf8").catch(() => undefined);
  if (text === undefined) problems.push("assessment.json がありません");
  else {
    try {
      parseAssessment(text);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const drafts = await ws.preflight.loadDrafts(run.requestId, run.id);
  const children = await ws.preflight.loadChildren(run.requestId, run.id);
  if (children) problems.push(...draftProblems({ drafts, children }, ws.tasksOf(run.requestId).list().map((t) => t.id)));
  const keys = drafts.map((d) => d.key);
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i))) problems.push(`タスク案のキーが重なっています: ${k}`);
  for (const d of drafts) {
    if (!/^D\d+$/.test(d.key)) problems.push(`タスク案のキーの形が違います: ${d.key}（D1, D2, ...）`);
    if (!d.title.trim()) problems.push(`${d.key}: 題がありません`);
    for (const dep of d.dependsOn) {
      if (dep === d.key) problems.push(`${d.key}: 自分に依存しています`);
      else if (!keys.includes(dep)) problems.push(`${d.key}: 依存先の ${dep} というタスク案はありません`);
    }
    const repo = repoTargetProblem(d.repo, ws.project);
    if (repo) problems.push(`${d.key}: ${repo}`);
  }
  return problems;
}

/** 固定した添付の画像を、現状（添付）の画面資料として足す（対象のタスク案は無し） */
function withCurrent(ui: NonNullable<PreflightRun["ui"]>, run: PreflightRun): NonNullable<PreflightRun["ui"]> {
  const current = (run.attachments ?? [])
    .filter((a) => a.format !== "xlsx" && a.path.startsWith(`${UI_DIR}/`))
    .map((a) => ({
      id: a.id,
      kind: "current" as const,
      file: a.path.slice(UI_DIR.length + 1),
      format: a.format as "png" | "jpeg",
      width: a.width ?? 0,
      height: a.height ?? 0,
      bytes: a.bytes,
      title: a.description ?? a.name,
      source: `添付 ${a.name}${a.source ? `（${a.source}）` : ""}`,
      drafts: [],
      assumptions: [],
      run: run.id,
    }));
  const spec = (run.attachments ?? []).flatMap((a) =>
    (a.extract?.images ?? []).map((img) => ({
      id: img.id,
      kind: "spec" as const,
      file: img.file,
      format: img.format,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
      title: `${a.name} のシート「${img.sheet}」${img.anchor} の画像`,
      source: `添付 ${a.name} / シート「${img.sheet}」${img.anchor}`,
      drafts: [],
      assumptions: [],
      run: run.id,
    })),
  );
  const added = [...current, ...spec];
  return added.length ? { ...ui, items: [...ui.items.filter((m) => m.kind === "proposal"), ...added] } : ui;
}

function clampScore(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** LLM の出力は形が揺れるので、厳密に弾かず正規化する */
/**
 * evidence を取り込む。verified は、読めた参照先・その中の相対パス・あるファイルを指すときだけ認める
 * （refs を渡したとき。ほかは assumed に直して理由を note に書く）。項目は消さない
 */
export function parseEvidence(v: unknown, refs?: readonly ResolvedRef[]): Evidence[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return v
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => {
      const ev: Evidence = { claim: text(e.claim) ?? "（判断の説明がありません）", kind: e.kind === "verified" ? "verified" : "assumed" };
      for (const k of ["repo", "file", "location", "commit"] as const) if (text(e[k])) ev[k] = text(e[k]);
      if (ev.kind !== "verified" || !refs) return ev;
      const problem = verifiedProblem(ev, refs);
      return problem ? { ...ev, kind: "assumed" as const, note: problem } : ev;
    });
}

function verifiedProblem(ev: Evidence, refs: readonly ResolvedRef[]): string | undefined {
  if (!ev.repo || !ev.file) return "参照先とファイルが書かれていないので、確かめた根拠として扱いません";
  const ref = refs.find((r) => r.name === ev.repo);
  if (!ref) return `参照先「${ev.repo}」は登録されていません`;
  if (ref.status !== "ok" || !ref.local) return `参照先 ${ev.repo} はこの評価で見ていません`;
  const file = ev.file.replace(/^(\.\/)+/, "");
  if (file.startsWith("/") || file.split("/").includes("..")) return "参照先の中の相対パスではありません";
  if (!existsSync(join(ref.local, file))) return `${ev.repo}:${file} がありません`;
  return undefined;
}

export function parseAssessment(text: string, refs?: readonly ResolvedRef[]): PreflightAssessment {
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
    ...(Array.isArray(a.evidence) ? { evidence: parseEvidence(a.evidence, refs) } : {}),
    ...(parseSplit(a.split) ? { split: parseSplit(a.split) } : {}),
  };
}
