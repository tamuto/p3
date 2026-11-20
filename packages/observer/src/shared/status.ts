/**
 * observer の起動状態（CLI の p3 observer status・API の GET /api/observer/status・画面の /observer が同じ形を返す）。
 * 観測の定義の登録はプロジェクトごと（definition.ts）。起動状態はプロジェクトを決めずに返す（docs/architecture.md「p3-observer」）
 */
export interface ObserverStatus {
  product: "observer";
  /** 配布の単位（@infodb/p3）の版。tasks と共通 */
  version: string;
  /** 起動の状態。今は動いていれば ready だけ */
  state: "ready";
  /** 起動状態はプロジェクトを決めないので null（観測の定義の保存先は定義の一覧の target） */
  dataDir: null;
  /** この serve の製品（API のときだけ。入口が取り付けた製品を渡す。CLI には無い） */
  products?: string[];
}

/** API の接頭辞（入口の serve が /api の下に付ける） */
export const OBSERVER_API = "/api/observer";

/** 観測の定義の登録先（入口が解決したプロジェクト。dataDir はそのデータのフォルダ） */
export interface DefinitionTarget {
  /** 個人設定に登録したプロジェクトの名前（分からなければ省く） */
  project?: string;
  dataDir: string;
}
