import type { PreflightLogEntry } from "../../shared/types.ts";
import type { AskResult } from "../preflight/codexEngine.ts";
import type { Summarizer } from "../releaseNotes/generate.ts";

/**
 * Codex を使わずにレビューの契約（最後の応答の JSON）を再現する（オフライン開発・デモ・テスト用）。評価はせず、比較単位ごとに
 * 「判断材料不足」を返す。--engine mock か個人設定の preflight.engine: mock で明示したときだけ使う（Preflight と同じ）
 */
export class MockReviewer implements Summarizer {
  /** 待ち時間（ms。画面で実行中が見えるように少し待つ。テストでは 0） */
  constructor(private opts: { delayMs?: number } = {}) {}

  async ask(input: { prompt: string }, log: (e: Omit<PreflightLogEntry, "at">) => void, signal: AbortSignal): Promise<AskResult> {
    log({ kind: "info", text: "Mock でレビューします（評価はせず、どの比較単位も判断材料不足にします）" });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, this.opts.delayMs ?? 1500);
      signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))), { once: true });
    });
    const json = /<material>\n([\s\S]*?)\n<\/material>/.exec(input.prompt)?.[1];
    const material = JSON.parse(json ?? "{}") as { units?: { id: string }[]; requests?: { id: string }[]; quality?: { standards: { id: string }[] } };
    return {
      message: JSON.stringify({
        overall: `（Mock）評価していません。所属する要望 ${material.requests?.length ?? 0} 件を材料にしました`,
        units: (material.units ?? []).map((u) => ({ unit: u.id, verdict: "insufficient", reason: "（Mock）評価していません", evidence: [], gaps: ["Codex で実行すると評価します"] })),
        ...(material.quality ? { quality: material.quality.standards.map((q) => ({ standard: q.id, verdict: "undetermined", reason: "（Mock）評価していません", evidence: [] })) } : {}),
      }),
      seconds: 0,
    };
  }
}
