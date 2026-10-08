const PALETTE = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6", "#ef4444"];

/** 要望ごとの色。ID の文字列から決める（同じ要望はいつも同じ色） */
export function streamColor(requestId: string) {
  let h = 0;
  for (const ch of requestId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
