import { randomBytes } from "node:crypto";
import { nowIso } from "@infodb/p3-shared/node/fsutil.ts";
import type { WorkStore } from "./workStore.ts";
import { DefinitionStore, PreparationStore } from "./definitionStore.ts";
import { SLOT_LABEL, SLOTS } from "../shared/preparation.ts";
import { FILE_KINDS, FILE_STATE_LABEL, MEASURE_TYPE_LABEL, MEASURE_TYPES, reachesSelf, RUN_KIND_LABEL, type FileState, type Measure, type Run } from "../shared/definition.ts";
import {
  InvalidSuggestion,
  MISSING_FIELDS,
  parseSuggestion,
  SuggestionError,
  SURFACES,
  type Suggestion,
  type SuggestionCandidates,
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

調べ方:
- 入口（アプリの起動方法・画面の URL・既存のテストやスクリプトの置き場所と書き方・package.json の scripts・テストの補助）は、利用者に聞く前に
  参照先を自分で調べて見つける（README・docs・package.json・既存のテストとその補助のファイル）。ls・rg・cat・git log など読むだけのコマンドで調べてよい
- 調べても分からないときだけ missing に書き、reason にどこを調べて何が分からなかったかを書く
- 今ある手順のうち、まだ無いファイルを今の実行方法にしているもの（［新規予定］）は、そのままでは実行できない。AI への指示に直し、そのファイルを置き換え候補にした手順を提案する
- ファイルの作成・変更、アプリの起動、テストやスクリプトの実行はしない（提案だけ）

前提の観測と準備（観測を順につないで状態を受け渡すと、順番や片方の失敗で結果が不安定になるので、判定の関係と状態の用意を分ける）:
- 前提の観測（prerequisites）: 先に通っていてこそこの観測に意味があるもの（例: 業務画面の観測にとってのサインインの観測）。依頼の「選べる観測」の ID から選ぶ。
  状態は受け渡さない（前提が失敗したら、この観測は未確認として扱われる）。選べる観測に無いものは書かない
- 使う準備（preparations）: 観測の前後で状態を作る・戻すもの。依頼の「既にある準備」に合うものがあれば、その ID を選んで再利用を優先する
- 合う準備が無ければ、新しい準備の案（newPreparations）を出す: 名前（name）・説明（description）・占有（exclusive: 同時に走らせないデータ・アカウントなど）と、
  確かめ（check: 使える状態かの確認）・前処理（setup）・後処理（teardown）。中身は手順と同じ run（と replacement）で、まだスクリプトが無ければ AI への指示にする
- 準備の原則: 始める前に既知の状態に戻す（後処理はできるときにやる片付けで、頼りにしない）・作るデータには実行ごとに一意な名前を付ける・
  失敗したら片付ける前に証跡を取る・決まった秒数ではなく条件で待つ（表示・応答・ファイルの出現など）
- 前後で必要になりやすい観点: データ・認証と権限・アプリの状態・時刻と地域・外部の依存・キャッシュと非同期処理・ファイル・ブラウザ・証跡。
  観測内容に関係するものだけを準備や手順の前提に書く（関係しないものは書かない）

- まだ無いファイルを今の実行方法（run）に書かない（置き換え候補に書く）。無いものを有るように書かない
- 測定項目が足りなければ候補（measures）を出す（名前は英数字・_・-、型 ${MEASURE_TYPES.join(" / ")}、数値なら単位、説明）。定義に既にある名前は使わない
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
  "prerequisites": [{ "id": "選べる観測の ID", "reason": "前提にする理由" }],
  "preparations": [{ "id": "既にある準備の ID", "reason": "使う理由" }],
  "newPreparations": [{ "preparation": { "name": "...", "description": "...", "exclusive": ["..."], "setup": { "run": { "kind": "ai-instruction", "target": "...", "steps": ["..."], "judge": "...", "record": "..." } } }, "reason": "既にある準備では足りない理由" }],
  "missing": [{ "field": "${MISSING_FIELDS.join(" | ")}", "reason": "その材料が要る理由と、何を書けばよいか" }]
}
run は ai-instruction のほか、既にあるものなら { "kind": "command", "command": "...", "args": [], "repo": "...", "cwd": "..." } か
{ "kind": "${FILE_KINDS.join(" | ")}", "repo": "...", "path": "...", "invoke": "..." }。replacement は無ければ省く。
prerequisites・preparations・newPreparations は要らなければ空の配列にする。`;

const runLine = (r: Run) =>
  r.kind === "ai-instruction" ? `AI への指示（対象: ${r.target}）` : r.kind === "command" ? `コマンド ${[r.command, ...r.args].join(" ")}` : `${RUN_KIND_LABEL[r.kind]} ${r.repo}:${r.path}`;

/** 依頼文（プロジェクトの文脈・定義の入力・参照先・補足） */
export function suggestPrompt(req: SuggestionRequest, repos: string[], project?: string, files?: (repo: string, path: string) => FileState): string {
  const d = req.definition;
  const lines = [
    ...(project ? [project, ""] : []),
    "## 観測の定義",
    `- タイトル: ${d.title || "（未入力）"}`,
    `- カテゴリ: ${d.category || "（未入力）"}`,
    "- 観測内容:",
    d.description ? d.description.split("\n").map((l) => `  ${l}`).join("\n") : "  （未入力）",
    "- 期待する結果:",
    d.expected ? d.expected.split("\n").map((l) => `  ${l}`).join("\n") : "  （未入力。判定は観測内容から決める）",
    "",
    "## 測定項目",
    ...(d.measures.length ? d.measures.map((m) => `- ${m.name}: ${MEASURE_TYPE_LABEL[m.type]}${m.unit ? `（${m.unit}）` : ""}${m.description ? ` — ${m.description}` : ""}`) : ["（まだ無い。要るものを measures の候補に出す）"]),
    "",
    "## 今ある手順（実行できるものは重ねて提案しない。［新規予定］の今の実行方法は直す提案をする）",
    ...(d.procedures.length
      ? d.procedures.map((p) => {
          const state = p.run.kind !== "ai-instruction" && p.run.kind !== "command" && files ? `［${FILE_STATE_LABEL[files(p.run.repo, p.run.path)]}］` : "";
          return `- ${p.title}: ${runLine(p.run)}${state}${p.replacement ? `（置き換え候補 ${p.replacement.repo}:${p.replacement.path}）` : ""}`;
        })
      : ["（無い）"]),
    "",
    ...refsPrompt(req),
    "## 読める参照先",
    ...(repos.length ? repos.map((r) => `- ${r}`) : ["（無い。参照先が要るなら missing に repo を書く）"]),
  ];
  if (req.note) lines.push("", "## 利用者の補足", req.note);
  lines.push("", "最後の応答は指示どおりの JSON だけにしてください。");
  return lines.join("\n");
}

/** 依頼文の前提と準備の部分（今選んでいるもの・選べる観測・既にある準備。判断に要る項目だけ） */
function refsPrompt(req: SuggestionRequest): string[] {
  const c = req.candidates;
  const d = req.definition;
  if (!c) return [];
  const chosen = (ids: string[] | undefined, label: (id: string) => string) => (ids?.length ? ids.map((id) => `- ${label(id)}`) : ["（無い）"]);
  return [
    "## 今の前提の観測（重ねて提案しない）",
    ...chosen(d.prerequisites, (id) => `${id} ${c.observations.find((o) => o.id === id)?.title ?? ""}`),
    "## 今の使う準備（重ねて提案しない）",
    ...chosen(d.preparations, (id) => `${id} ${c.preparations.find((p) => p.id === id || p.name === id)?.name ?? ""}`),
    "## 選べる観測（前提の候補。ID・タイトル・観測内容の冒頭）",
    ...(c.observations.length ? c.observations.map((o) => `- ${o.id} ${o.title} — ${o.description.split("\n")[0].slice(0, 200)}`) : ["（無い）"]),
    "## 既にある準備（合うものがあれば再利用する。ID・名前・説明・中身・占有）",
    ...(c.preparations.length ? c.preparations.map((p) => `- ${p.id} ${p.name}${p.description ? ` — ${p.description.split("\n")[0].slice(0, 200)}` : ""}（${p.slots.map((s) => SLOT_LABEL[s]).join("・") || "中身なし"}${p.exclusive.length ? `・占有 ${p.exclusive.join("・")}` : ""}）`) : ["（無い。要るなら newPreparations に案を出す）"]),
    "",
  ];
}

/**
 * Mock の提案（個人設定の preflight.engine が mock のとき。AI を呼ばない）。材料の言葉で操作面を決める:
 * コマンド・CLI の言葉があればコマンド、画面の言葉があれば AI への指示と画面操作スクリプトへの置き換え候補、どちらも無ければ足りない材料を返す。
 * 測定項目が無ければ候補を1つ出す
 */
export function mockSuggestion(req: SuggestionRequest, repos: string[]): Suggestion {
  const d = req.definition;
  const text = `${d.title}\n${d.description}\n${req.note ?? ""}`;
  // 前提と準備: 材料に名前が出てくる観測・準備を候補にし、画面で合う準備が無ければ新しい準備の案を出す
  const prerequisites = (req.candidates?.observations ?? []).filter((o) => text.includes(o.title) && !d.prerequisites?.includes(o.id)).map((o) => ({ id: o.id, reason: `Mock: 材料に「${o.title}」が出てくるので前提の候補にしました` }));
  const preparations = (req.candidates?.preparations ?? []).filter((p) => text.includes(p.name) && !d.preparations?.includes(p.id)).map((p) => ({ id: p.id, reason: `Mock: 材料に「${p.name}」が出てくるので再利用の候補にしました` }));
  const refs = { prerequisites, preparations, newPreparations: [] as Suggestion["newPreparations"] };
  const candidate: Measure[] = d.measures.length ? [] : [{ name: "ok", type: "boolean", description: "判定のとおりだったか" }];
  const measures = [...d.measures, ...candidate].map((m) => m.name);
  const repo = repos[0];
  const evidence = "Mock: 材料の言葉から決めました（参照先は読んでいません）";
  const base = { measures: candidate, warnings: [], ...refs };
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
      newPreparations: preparations.length || !req.candidates ? [] : [{ reason: "Mock: 既にある準備に合うものが無いので、画面を開ける状態を作る準備の案を出しました", preparation: { name: `${d.title || "観測"}の前の状態`, description: "観測の前に、画面を開ける既知の状態に戻す", exclusive: [], setup: { run: { kind: "ai-instruction", target: "ブラウザで開いた画面", steps: ["実行ごとに一意な名前で必要なデータを作る", "画面に表示されるまで待つ"], judge: "作ったデータが画面に出る", record: "記録しない" } } } }],
      missing: repo ? [] : [{ field: "repo", reason: "画面操作スクリプトを置く参照先が分かりません（読める参照先がありません。このマシンのパスを登録してください）" }],
    };
  }
  return {
    ...base,
    surface: "unknown",
    rationale: "Mock: 材料から操作面（CLI・画面など）を判断できません",
    measures: [],
    prerequisites: [],
    preparations: [],
    procedures: [],
    missing: [
      { field: "surface", reason: "観測の対象が CLI・画面・API のどれか分かりません。観測内容か補足に書いてください" },
      { field: "entry", reason: "対象の入口（コマンド名・画面の URL など）が分かりません" },
    ],
  };
}

/** 提案を AI の応答の形（procedures の各項目に evidence を並べる）にする（Mock の応答・テストの代替の接続が使う） */
export function suggestionMessage(s: Pick<Suggestion, "surface" | "rationale" | "procedures" | "missing"> & Partial<Pick<Suggestion, "measures" | "prerequisites" | "preparations" | "newPreparations">>): string {
  const { surface, rationale, measures = [], prerequisites = [], preparations = [], newPreparations = [], missing } = s;
  return JSON.stringify({ surface, rationale, measures, procedures: s.procedures.map(({ procedure: { id: _id, ...p }, evidence }) => ({ ...p, evidence })), prerequisites, preparations, newPreparations, missing });
}

/**
 * 前提の観測と使う準備の候補（このプロジェクトのもの。判断に要る項目だけ）。観測は自分自身と、前提をたどると自分に戻るもの（選ぶと循環する）を除く
 */
export async function suggestionCandidates(dataDir: string, self?: string): Promise<SuggestionCandidates> {
  const [{ definitions }, { items }] = await Promise.all([new DefinitionStore(dataDir).list(), new PreparationStore(dataDir).list()]);
  const reaches = reachesSelf(definitions, self);
  return {
    observations: definitions.filter((d) => !reaches(d.id)).map(({ id, title, description }) => ({ id, title, description })),
    preparations: items.map((p) => ({ id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), exclusive: p.exclusive, slots: SLOTS.filter((s) => p[s]) })),
  };
}

/** 実行中の提案（このプロセスの中だけ。保存しない。終わったものは少しのあいだ残す） */
export class SuggestionService {
  private jobs = new Map<string, SuggestionJob>();
  private aborts = new Map<string, AbortController>();
  private done = new Map<string, Promise<SuggestionJob>>();

  constructor(
    private readonly adapter: SuggestAdapter,
    private readonly opts: { timeoutMs?: number; keep?: number; store?: WorkStore; files?: (repo: string, path: string) => FileState } = {},
  ) {}

  context(): Promise<SuggestionContext> {
    return this.adapter.context();
  }

  /**
   * 始める（AI の応答を待たずに返る）。参照先は Preflight と同じく、読めるものを全部渡す（読めないものは外す）。
   * target（観測の ID と頼んだときの定義の版）を渡すと、依頼を保存してから始め、結果を保存してから完了にする
   */
  async start(input: SuggestionRequest, target?: { definition: string; basedOnRev: number }): Promise<SuggestionJob> {
    // 前提と準備の候補は P3 が保存の層から作り、依頼と一緒に残す（ID の無い互換の経路も、保存の場所があれば付ける）
    const req = this.opts.store ? { ...input, candidates: await suggestionCandidates(this.opts.store.dataDir, target?.definition) } : input;
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
      const r = await this.adapter.ask({ instructions: SUGGEST_INSTRUCTIONS, prompt: suggestPrompt(req, readable.map((x) => x.path ?? x.name), ctx.project, this.opts.files), repos, request: req }, () => {}, signal);
      if (signal.aborted) throw signal.reason;
      end = { engine: r.engine, result: parseSuggestion(r.message, req.definition.measures, req.candidates), status: "completed" };
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
