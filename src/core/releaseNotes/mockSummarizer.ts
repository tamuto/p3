import type { PreflightLogEntry } from "../../shared/types.ts";
import type { AskResult } from "../preflight/codexEngine.ts";
import type { Summarizer } from "./generate.ts";

/**
 * Codex を使わずに要約の契約（最後の応答の JSON）を再現する（オフライン開発・デモ・テスト用）。
 * 依頼文の材料から、要望ごとに1項目「（Mock）タイトル: 最初の記録の1行目」を作るだけで、要約はしない。
 * --engine mock か個人設定の preflight.engine: mock で明示したときだけ使う（Preflight と同じ）
 */
export class MockSummarizer implements Summarizer {
  /** 待ち時間（ms。画面で生成中が見えるように少し待つ。テストでは 0） */
  constructor(private opts: { delayMs?: number } = {}) {}

  async ask(input: { prompt: string }, log: (e: Omit<PreflightLogEntry, "at">) => void, signal: AbortSignal): Promise<AskResult> {
    log({ kind: "info", text: "Mock で要約します（要約はせず、記録の1行目を並べます）" });
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, this.opts.delayMs ?? 1500);
      signal.addEventListener("abort", () => (clearTimeout(t), rej(new Error("aborted"))), { once: true });
    });
    const json = /<material>\n([\s\S]*?)\n<\/material>/.exec(input.prompt)?.[1];
    const material = JSON.parse(json ?? "{}") as { requests?: { id: string; title: string; tasks: { ref: string; record?: string }[] }[] };
    const items = (material.requests ?? []).map((r) => ({
      text: `（Mock）${r.title}: ${(r.tasks[0]?.record ?? "").split("\n").find((l) => l.trim() && !l.startsWith("#"))?.replace(/^[-*]\s*/, "").trim() ?? ""}`,
      sources: [r.id, ...r.tasks.map((t) => t.ref)],
    }));
    return { message: JSON.stringify({ items }), seconds: 0 };
  }
}
