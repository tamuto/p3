/**
 * observer の起動状態（CLI の p3 observer status・API の GET /api/observer/status・画面の /observer が同じ形を返す）。
 * 観測データの収集・保存はまだ無い（docs/architecture.md「p3-observer」）。tasks のデータ・登録には触れない
 */
export interface ObserverStatus {
  product: "observer";
  /** 配布の単位（@infodb/p3）の版。tasks と共通 */
  version: string;
  /** 起動の状態。今は動いていれば ready だけ */
  state: "ready";
  /** 観測データの保存先（予定は各プロジェクトの .p3/observer/。今は何も保存しないので null） */
  dataDir: null;
}

/** 画面のページ（入口のルート一覧に付く）。tasks のページ（/・/requests/...・/projects/<名前>/...）と重ならない */
export const OBSERVER_PAGE = "/observer";
/** API の接頭辞（入口の serve が /api の下に付ける） */
export const OBSERVER_API = "/api/observer";

export const isObserverPath = (pathname: string): boolean => pathname === OBSERVER_PAGE || pathname.startsWith(`${OBSERVER_PAGE}/`);
