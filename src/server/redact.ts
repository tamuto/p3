/**
 * Preflight のログ・エラーに残す前に、トークンらしいものを伏せる。
 *   - Codex がエラーで一部だけ見せるキー（例: `Incorrect API key provided: eyJhbGci***xyz`）
 *   - JWT（ChatGPT の access token / ID トークンの形）
 *   - Authorization: Bearer の値
 * 本物の値を知っている呼び出し側は、secrets に渡せばそれも伏せる。
 */
export const REDACTED = "[伏せました]";

const PATTERNS: RegExp[] = [
  // 一部を *** で隠した値（前後の残りも消す）
  /[A-Za-z0-9._~+/=-]*\*{3,}[A-Za-z0-9._~+/=-]*/g,
  // JWT
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  // Bearer の値
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join(REDACTED);
  return PATTERNS.reduce(
    (t, re) =>
      t.replace(re, (m, bearer?: string) => {
        if (typeof bearer === "string" && /^Bearer/i.test(m)) return `${bearer}${REDACTED}`;
        // 文の終わりの「.」は値の一部ではないので残す
        return `${REDACTED}${/\.+$/.exec(m)?.[0] ?? ""}`;
      }),
    out,
  );
}
