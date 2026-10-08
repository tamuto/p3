/** 今日（ローカル時刻の日付 YYYY-MM-DD。UTC だと日本の朝は前日になる） */
export function localToday(now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 期限までの日数（過ぎていれば負） */
export function daysUntil(due: string, today = localToday()): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
