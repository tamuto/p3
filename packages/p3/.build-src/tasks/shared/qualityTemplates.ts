import type { QualityTemplate } from "./quality.ts";

/**
 * 同梱の品質基準のテンプレート（版つきの例）。業界の標準への認証ではない。採用すると project.yaml に編集できる実体として写す。
 * 中身を変えるときは版を上げて新しい項目として足す（採用済みのプロジェクトの内容は変わらず、差分を見て明示して当てる）。
 * コマンドは例で、P3 は実行しない。CI・特定の製品・フォルダ名を必須にしない
 */
export const QUALITY_TEMPLATES: readonly QualityTemplate[] = [
  {
    id: "basic",
    version: 1,
    title: "共通の基本",
    description: "どの言語でも使える最低限の水準（規約・構成と依存の向き・検証・文書の更新）",
    items: [
      { key: "conventions", text: "プロジェクトのコーディング規約（命名・書式・エラーの扱い）に従う", check: { kind: "manual", reference: "規約の文書（例: docs/development.md）と照らして確かめる" } },
      { key: "structure", text: "決めたフォルダの構成と依存の向きを崩さない（下の層から上の層を参照しない）", check: { kind: "manual", reference: "構成・依存の向きの文書と、変えたファイルの import を確かめる" } },
      { key: "verification", text: "変更に見合う自動テストを足し、プロジェクトの検証をすべて通してから完了にする", check: { kind: "manual", reference: "検証の手順（例: README・docs の「テスト」）を実行した結果を証拠に残す" } },
      { key: "docs", text: "使い方・設計が変わったら、同じ変更で文書を直す", check: { kind: "manual", reference: "変えた振る舞いを説明している文書の箇所を確かめる" } },
    ],
  },
  {
    id: "typescript",
    version: 1,
    title: "TypeScript の例",
    description: "TypeScript のプロジェクトでよく使う機械の検査（コマンドはプロジェクトに合わせて直す）",
    items: [
      { key: "typecheck", text: "型検査が通る", check: { kind: "machine", command: "npm run typecheck（例: tsc --noEmit）", success: "終了コード 0・エラーなし" } },
      { key: "lint", text: "lint が警告なしで通る", check: { kind: "machine", command: "npm run lint", success: "終了コード 0・警告なし" } },
      { key: "test", text: "自動テストが通る", check: { kind: "machine", command: "npm test", success: "終了コード 0・失敗なし" } },
      { key: "build", text: "ビルドが通る", check: { kind: "machine", command: "npm run build", success: "終了コード 0" } },
    ],
  },
];
