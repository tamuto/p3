import { randomBytes } from "node:crypto";
import { nowIso } from "@infodb/p3-kit/fsutil.ts";
import { MEASURE_TYPE_LABEL, PROCEDURE_KINDS } from "../shared/definition.ts";
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
 * 確認の手順の提案（docs/architecture.md「p3-observer」の手順の提案）。AI を呼ぶのは入口が渡すアダプター（Codex の接続を共有する。
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
利用者が書いた観測の定義（タイトル・カテゴリ・観測内容・測定項目）と、読むだけで渡された参照先（/workspace/<名前>）を材料に、
観測の対象の操作面と、繰り返し使える確認の手順を提案してください。

- 繰り返し確かめるので、できるだけコマンドかユニットテストで表す。画面の操作が要るなら画面操作スクリプト、汎用の確認だけが残るなら AI への指示にする
- 参照先にあるコマンド・テスト・スクリプトを根拠にするときは、そのファイルや script の名前を根拠（evidence）に書く。無いものを有るように書かない
- 測定項目は利用者の定義にあるものだけを使う（新しく作らない）
- 判断に必要な材料が足りなければ、推測で手順を作らず、足りない材料を missing に書く（どの材料が・なぜ要るか）
- ファイルを作ったり、コマンドを実行して確かめたりしない（提案だけ）
- 最後の応答は次の形の JSON だけにする（説明の文を付けない）

{
  "surface": "${SURFACES.join(" | ")}",
  "rationale": "操作面と手順をそう判断した根拠",
  "procedures": [
    { "kind": "command", "title": "...", "command": "実行名", "args": ["引数"], "repo": "参照先の名前（任意）", "cwd": "参照先の中の相対パス（任意）", "measures": ["測定項目の name"], "evidence": "根拠" },
    { "kind": "test" または "ui-script", "title": "...", "repo": "参照先の名前", "path": "参照先の中の相対パス", "invoke": "呼び出し方（任意）", "measures": [], "evidence": "根拠" },
    { "kind": "ai-instruction", "title": "...", "body": "指示文", "measures": [], "evidence": "根拠" }
  ],
  "missing": [{ "field": "${MISSING_FIELDS.join(" | ")}", "reason": "その材料が要る理由と、何を書けばよいか" }]
}`;

/** 依頼文（定義の入力・参照先・補足） */
export function suggestPrompt(req: SuggestionRequest, repos: string[]): string {
  const d = req.definition;
  const lines = [
    "## 観測の定義（未保存の入力）",
    `- タイトル: ${d.title || "（未入力）"}`,
    `- カテゴリ: ${d.category || "（未入力）"}`,
    "- 観測内容:",
    d.description ? d.description.split("\n").map((l) => `  ${l}`).join("\n") : "  （未入力）",
    "",
    "## 測定項目",
    ...(d.measures.length ? d.measures.map((m) => `- ${m.name}: ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? ` — ${m.description}` : ""}`) : ["（まだ無い。手順の measures は空にし、必要なら missing に measure を書く）"]),
    "",
    "## 今ある手順（参考。重ねて提案しない）",
    ...(d.procedures.length ? d.procedures.map((p) => `- ${p.kind}: ${p.title}`) : ["（無い）"]),
    "",
    "## 読める参照先",
    ...(repos.length ? repos.map((r) => `- /workspace/${r}`) : ["（無い。参照先が要るなら missing に repo を書く）"]),
  ];
  if (req.note) lines.push("", "## 利用者の補足", req.note);
  lines.push("", `手順の kind は ${PROCEDURE_KINDS.join(" / ")} のどれか。最後の応答は指示どおりの JSON だけにしてください。`);
  return lines.join("\n");
}

/**
 * Mock の提案（個人設定の preflight.engine が mock のとき。AI を呼ばない）。材料の言葉で操作面を決める:
 * コマンド・CLI の言葉があればコマンド、画面の言葉があれば画面操作スクリプト、どちらも無ければ足りない材料を返す
 */
export function mockSuggestion(req: SuggestionRequest, repos: string[]): Suggestion {
  const d = req.definition;
  const text = `${d.title}\n${d.description}\n${req.note ?? ""}`;
  const measures = d.measures.map((m) => m.name);
  const repo = repos[0];
  if (/(CLI|コマンド|command|\bp3 |pnpm|npm|curl)/i.test(text)) {
    return {
      surface: "cli",
      rationale: "Mock: 材料に CLI・コマンドの言葉があるので、コマンドで確かめる手順にしました",
      procedures: [{ procedure: { kind: "command", title: `${d.title || "観測"}をコマンドで確かめる`, command: "pnpm", args: ["-s", "test"], ...(repo ? { repo } : {}), measures }, evidence: "Mock: 材料の言葉から決めました（参照先は読んでいません）" }],
      missing: [],
      warnings: [],
    };
  }
  if (/(画面|ページ|ボタン|クリック|UI|ブラウザ)/i.test(text)) {
    return {
      surface: "ui",
      rationale: "Mock: 材料に画面の言葉があるので、画面操作スクリプトで確かめる手順にしました",
      procedures: [{ procedure: { kind: "ui-script", title: `${d.title || "観測"}を画面で確かめる`, repo: repo ?? "app", path: "scripts/observe.ui.mjs", measures }, evidence: "Mock: 材料の言葉から決めました（参照先は読んでいません）" }],
      missing: repo ? [] : [{ field: "repo", reason: "画面操作スクリプトを置く参照先が分かりません（読める参照先がありません。このマシンのパスを登録してください）" }],
      warnings: [],
    };
  }
  return {
    surface: "unknown",
    rationale: "Mock: 材料から操作面（CLI・画面など）を判断できません",
    procedures: [],
    missing: [
      { field: "surface", reason: "観測の対象が CLI・画面・API のどれか分かりません。観測内容か補足に書いてください" },
      { field: "entry", reason: "対象の入口（コマンド名・画面の URL など）が分かりません" },
    ],
    warnings: [],
  };
}

/** 提案を AI の応答の形（procedures の各項目に evidence を並べる）にする（Mock の応答・テストの代替の接続が使う） */
export function suggestionMessage(s: Pick<Suggestion, "surface" | "rationale" | "procedures" | "missing">): string {
  return JSON.stringify({ surface: s.surface, rationale: s.rationale, procedures: s.procedures.map((p) => ({ ...p.procedure, evidence: p.evidence })), missing: s.missing });
}

/** 実行中の提案（このプロセスの中だけ。保存しない。終わったものは少しのあいだ残す） */
export class SuggestionService {
  private jobs = new Map<string, SuggestionJob>();
  private aborts = new Map<string, AbortController>();
  private done = new Map<string, Promise<SuggestionJob>>();

  constructor(
    private readonly adapter: SuggestAdapter,
    private readonly opts: { timeoutMs?: number; keep?: number } = {},
  ) {}

  context(): Promise<SuggestionContext> {
    return this.adapter.context();
  }

  /** 始める（すぐ返る）。参照先は Preflight と同じく、読めるものを全部渡す（読めないものは外す） */
  start(req: SuggestionRequest): SuggestionJob {
    const job: SuggestionJob = { id: `sg-${randomBytes(6).toString("hex")}`, status: "running", engine: "", startedAt: nowIso() };
    const abort = new AbortController();
    this.jobs.set(job.id, job);
    this.aborts.set(job.id, abort);
    this.done.set(job.id, this.execute(job, req, abort));
    this.trim();
    return { ...job };
  }

  /** 始めて終わるまで待つ（CLI） */
  async run(req: SuggestionRequest, signal?: AbortSignal): Promise<SuggestionJob> {
    const job = this.start(req);
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
    try {
      const ctx = await this.adapter.context();
      job.engine = ctx.engine.name;
      if (!ctx.engine.ok) throw new SuggestionError("unavailable", ctx.engine.detail);
      const repos = ctx.repos.filter((r) => r.available).map((r) => r.name);
      const r = await this.adapter.ask({ instructions: SUGGEST_INSTRUCTIONS, prompt: suggestPrompt(req, repos), repos, request: req }, () => {}, signal);
      if (signal.aborted) throw signal.reason;
      job.engine = r.engine;
      job.result = parseSuggestion(r.message, req.definition.measures);
      job.status = "completed";
    } catch (e) {
      if (abort.signal.aborted) {
        job.status = "cancelled";
        job.error = "取り消しました";
      } else {
        job.status = "failed";
        if (timeout.aborted) [job.failure, job.error] = ["timeout", `時間切れです（${Math.round(timeoutMs / 1000)} 秒）`];
        else if (e instanceof SuggestionError) [job.failure, job.error] = [e.kind, e.message];
        else if (e instanceof InvalidSuggestion) [job.failure, job.error] = ["invalid_output", `応答の形が違います: ${e.message}`];
        else [job.failure, job.error] = ["error", (e as Error)?.message ?? String(e)];
      }
    }
    job.finishedAt = nowIso();
    this.aborts.delete(job.id);
    return { ...job };
  }
}
