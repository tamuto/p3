/**
 * 入口が組み込んでいる製品（ビルドのときに決まる。探して読み込む仕組みは作らない）と、起動のときの選び方。
 * serve は --products で選ぶ（省くと tasks だけ。今までどおり）。画面は /api/mode の products で同じ選択を読む
 */
export const PRODUCTS = ["tasks", "observer"] as const;
export type Product = (typeof PRODUCTS)[number];
/** 選ばなかったときの製品（今までの p3 serve と同じ） */
export const DEFAULT_PRODUCTS: readonly Product[] = ["tasks"];

export const isProduct = (v: string): v is Product => (PRODUCTS as readonly string[]).includes(v);

/**
 * --products の値（tasks,observer のようにカンマ区切り）を読む。並びは PRODUCTS の順にそろえ、重複は1つにする。
 * 知らない名前・空はエラーの文を返す（黙って無視しない）
 */
export function parseProducts(value: string | undefined): { products: Product[] } | { error: string } {
  if (value === undefined) return { products: [...DEFAULT_PRODUCTS] };
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return { error: `--products に製品を指定してください（${PRODUCTS.join(" / ")} をカンマ区切りで）` };
  const unknown = names.filter((n) => !isProduct(n));
  if (unknown.length) return { error: `知らない製品です: ${unknown.join(", ")}（この p3 に入っているのは ${PRODUCTS.join(" / ")}）` };
  return { products: PRODUCTS.filter((p) => names.includes(p)) };
}
