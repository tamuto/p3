# 公開の手順（@infodb/p3）

P3 を npm に `@infodb/p3` として公開するときのチェックリスト。npm への公開とタグ付けは人が行う。
CI は使わず、手元で確かめてから公開する。

## 1. 外部のパッケージ

- [ ] P3 が使う llmcs の部品（`@infodb/codex-workspace`・`@infodb/chatgpt-plan`）の必要な版が npm に公開されている
  （`npm view @infodb/codex-workspace versions`）。llmcs を変えたら、llmcs 側で先に公開し、P3 の版の範囲を上げる
- [ ] 依存の版が公開から1日を過ぎている。pnpm の `minimumReleaseAge`（既定 1日）より新しい版は、新しいチェックアウトで
  `pnpm install` が `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` で止まる。待たずに入れる例外（`minimumReleaseAgeExclude`）は
  自分たちの `@infodb/*` の部品を版で固定したものだけ（[docs/architecture.md](architecture.md) の「llmcs の部品の依存」。
  `test/package.test.ts` が確かめる）。1日を過ぎた版の例外は、公開の前に外す
- [ ] `package.json` と `pnpm-lock.yaml` に手元のフォルダへのリンク（`link:` / `file:`）が無い（`test/package.test.ts`）

## 2. クリーンな依存の解決と検査

```bash
git clone <このリポジトリ> /tmp/p3-release && cd /tmp/p3-release   # 隣に llmcs が無い場所で
pnpm install --frozen-lockfile
pnpm -s check                                                    # 型検査・lint・テスト・画面のビルド・UI テスト
```

## 3. 配布物の確認

```bash
node scripts/verify-pack.mjs --docker     # npm pack → 実行時の依存だけで別の場所に入れて動かす（pnpm verify:pack でも同じ）
```

- [ ] 全段が `ok`。確かめる段: Node の版と engines / tarball の中身 / `npm install`（開発用の依存が入らない）/
  別のリポジトリで `init --agents`・`init --agents codex` と `p3 agents`（後から足す・`--force`）・`whoami`・要望の作成・Mock の Preflight・メモを足した再評価・`serve`（画面・資産・API）/
  `codex update`（`--docker`。未登録・未認証のまま本物の Docker でイメージを作り直し、版を読む）
- [ ] 下限の Node でも通す: `PATH=$(dirname $(npx -y node@22.0.0 -e "console.log(process.execPath)")):$PATH node scripts/verify-pack.mjs`
- [ ] Docker が無い環境で確かめたときは、`codex update` の段が「実行していない」と出る。その場合は Docker のある環境で
  `--docker` を付けて通すまで、公開に進まない

## 4. 公開する中身

- [ ] `npm pack --dry-run` の一覧に `.env`・個人設定・デモデータ・テスト・開発用のスキル（`.claude/`）が無い
- [ ] `npm pack --dry-run` の一覧に README から辿る文書（`docs/`）とそのリンクの先がある（`test/package.test.ts`）。README と docs/ の
  相対リンクと節のアンカーが解決する（`test/docs.test.ts`）
- [ ] 公開するリポジトリと tarball に、環境に固有のパス・個人の情報が無い。例は `~/p3-data/myapp`・`/home/me/...`・
  `/workspaces`（DevContainer の慣例）のような汎用のものにする。コンテナの中の `/workspace`（リポジトリ）と `/data`
  （データのフォルダ）は Codex のコンテナとの約束なので残す
- [ ] `package.json` の `repository` / `homepage` / `bugs` が実際の公開先を指している（リポジトリを公開してから確かめる）
- [ ] 版を上げた（`package.json` の `version`）

## 5. 公開（人が行う）

```bash
npm login                 # @infodb のスコープに公開できるアカウント
npm publish               # prepack で画面をビルドする。publishConfig.access は public
```

公開した後に、別の環境で `pnpx @infodb/p3 --help` が動くことを確かめる（その版も公開から1日は pnpm の既定では入らない。
`npx @infodb/p3` か、`pnpm dlx --config.minimum-release-age=0 @infodb/p3` で確かめる）。

## 履歴の確認（2026-10-11、0.1.0 の準備のとき）

公開の前に Git の履歴（全ブランチ・63 コミット）を確かめた。

- 秘密の値（API キー・トークン・JWT・秘密鍵・npm / GitHub のトークン・`refresh_token`）: 見つからなかった
- 秘密のファイル（`.env`・`auth.json`・`chatgpt.json`・鍵）: 追跡されたことは無い（以前は値の無い例の `.env.example` だけを追跡していたが、P3 は `.env` を読まないので消した）
- 個人の情報: コミットの作成者のメールアドレス（全コミット。Git の通常の記録）と、初期のコミットの README・デモの例に
  同じメールアドレスがあった（今のファイルには無い）。履歴は書き換えていない。公開してよいかは持ち主が判断する
