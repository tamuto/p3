const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];

/** 作業ツリー（要望）ごとの色。ID の数値から決める */
export function streamColor(requestId: string) {
  const n = Number(/\d+/.exec(requestId)?.[0] ?? 0);
  return PALETTE[(n - 1 + PALETTE.length) % PALETTE.length];
}
