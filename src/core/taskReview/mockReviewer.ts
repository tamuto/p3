import type { PreflightLogEntry } from "../../shared/types.ts";
import type { AskResult } from "../preflight/codexEngine.ts";
import type { Summarizer } from "../releaseNotes/generate.ts";

/**
 * Codex を使わずにタスクのレビューの契約（最後の応答の JSON）を再現する（オフライン開発・デモ・テスト用）。評価はせず、
 * どの比較項目も「判断できない」にする。--engine mock か個人設定の preflight.engine: mock で明示したときだけ使う
 */
export class MockTaskReviewer implements Summarizer {
  constructor(private opts: { delayMs?: number } = {}) {}

  async ask(input: { prompt: string }, log: (e: Omit<PreflightLogEntry, "at">) => void, signal: AbortSignal): Promise<AskResult> {
    log({ kind: "info", text: "Mock でレビューします（評価はせず、どの比較項目も判断できないにします）" });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, this.opts.delayMs ?? 1500);
      signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))), { once: true });
    });
    const json = /<material>\n([\s\S]*?)\n<\/material>/.exec(input.prompt)?.[1];
    const material = JSON.parse(json ?? "{}") as { items?: { id: string }[] };
    return {
      message: JSON.stringify({
        overall: "（Mock）評価していません",
        items: (material.items ?? []).map((i) => ({ item: i.id, verdict: "undetermined", reason: "（Mock）評価していません", evidence: [], gaps: ["Codex で実行すると評価します"] })),
        unplanned: [],
        checks: [],
        coverage: { read: "（Mock）読んでいません", unread: "材料の全部" },
      }),
      seconds: 0,
    };
  }
}
