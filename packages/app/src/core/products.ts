/**
 * アプリが組み込んでいる製品（ビルドのときに決まる。探して読み込む仕組みは作らない）。
 * serve は常に全部の製品（tasks・observer）を起動する（製品ごとの ON/OFF は無い）。/api/mode の products はこの一覧を返す
 */
export const PRODUCTS = ["tasks", "observer"] as const;
export type Product = (typeof PRODUCTS)[number];

/** 以前の p3 serve --products（製品の選択）を付けたときの案内。選択は廃止し、指定を外せば両方を起動する */
export const PRODUCTS_OPTION_REMOVED =
  "--products は使えなくなりました。p3 serve は常に tasks と observer の両方を起動します。--products を外して起動してください";
