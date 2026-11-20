import { randomBytes } from "node:crypto";
import { nowIso } from "@infodb/p3-shared/node/fsutil.ts";
import type { WorkStore } from "./workStore.ts";
import { FILE_KINDS, MEASURE_TYPE_LABEL, MEASURE_TYPES, RUN_KIND_LABEL, type Measure, type Run } from "../shared/definition.ts";
import {
  InvalidSuggestion,
  MISSING_FIELDS,
  parseSuggestion,
  SuggestionError,
  SURFACES,
  type Suggestion,
  type SuggestionContext,
  type SuggestionJob,
  type SuggestionRequest,
} from "../shared/suggestion.ts";

/**
 * 確認の手順の提案（docs/architecture.md「p3-observer」の手順の提案）。AI を呼ぶのはアプリが渡すアダプター（Codex の接続を共有する。
 * observer は tasks を読まない）。observer は依頼文を作り、応答を定義の形に照らして確かめる。保存はしない。
 */
export interface SuggestAdapter {
  /** 頼む先の状態と、読ませられる参照先 */
  context(): Promise<SuggestionContext>;
  /**
   * 1回の頼みごと。repos は読める参照先の名前（全部。読むだけで渡す）。request は Mock が使う元の依頼。
   * 失敗は SuggestionError（種類つき）か、そのほかのエラー
   */
  ask(input: { instructions: string; prompt: string; repos: string[]; request: SuggestionRequest }, log: (text: string) => void, signal: AbortSignal): Promise<{ message: string; engine: string }>;
}

export const SUGGEST_TIMEOUT_MS = 10 * 60_000;

export const SUGGEST_INSTRUCTIONS = `あなたは、ソフトウェアの観測（繰り返し確かめて測る作業）の手順を設計する補助です。
利用者が書いた観測の定義と、読むだけで渡された参照先を材料に、観測の対象の操作面と、実際に実行できる確認の手順を提案してください。

手順は段取りで考えます:
1. 確かめるスクリプト等がまだ無いときは、今の実行方法（run）を「AI への指示」（ai-instruction）にし、AI か人がそのまま実行できる具体的なやることを書く:
   前提（premise: 起動しておくもの・用意するデータ）・対象（target: 画面の URL・コマンド・ファイル）・順に行う操作（steps: 1つが1手）・
   判定（judge: 何をもって期待どおりとするか）・測定値の記録方法（record: どの測定項目に何を書くか）
2. その手順が毎回同じ動作になり、結果も機械的に処理できるなら、置き換え候補（replacement）に用意するスクリプトの案を書く:
   作るファイル（repo・path）・そこで再現する操作（operation）・測定値の出力形式（output）・同じ入力で結果を比べる条件（compare）・
   切り替えの条件（switchWhen）・呼び出し方の案（invoke）。スクリプトを用意するのは別の作業で、用意して確かめた後に利用者が切り替える
3. 参照先に既に使えるコマンド・テスト・スクリプトがあれば、それを今の実行方法にし、根拠（evidence）にそのファイルや script の名前を書く

- まだ無いファイルを今の実行方法（run）に書かない（置き換え候補に書く）。無いものを有るように書かない
- 測定項目が足りなければ候補（measures）を出す（名前は英数字・_・-、型 ${MEASURE_TYPES.join(" / ")}、数値なら単位、説明）。定義に既にある名前は使わない
- 判断に必要な材料が足りなければ、推測で手順を作らず、足りない材料を missing に書く（どの材料が・なぜ要るか）
- ファイルを作ったり、コマンドを実行して確かめたりしない（提案だけ）
- 最後の応答は次の形の JSON だけにする（説明の文を付けない）

{
  "surface": "${SURFACES.join(" | ")}",
  "rationale": "操作面と手順をそう判断した根拠",
  "measures": [{ "name": "elapsed_ms", "type": "number", "unit": "ms", "description": "..." }],
  "procedures": [
    {
      "title": "...",
      "measures": ["測定項目の name（定義か measures の候補にあるもの）"],
      "run": { "kind": "ai-instruction", "premise": "...", "target": "...", "steps": ["...", "..."], "judge": "...", "record": "..." },
      "replacement": { "kind": "${FILE_KINDS.join(" | ")}", "repo": "参照先の名前", "path": "参照先の中の相対パス", "operation": "...", "output": "...", "compare": "...", "switchWhen": "...", "invoke": "..." },
      "evidence": "根拠"
    }
  ],
  "missing": [{ "field": "${MISSING_FIELDS.join(" | ")}", "reason": "その材料が要る理由と、何を書けばよいか" }]
}
run は ai-instruction のほか、既にあるものなら { "kind": "command", "command": "...", "args": [], "repo": "...", "cwd": "..." } か
{ "kind": "${FILE_KINDS.join(" | ")}", "repo": "...", "path": "...", "invoke": "..." }。replacement は無ければ省く。`;

const runLine = (r: Run) =>
  r.kind === "ai-instruction" ? `AI への指示（対象: ${r.target}）` : r.kind === "command" ? `コマンド ${[r.command, ...r.args].join(" ")}` : `${RUN_KIND_LABEL[r.kind]} ${r.repo}:${r.path}`;

/** 依頼文（プロジェクトの文脈・定義の入力・参照先・補足） */
export function suggestPrompt(req: SuggestionRequest, repos: string[], project?: string): string {
  const d = req.definition;
  const lines = [
    ...(project ? [project, ""] : []),
    "## 観測の定義",
    `- タイトル: ${d.title || "（未入力）"}`,
    `- カテゴリ: ${d.category || "（未入力）"}`,
    "- 観測内容:",
    d.description ? d.description.split("\n").map((l) => `  ${l}`).join("\n") : "  （未入力）",
    "",
    "## 測定項目",
    ...(d.measures.length ? d.measures.map((m) => `- ${m.name}: ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? ` — ${m.description}` : ""}`) : ["（まだ無い。要るものを measures の候補に出す）"]),
    "",
    "## 今ある手順（参考。重ねて提案しない）",
    ...(d.procedures.length ? d.procedures.map((p) => `- ${p.title}: ${runLine(p.run)}${p.replacement ? `（置き換え候補 ${p.replacement.repo}:${p.replacement.path}）` : ""}`) : ["（無い）"]),
    "",
    "## 読める参照先",
    ...(repos.length ? repos.map((r) => `- ${r}`) : ["（無い。参照先が要るなら missing に repo を書く）"]),
  ];
  if (req.note) lines.push("", "## 利用者の補足", req.note);
  lines.push("", "最後の応答は指示どおりの JSON だけにしてください。");
  return lines.join("\n");
}

/**
 * Mock の提案（個人設定の preflight.engine が mock のとき。AI を呼ばない）。材料の言葉で操作面を決める:
 * コマンド・CLI の言葉があればコマンド、画面の言葉があれば AI への指示と画面操作スクリプトへの置き換え候補、どちらも無ければ足りない材料を返す。
 * 測定項目が無ければ候補を1つ出す
 */
export function mockSuggestion(req: SuggestionRequest, repos: string[]): Suggestion {
  const d = req.definition;
  const text = `${d.title}\n${d.description}\n${req.note ?? ""}`;
  const candidate: Measure[] = d.measures.length ? [] : [{ name: "ok", type: "boolean", description: "判定のとおりだったか" }];
  const measures = [...d.measures, ...candidate].map((m) => m.name);
  const repo = repos[0];
  const evidence = "Mock: 材料の言葉から決めました（参照先は読んでいません）";
  const base = { measures: candidate, warnings: [] };
  if (/(CLI|コマンド|command|\bp3 |pnpm|npm|curl)/i.test(text)) {
    return {
      ...base,
      surface: "cli",
      rationale: "Mock: 材料に CLI・コマンドの言葉があるので、コマンドで確かめる手順にしました",
      procedures: [{ procedure: { id: "", title: `${d.title || "観測"}をコマンドで確かめる`, measures, run: { kind: "command", command: "pnpm", args: ["-s", "test"], ...(repo ? { repo } : {}) } }, evidence }],
      missing: [],
    };
  }
  if (/(画面|ページ|ボタン|クリック|UI|ブラウザ)/i.test(text)) {
    return {
      ...base,
      surface: "ui",
      rationale: "Mock: 材料に画面の言葉があるので、まず AI への指示で確かめ、画面操作スクリプトに置き換える段取りにしました",
      procedures: [
        {
          procedure: {
            id: "",
            title: `${d.title || "観測"}を画面で確かめる`,
            measures,
            run: { kind: "ai-instruction", premise: "p3 serve を起動しておく", target: "ブラウザで開いた画面", steps: ["画面を開く", "観測内容の操作を順に行う"], judge: "観測内容のとおりに表示が変わる", record: `${measures[0] ?? "ok"} に判定の結果を書く` },
            ...(repo ? { replacement: { kind: "ui-script" as const, repo, path: "test/ui/observe.ui.test.ts", operation: "上の操作を Playwright で再現する", output: "測定項目ごとの値を JSON で標準出力に書く", compare: "同じデータで2回実行して同じ値になる", switchWhen: "スクリプトで同じ判定の結果が出ることを確かめたとき", invoke: "pnpm vitest run -c vitest.ui.config.ts test/ui/observe.ui.test.ts" } } : {}),
          },
          evidence,
        },
      ],
      missing: repo ? [] : [{ field: "repo", reason: "画面操作スクリプトを置く参照先が分かりません（読める参照先がありません。このマシンのパスを登録してください）" }],
    };
  }
  return {
    ...base,
    surface: "unknown",
    rationale: "Mock: 材料から操作面（CLI・画面など）を判断できません",
    measures: [],
    procedures: [],
    missing: [
      { field: "surface", reason: "観測の対象が CLI・画面・API のどれか分かりません。観測内容か補足に書いてください" },
      { field: "entry", reason: "対象の入口（コマンド名・画面の URL など）が分かりません" },
    ],
  };
}

/** 提案を AI の応答の形（procedures の各項目に evidence を並べる）にする（Mock の応答・テストの代替の接続が使う） */
export function suggestionMessage(s: Pick<Suggestion, "surface" | "rationale" | "procedures" | "missing"> & { measures?: Measure[] }): string {
  return JSON.stringify({ surface: s.surface, rationale: s.rationale, measures: s.measures ?? [], procedures: s.procedures.map(({ procedure: { id: _id, ...p }, evidence }) => ({ ...p, evidence })), missing: s.missing });
}

/** 実行中の提案（このプロセスの中だけ。保存しない。終わったものは少しのあいだ残す） */
export class SuggestionService {
  private jobs = new Map<string, SuggestionJob>();
  private aborts = new Map<string, AbortController>();
  private done = new Map<string, Promise<SuggestionJob>>();

  constructor(
    private readonly adapter: SuggestAdapter,
    private readonly opts: { timeoutMs?: number; keep?: number; store?: WorkStore } = {},
  ) {}

  context(): Promise<SuggestionContext> {
    return this.adapter.context();
  }

  /**
   * 始める（AI の応答を待たずに返る）。参照先は Preflight と同じく、読めるものを全部渡す（読めないものは外す）。
   * target（観測の ID と頼んだときの定義の版）を渡すと、依頼を保存してから始め、結果を保存してから完了にする
   */
  async start(req: SuggestionRequest, target?: { definition: string; basedOnRev: number }): Promise<SuggestionJob> {
    const job: SuggestionJob = { id: `sg-${randomBytes(6).toString("hex")}`, status: "running", engine: "", startedAt: nowIso(), ...(target ? { ...target, request: req } : {}) };
    if (target) await this.opts.store!.createSuggestion(job);
    const abort = new AbortController();
    this.jobs.set(job.id, job);
    this.aborts.set(job.id, abort);
    this.done.set(job.id, this.execute(job, req, abort));
    this.trim();
    return { ...job };
  }

  /** 始めて終わるまで待つ（CLI） */
  async run(req: SuggestionRequest, target?: { definition: string; basedOnRev: number }, signal?: AbortSignal): Promise<SuggestionJob> {
    const job = await this.start(req, target);
    const onAbort = () => this.cancel(job.id);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.done.get(job.id)!;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  get(id: string): SuggestionJob | undefined {
    const j = this.jobs.get(id);
    return j && { ...j };
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running") return false;
    this.aborts.get(id)?.abort(new Error("cancelled"));
    return true;
  }

  running(): number {
    return [...this.jobs.values()].filter((j) => j.status === "running").length;
  }

  /** 実行中を全部取り消して終わるまで待つ（serve を止めるとき） */
  async settle(): Promise<void> {
    const ids = [...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.id);
    for (const id of ids) this.cancel(id);
    await Promise.allSettled(ids.flatMap((id) => this.done.get(id) ?? []));
  }

  private trim() {
    const keep = this.opts.keep ?? 50;
    const finished = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - keep))) {
      this.jobs.delete(j.id);
      this.done.delete(j.id);
    }
  }

  private async execute(job: SuggestionJob, req: SuggestionRequest, abort: AbortController): Promise<SuggestionJob> {
    const timeoutMs = this.opts.timeoutMs ?? SUGGEST_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([abort.signal, timeout]);
    // 終わりの状態は、保存してから job に入れる（API で保存前の「終わった」を見せない）
    let end: Partial<SuggestionJob>;
    try {
      const ctx = await this.adapter.context();
      job.engine = ctx.engine.name;
      if (!ctx.engine.ok) throw new SuggestionError("unavailable", ctx.engine.detail);
      const readable = ctx.repos.filter((r) => r.available);
      const repos = readable.map((r) => r.name);
      job.context = { ...(ctx.qualityVersion !== undefined ? { qualityVersion: ctx.qualityVersion } : {}), repos: readable.map((r) => r.path ?? r.name) };
      const r = await this.adapter.ask({ instructions: SUGGEST_INSTRUCTIONS, prompt: suggestPrompt(req, readable.map((x) => x.path ?? x.name), ctx.project), repos, request: req }, () => {}, signal);
      if (signal.aborted) throw signal.reason;
      end = { engine: r.engine, result: parseSuggestion(r.message, req.definition.measures), status: "completed" };
    } catch (e) {
      if (abort.signal.aborted) end = { status: "cancelled", error: "取り消しました" };
      else if (timeout.aborted) end = { status: "failed", failure: "timeout", error: `時間切れです（${Math.round(timeoutMs / 1000)} 秒）` };
      else if (e instanceof SuggestionError) end = { status: "failed", failure: e.kind, error: e.message };
      else if (e instanceof InvalidSuggestion) end = { status: "failed", failure: "invalid_output", error: `応答の形が違います: ${e.message}` };
      else end = { status: "failed", failure: "error", error: (e as Error)?.message ?? String(e) };
    }
    end.finishedAt = nowIso();
    if (job.definition) {
      end = await this.opts.store!.finishSuggestion({ ...job, ...end }).catch((e: Error) => ({ ...end, status: "failed" as const, failure: "error" as const, error: `結果を保存できません: ${e.message}` }));
    }
    Object.assign(job, end);
    this.aborts.delete(job.id);
    return { ...job };
  }
}
