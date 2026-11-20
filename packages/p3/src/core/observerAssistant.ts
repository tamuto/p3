import type { P3Context } from "@infodb/p3-tasks/core/context.ts";
import { classifyAiFailure } from "@infodb/p3-tasks/core/reviewRuns.ts";
import { mockSuggestion, suggestionMessage, type SuggestAdapter } from "@infodb/p3-observer/core/suggest.ts";
import { SuggestionError } from "@infodb/p3-observer/shared/suggestion.ts";

/**
 * observer の手順の提案に渡すアダプター（入口が組み立てる。observer は tasks を読まない）。
 * 頼む先は Preflight と同じ（個人設定の preflight.engine）: codex は Preflight と同じ Codex の接続（認証・イメージ・パスの対応）で、
 * 選んだ参照先だけを読むだけでマウントする。mock は AI を呼ばずに observer の Mock の提案を返す。
 */
export function observerAssistant(ctx: P3Context): SuggestAdapter {
  const engineName = async () => (ctx.assistant ? await ctx.assistant.engine().catch(() => "codex" as const) : undefined);
  return {
    async context() {
      const name = await engineName();
      const repos = ctx.ws.refs().map((r) => ({ name: r.name, available: r.status === "ok" && !!r.local, ...(r.reason ? { reason: r.reason } : {}) }));
      if (!ctx.assistant || !name) return { engine: { name: "none", ok: false, detail: "AI に頼む接続がありません" }, repos };
      if (name === "mock") return { engine: { name, ok: true, detail: "Mock（AI を呼ばずに、材料の言葉から決めた提案を返す）" }, repos };
      const s = await ctx.assistant.codex.status();
      return { engine: { name: s.name, ok: s.ok, detail: s.detail }, repos };
    },
    async ask(input, log, signal) {
      const name = await engineName();
      if (!ctx.assistant || !name) throw new SuggestionError("unavailable", "AI に頼む接続がありません");
      if (name === "mock") return { message: suggestionMessage(mockSuggestion(input.request)), engine: "mock" };
      const refs = ctx.ws.refs().filter((r) => input.repos.includes(r.name));
      try {
        const r = await ctx.assistant.codex.ask({ instructions: input.instructions, prompt: input.prompt, label: "観測の手順の提案", refs }, (e) => log(e.text), signal);
        return { message: r.message, engine: "codex" };
      } catch (e) {
        if (signal.aborted) throw e;
        const [kind, message] = classifyAiFailure(e, () => false);
        throw new SuggestionError(kind === "invalid_output" ? "error" : kind, message);
      }
    },
  };
}
