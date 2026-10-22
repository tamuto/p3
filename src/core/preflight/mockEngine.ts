import { writableRepos } from "../../shared/workTarget.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PreflightAssessment, ProposedChild, ProposedTask } from "../../shared/types.ts";
import { SPLIT_HINT_TASKS } from "../../shared/hierarchy.ts";
import { stringifyFrontmatter } from "../store/frontmatter.ts";
import { writeFileAtomic } from "../store/fsutil.ts";
import type { EngineOutcome, PreflightEngine, PreflightJob } from "./engine.ts";

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
 * 箇条書きが分割の目安（SPLIT_HINT_TASKS）以上なら、タスク案の代わりに子の要望の案（3件ずつ）を書く。
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
      detail: "Mock（要望本文の箇条書きをそのままタスク案にする簡易評価）で実行します。P3_PREFLIGHT_ENGINE=mock か個人設定の preflight.engine: mock で選ばれています",
    };
  }

  private sleep(ms: number, signal: AbortSignal) {
    return wait(ms * this.delay, signal);
  }

  async run(job: PreflightJob, log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    const { request } = job;
    log({ kind: "info", text: "mock engine: Codex を使わずにヒューリスティックで評価します" });
    await this.sleep(400, signal);
    for (const r of job.refs) for (const m of r.map) log({ kind: "command", text: `$ ls ${r.name}:${m.path}` });
    log({ kind: "command", text: `$ rg -l "${request.title.slice(0, 20)}" .` });
    await this.sleep(400, signal);

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
      supersedes: [],
      include: !rejected.has(title),
      // 作業先は作業先にできる参照先の先頭（Mock は読まないので推定しない。無ければ作業先なし）
      repo: writableRepos(job.project)[0] ?? null,
    }));

    // 箇条書きが分割の目安（SPLIT_HINT_TASKS）以上なら、タスク案ではなく子の要望の案にする（3件ずつ）
    const split = items.length >= SPLIT_HINT_TASKS;
    const children: ProposedChild[] = split
      ? Array.from({ length: Math.ceil(items.length / 3) }, (_, i) => {
          const part = items.slice(i * 3, i * 3 + 3);
          return {
            key: `C${i + 1}`,
            title: `${request.title}（${i + 1}）: ${part[0]}`,
            description: [
              `## 目的\n${part.join("・")} を、親の要望の一部として仕上げる`,
              `## 範囲\n${part.map((x) => `- ${x}`).join("\n")}`,
              "## 範囲外\n- ほかの子の要望の項目",
              `## 完了条件\n${part.map((x) => `- ${x} が動作すること`).join("\n")}`,
              "## 分割の理由\nmock: 箇条書きを3件ずつに分けた（境界は推定していない）",
              `## 他の子との前提と契約\n${i ? `- C${i} の後に進める` : "- なし"}`,
              `## 出典\n- 要望 ${request.id} の本文`,
            ].join("\n\n"),
            estimatedTasks: part.length,
            requires: i ? [`C${i}`] : [],
            overlaps: [],
            include: true,
          };
        })
      : [];

    const clarity = Math.min(100, 40 + (request.body.length + notes.reduce((n, x) => n + x.body.length, 0)) / 8);
    const carried = [previous && `前回 ${previous.id} を引き継ぎ`, notes.length && `メモ ${notes.length} 件を反映`].filter(Boolean).join("、");
    const assessment: PreflightAssessment = {
      summary: split
        ? `「${request.title}」は想定 ${items.length} 件のタスクになるので、${children.length} 件の子の要望に分けます。${carried ? `${carried}しました。` : ""}（mock による推定）`
        : `「${request.title}」を ${drafts.length} 件のタスクに分割しました。${carried ? `${carried}しました。` : ""}（mock による推定）`,
      verdict: clarity < 55 && !notes.length ? "clarify" : "go",
      validity: { score: Math.round(clarity), reasons: ["mock: 本文の具体性から推定"] },
      feasibility: { score: 80, reasons: ["mock: 固定の値"] },
      risks: [],
      questions: clarity < 55 && !notes.length ? ["完了条件をより具体的にしてください"] : [],
      areas,
      // Mock は参照先を読まないので、根拠はすべて推測
      evidence: [{ claim: "mock: 要望の本文の箇条書きからタスク案を作った（コードは読んでいない）", kind: "assumed" }],
      split: {
        decision: split ? "split" : "keep",
        estimatedTasks: items.length,
        reasons: [split ? `mock: 箇条書きが ${SPLIT_HINT_TASKS} 件以上` : `mock: 箇条書きが ${SPLIT_HINT_TASKS} 件未満`],
      },
    };

    await writeFileAtomic(join(job.runDir, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n");
    if (split) {
      for (const c of children) {
        const { description, ...meta } = c;
        await writeFileAtomic(join(job.runDir, "children", `${c.key}.md`), stringifyFrontmatter(meta, description));
        log({ kind: "info", text: `✎ ${relative(job.dataDir, join(job.runDir, "children", `${c.key}.md`))}` });
      }
      await writeFileAtomic(join(job.runDir, "ui", "index.json"), JSON.stringify({ needed: false, reason: "mock: 子の要望に分けたので、画面イメージは子の Preflight で作ります" }, null, 2) + "\n");
      log({ kind: "message", text: assessment.summary });
      return { changed: [join(job.runDir, "assessment.json"), ...children.map((c) => join(job.runDir, "children", `${c.key}.md`)), join(job.runDir, "ui", "index.json")] };
    }
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
  // 決まった原稿と、それを描画のコンテナで描いておいた画像（Mock は Docker を使わない。原稿と画像は同じもの）
  await mkdir(join(ui, "src"), { recursive: true });
  await writeFile(join(ui, "src", "U1.html"), await readFile(MOCK_HTML));
  await writeFile(join(ui, "U1.png"), await readFile(MOCK_PNG));
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
        viewport: 960,
        assumptions: ["mock: 要望の内容は読まずに決まった一覧画面の形で描いた", "表の行は仮のデータ"],
      },
    ],
  };
  await writeFileAtomic(join(ui, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return [join(ui, "U1.png"), join(ui, "src", "U1.html"), join(ui, "index.json")];
}

const MOCK_HTML = new URL("./mock-ui.html", import.meta.url);
const MOCK_PNG = new URL("./mock-ui.png", import.meta.url);

function bulletsOf(text: string): string[] {
  return text
    .split("\n")
    .map((l) => /^\s*(?:[-*]|\d+\.)\s+(.+)/.exec(l)?.[1]?.trim())
    .filter((s): s is string => !!s);
}
