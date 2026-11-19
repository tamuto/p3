/** 成果物の文字列からコミットを取り出す（…/commit/<sha> の URL か、sha だけの文字列） */
export function commitsInOutput(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/\/commit\/([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  const bare = output.trim();
  if (/^[0-9a-f]{7,40}$/i.test(bare)) out.add(bare.toLowerCase());
  return [...out];
}
