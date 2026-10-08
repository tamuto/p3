/** 表示幅（全角は2）を考慮して列を揃える */
export function table(rows: string[][]): string {
  const width = (s: string) => [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const max = Array.from({ length: cols - 1 }, (_, i) => Math.min(48, Math.max(...rows.map((r) => width(r[i] ?? "")))));
  return rows
    .map((r) => r.map((c, i) => (i < cols - 1 ? c + " ".repeat(Math.max(0, max[i] - width(c))) : c)).join("  ").trimEnd())
    .join("\n");
}
