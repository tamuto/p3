import { writableRepos } from "../../shared/workTarget.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PreflightAssessment, ProposedTask } from "../../shared/types.ts";
import { stringifyFrontmatter } from "../store/frontmatter.ts";
import { writeFileAtomic } from "../store/fsutil.ts";
import type { EngineOutcome, PreflightEngine, PreflightJob } from "./engine.ts";
import { listScreenPng } from "./wireframe.ts";

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))), { once: true });
  });

/**
 * Codex を使わずに preflight のファイル契約を再現するエンジン（オフライン開発・UI 確認用）。
 * 要望本文の箇条書きをタスク案にし、関連項目から影響を推定するだけの単純なヒューリスティック。
 * 再評価では、メモの箇条書きをタスク案に足し、前回不採用にした案（同じ題）は不採用のままにする。
 * メモがあれば確認事項は答えられたものとして扱う（意味は解釈しない）。
 */
export class MockEngine implements PreflightEngine {
  readonly name = "mock" as const;
  /** 待ち時間の倍率（画面で進み具合が見えるように少し待つ。テストでは 0） */
  private delay: number;

  constructor(opts: { delay?: number } = {}) {
    this.delay = opts.delay ?? 1;
  }

  async status() {
    return {
      name: "mock" as const,
      ok: true,
      detail: "Mock（要望本文の箇条書きをそのままタスク案にする簡易評価）で実行します。PCUBE_PREFLIGHT_ENGINE=mock か個人設定の preflight.engine: mock で選ばれています",
    };
  }

  private sleep(ms: number, signal: AbortSignal) {
    return wait(ms * this.delay, signal);
  }

  async run(job: PreflightJob, log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    const { request, context } = job;
    log({ kind: "info", text: "mock engine: Codex を使わずにヒューリスティックで評価します" });
    await this.sleep(400, signal);
    for (const r of job.refs) for (const m of r.map) log({ kind: "command", text: `$ ls ${r.name}:${m.path}` });
    log({ kind: "command", text: `$ rg -l "${request.title.slice(0, 20)}" .` });
    await this.sleep(400, signal);
    for (const c of context.slice(0, 3)) {
      const [rid, tid] = c.ref.split("/");
      log({ kind: "command", text: `$ cat requests/${rid}/${tid ? `tasks/${tid}.md` : "request.md"}` });
      await this.sleep(250, signal);
    }

    const notes = job.carryover?.notes ?? [];
    const previous = job.carryover?.previous;
    if (previous) log({ kind: "command", text: `$ cat ${relative(job.dataDir, join(job.runDir, "carryover.md"))}` });
    const bullets = [...new Set([request.body, ...notes.map((n) => n.body)].flatMap(bulletsOf))].slice(0, 8);
    const rejected = new Set(previous?.drafts.filter((d) => !d.include).map((d) => d.title));
    const items = bullets.length ? bullets : [`${request.title} の設計`, `${request.title} の実装`, `${request.title} のテスト`];
    const areas = request.areas.length ? request.areas : ["src"];
    const drafts: ProposedTask[] = items.map((title, i) => ({
      key: `D${i + 1}`,
      title,
      description: `要望 ${request.id} より。\n\n## 完了条件\n- ${title} が動作すること\n- 既存機能に回帰がないこと`,
      areas,
      dependsOn: i === 0 ? [] : [`D${i}`],
      relations: [],
      include: !rejected.has(title),
      // 作業先は作業先にできる参照先の先頭（Mock は読まないので推定しない。無ければ作業先なし）
      repo: writableRepos(job.project)[0] ?? null,
    }));

    const impacts = context
      .filter((c) => c.score >= 0.25)
      .slice(0, 4)
      .map((c) => ({
        target: c.ref,
        type: (c.reasons.some((r) => r.includes("領域")) ? "impacts" : "relates_to") as "impacts" | "relates_to",
        reason: c.reasons.join(" / "),
        confidence: Math.min(0.9, c.score),
      }));

    const clarity = Math.min(100, 40 + (request.body.length + notes.reduce((n, x) => n + x.body.length, 0)) / 8);
    const carried = [previous && `前回 ${previous.id} を引き継ぎ`, notes.length && `メモ ${notes.length} 件を反映`].filter(Boolean).join("、");
    const assessment: PreflightAssessment = {
      summary: `「${request.title}」を ${drafts.length} 件のタスクに分割しました。関連する既存項目が ${impacts.length} 件あります。${carried ? `${carried}しました。` : ""}（mock による推定）`,
      verdict: clarity < 55 && !notes.length ? "clarify" : "go",
      validity: { score: Math.round(clarity), reasons: ["mock: 本文の具体性から推定"] },
      feasibility: { score: impacts.length > 2 ? 60 : 80, reasons: ["mock: 既存項目との重なりから推定"] },
      risks: impacts.length ? [`${impacts.map((i) => i.target).join(", ")} と影響範囲が重なる`] : [],
      questions: clarity < 55 && !notes.length ? ["完了条件をより具体的にしてください"] : [],
      areas,
      impacts,
      // Mock は参照先を読まないので、根拠はすべて推測
      evidence: [{ claim: "mock: 要望の本文の箇条書きからタスク案を作った（コードは読んでいない）", kind: "assumed" }],
    };

    await writeFileAtomic(join(job.runDir, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n");
    for (const d of drafts) {
      const { description, ...meta } = d;
      await writeFileAtomic(join(job.runDir, "drafts", `${d.key}.md`), stringifyFrontmatter(meta, description));
      log({ kind: "info", text: `✎ ${relative(job.dataDir, join(job.runDir, "drafts", `${d.key}.md`))}` });
      await this.sleep(150, signal);
    }
    const ui = await writeMockUi(job, drafts);
    log({ kind: "info", text: ui.length ? `✎ 画面イメージ ${ui.filter((f) => f.endsWith(".png")).length} 件（ui/）` : "画面イメージは不要としました（ui/index.json）" });
    log({ kind: "message", text: assessment.summary });
    return {
      changed: [join(job.runDir, "assessment.json"), ...drafts.map((d) => join(job.runDir, "drafts", `${d.key}.md`)), join(job.runDir, "ui", "index.json"), ...ui],
    };
  }
}

/** 画面を伴う要望とみなす語 */
const UI_WORDS = /画面|UI|ボタン|一覧|表示|フォーム|入力欄|ダイアログ|メニュー/;

/**
 * 画面資料（決まった日本語の例）。画面を伴う要望なら、原稿（HTML）と箱だけの PNG を書く（Mock は描画のコンテナを使わない）。
 * そうでなければ不要の理由を書く。書いた画像と原稿のパスを返す
 */
async function writeMockUi(job: PreflightJob, drafts: ProposedTask[]): Promise<string[]> {
  const ui = join(job.runDir, "ui");
  const r = job.request;
  if (!drafts.length || !UI_WORDS.test(`${r.title}\n${r.body}`)) {
    await writeFileAtomic(join(ui, "index.json"), JSON.stringify({ needed: false, reason: "mock: 要望に画面に関わる語が無いので、画面を伴わない変更とみなしました" }, null, 2) + "\n");
    return [];
  }
  const target = drafts[0].key;
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(r.title)}</title>
<style>body{margin:24px;font-family:sans-serif;color:#1e293b} .bar{display:flex;gap:12px;margin:16px 0} .bar span{border:1px solid #cbd5e1;padding:6px 12px}
.bar b{background:#4f46e5;color:#fff;padding:6px 16px} table{width:100%;border-collapse:collapse} th,td{border-bottom:1px solid #cbd5e1;padding:8px;text-align:left}</style></head>
<body><h1>${escapeHtml(r.title)}</h1>
<div class="bar"><span>キーワード</span><span>状態: すべて</span><b>絞り込む</b></div>
<table><tr><th>ID</th><th>タイトル</th><th>状態</th></tr><tr><td>（例）</td><td>（仮のデータ）</td><td>進行中</td></tr></table>
</body></html>
`;
  await writeFileAtomic(join(ui, "src", "U1.html"), html);
  await mkdir(ui, { recursive: true });
  await writeFile(join(ui, "U1.png"), listScreenPng());
  const index = {
    needed: true,
    targets: [target],
    items: [
      {
        id: "U1",
        file: "U1.png",
        html: "src/U1.html",
        title: `${r.title}: 一覧と絞り込み（mock の例）`,
        drafts: [target],
        viewport: 1024,
        assumptions: ["mock: 要望の内容は読まずに決まった一覧画面の形で描いた", "表の行は仮のデータ"],
      },
    ],
  };
  await writeFileAtomic(join(ui, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return [join(ui, "U1.png"), join(ui, "src", "U1.html"), join(ui, "index.json")];
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function bulletsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => /^\s*(?:[-*]|\d+\.)\s+(.+)/.exec(l)?.[1]?.trim())
    .filter((s): s is string => !!s);
}
