/** API の応答に添えられた警告（完了済の祖先の下に未完了ができた ancestor_done など）の文言。無ければ空 */
export function warningText(res: unknown): string {
  const ws = (res as { warnings?: { message: string }[] } | undefined)?.warnings ?? [];
  return ws.map((w) => w.message).join(" / ");
}
