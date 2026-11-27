/**
 * observer の起動状態（CLI の p3 observer status・API の GET /api/observer/status が同じ形を返す）。
 * 項目キーと値の保存はプロジェクトごと（metric.ts）。起動状態はプロジェクトを決めずに返す（docs/architecture.md「p3-observer」）
 */
export interface ObserverStatus {
  product: "observer";
  /** 配布の単位（@infodb/p3）の版。tasks と共通 */
  version: string;
  /** 起動の状態。今は動いていれば ready だけ */
  state: "ready";
  /** 起動状態はプロジェクトを決めないので null */
  dataDir: null;
  /** この serve の製品（API のときだけ。アプリが取り付けた製品を渡す。CLI には無い） */
  products?: string[];
}

/** 項目キーと値の保存先（入口・アプリが解決したプロジェクト。dataDir はそのデータのフォルダ） */
export interface MetricTarget {
  dataDir: string;
}
