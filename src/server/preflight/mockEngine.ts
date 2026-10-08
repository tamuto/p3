import { join } from "node:path";
import type { PreflightAssessment, ProposedTask } from "../../shared/types.ts";
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
 */
export class MockEngine implements PreflightEngine {
  readonly name = "mock" as const;
  /** 待ち時間の倍率（画面で進み具合が見えるように少し待つ。テストでは 0） */
  private delay: number;

  constructor(opts: { delay?: number } = {}) {
    this.delay = opts.delay ?? 1;
  }

  private sleep(ms: number, signal: AbortSignal) {
    return wait(ms * this.delay, signal);
  }

  async run(job: PreflightJob, log: Parameters<PreflightEngine["run"]>[1], signal: AbortSignal): Promise<EngineOutcome> {
    const { request, context } = job;
    log({ kind: "info", text: "mock engine: Codex を使わずにヒューリスティックで評価します" });
    await this.sleep(400, signal);
    for (const d of job.project.docs) log({ kind: "command", text: `$ ls ${d}` });
    log({ kind: "command", text: `$ rg -l "${request.title.slice(0, 20)}" .` });
    await this.sleep(400, signal);
    for (const c of context.slice(0, 3)) {
      const [rid, tid] = c.ref.split("/");
      log({ kind: "command", text: `$ cat ${job.dataDirRel}/requests/${rid}/${tid ? `tasks/${tid}.md` : "request.md"}` });
      await this.sleep(250, signal);
    }

    const bullets = request.body
      .split("\n")
      .map((l) => /^\s*(?:[-*]|\d+\.)\s+(.+)/.exec(l)?.[1]?.trim())
      .filter((s): s is string => !!s)
      .slice(0, 8);
    const items = bullets.length ? bullets : [`${request.title} の設計`, `${request.title} の実装`, `${request.title} のテスト`];
    const areas = request.areas.length ? request.areas : ["src"];
    const drafts: ProposedTask[] = items.map((title, i) => ({
      key: `D${i + 1}`,
      title,
      description: `要望 ${request.id} より。\n\n## 完了条件\n- ${title} が動作すること\n- 既存機能に回帰がないこと`,
      areas,
      dependsOn: i === 0 ? [] : [`D${i}`],
      relations: [],
      include: true,
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

    const clarity = Math.min(100, 40 + request.body.length / 8);
    const assessment: PreflightAssessment = {
      summary: `「${request.title}」を ${drafts.length} 件のタスクに分割しました。関連する既存項目が ${impacts.length} 件あります。（mock による推定）`,
      verdict: clarity < 55 ? "clarify" : "go",
      validity: { score: Math.round(clarity), reasons: ["mock: 本文の具体性から推定"] },
      feasibility: { score: impacts.length > 2 ? 60 : 80, reasons: ["mock: 既存項目との重なりから推定"] },
      risks: impacts.length ? [`${impacts.map((i) => i.target).join(", ")} と影響範囲が重なる`] : [],
      questions: clarity < 55 ? ["完了条件をより具体的にしてください"] : [],
      areas,
      impacts,
    };

    await writeFileAtomic(join(job.runDir, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n");
    for (const d of drafts) {
      const { description, ...meta } = d;
      await writeFileAtomic(join(job.runDir, "drafts", `${d.key}.md`), stringifyFrontmatter(meta, description));
      log({ kind: "info", text: `✎ ${job.runDirRel}/drafts/${d.key}.md` });
      await this.sleep(150, signal);
    }
    log({ kind: "message", text: assessment.summary });
    return { changed: [`${job.runDirRel}/assessment.json`, ...drafts.map((d) => `${job.runDirRel}/drafts/${d.key}.md`)] };
  }
}
