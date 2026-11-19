import { UsageError } from "@infodb/p3-kit/usage.ts";
import { observerStatus } from "../core/status.ts";

export const OBSERVER_USAGE = "p3 observer status [--json]";

/**
 * p3 observer <サブコマンド>。入口がプロジェクトを決める前に呼ぶ（tasks のプロジェクトの解決・個人設定を経ない）。
 * 結果の data（--json）と text（通常の出力）を返す
 */
export function observerCommand(args: string[]): { data: unknown; text: string } {
  const [sub, ...rest] = args;
  if (sub !== "status" || rest.length) {
    throw new UsageError(sub === undefined ? `サブコマンドを指定してください: ${OBSERVER_USAGE}` : `observer のサブコマンドは status だけです: ${args.join(" ")}（${OBSERVER_USAGE}）`);
  }
  const s = observerStatus();
  return { data: s, text: [`p3-observer ${s.version}`, `  state  ${s.state}`, "  data   （まだ保存しない）"].join("\n") };
}
