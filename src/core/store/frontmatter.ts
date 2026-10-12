import YAML from "yaml";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** `---\nyaml\n---\nbody` 形式を分解する。frontmatter が無ければ空オブジェクト。 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = FENCE.exec(text);
  if (!m) return { data: {}, body: text };
  const data = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  // stringify は frontmatter と本文の間に空行を1つ入れるので、それを取り除く
  return { data, body: text.slice(m[0].length).replace(/^\r?\n/, "") };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  // undefined / 空配列は書かない（差分を小さく、人が読みやすく保つ）
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
  );
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trimEnd();
  const text = body.trim();
  return `---\n${yaml}\n---\n${text ? `\n${text}\n` : ""}`;
}
