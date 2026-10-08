/** 日時を短く（10/09 14:05）。ローカル時刻 */
export function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
