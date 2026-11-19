# 公開の手順（@infodb/p3）

P3 を npm に `@infodb/p3` として公開するときのチェックリスト。npm への公開とタグ付けは人が行う。
CI は使わず、手元で確かめてから公開する。Docker のイメージ（Docker Hub の `tamuto/p3`）も同じ版で出す（6.）。

リポジトリは pnpm workspace で、公開するのは入口のパッケージ `@infodb/p3`（`packages/p3`）の1つだけ。kit・製品
（`@infodb/p3-kit`・`@infodb/p3-tasks`・`@infodb/p3-observer`）は公開せず、ビルドして同梱する。ルートの `package.json`（`p3-workspace`）は開発用で公開しない。

| | 開発（チェックアウト） | 公開する中身（`dist/package`） |
| --- | --- | --- |
| manifest | ルートの `package.json`（scripts・開発用の依存）と `packages/*/package.json`（入口は workspace の `@infodb/p3-kit`・製品を devDependencies に持つ） | `packages/p3/package.json` から devDependencies（workspace の参照）と scripts を外したもの（`scripts/build-cli.mjs` が作る） |
| 版 | 全部の manifest（ルート・入口・tasks・observer・kit）を同じ版にする（`test/package.test.ts`） | 入口の版 |
| 中身 | ソース（`packages/*/src`）を tsx で動かす | 入口の `bin/`・`lib/`（tasks は `lib/tasks/`、observer は `lib/observer/`、kit は `lib/kit/` に同梱）・`dist/web`、ルートの `skills/`・`docs/`・README・LICENSE |
| 作り方 | `pnpm install` | `pnpm build`（`vite build` と `scripts/build-cli.mjs --require-web`）→ `npm pack ./dist/package` / `npm publish ./dist/package` |

### 版と Git タグの対応

1つの版は1つのコミットに対応し、npm・Docker・Git のタグはすべて同じ版の番号を使う（同梱する内部パッケージごとに別の版やタグを付けない）。

| 版 `<版>` を出すとき | 対応するもの |
| --- | --- |
| Git | タグ `v<版>`（リリースのブランチをマージしたコミット。4 つの manifest の `version` が `<版>`） |
| npm | `@infodb/p3@<版>`（そのコミットの `pnpm build` の後の `dist/package`） |
| Docker Hub | `tamuto/p3:<版>` と `latest`（同じコミットの Dockerfile。中の p3 は npm に出すのと同じ tarball） |

ある版の配布物を作り直して確かめるときは、タグを指定してクリーンに取り出し、2.・3.・6. のスモークを通す:

```bash
git clone --branch v<版> <このリポジトリ> /tmp/p3-v<版> && cd /tmp/p3-v<版>   # 隣に llmcs が無い場所で
pnpm install --frozen-lockfile && pnpm -s check
node scripts/verify-pack.mjs --docker            # npm の tarball（DevContainer では --render-dir と P3_CODEX_PATH_MAP）
node scripts/verify-docker.mjs                   # 同じコミットから作った Docker のイメージ（既定の複数プロジェクトの起動と、明示した1つのプロジェクトの起動）
```

内部パッケージ（`packages/*` の kit・tasks・observer など）を足しても、公開するのは入口の `@infodb/p3` と `tamuto/p3` だけで、上の手順は変わらない。
変わるのは同梱の対象と検査の一覧（`scripts/build-cli.mjs`・`Dockerfile`・`scripts/verify-pack.mjs` の tarball の中身・`test/pack.test.ts`・`test/package.test.ts` の版の同期）で、
足すときはそれらを同じ変更で直す。

## 1. 外部のパッケージ

- [ ] P3 が使う llmcs の部品（`@infodb/codex-workspace`・`@infodb/chatgpt-plan`）の必要な版が npm に公開されている
  （`npm view @infodb/codex-workspace versions`）。llmcs を変えたら、llmcs 側で先に公開し、P3 の版の範囲を上げる
- [ ] 依存の版が公開から1日を過ぎている。pnpm の `minimumReleaseAge`（既定 1日）より新しい版は、新しいチェックアウトで
  `pnpm install` が `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` で止まる。待たずに入れる例外（`minimumReleaseAgeExclude`）は
  自分たちの `@infodb/*` の部品を版で固定したものだけ（[docs/architecture.md](architecture.md) の「llmcs の部品の依存」。
  `test/package.test.ts` が確かめる）。1日を過ぎた版の例外は、公開の前に外す
- [ ] どの `package.json`（ルート・`packages/*`）にも手元のフォルダへのリンク（`link:` / `file:`）が無く、`pnpm-lock.yaml` のリンクは workspace の
  自分たちのパッケージ（`../kit`・`../tasks`・`../observer`）だけ。workspace の参照は `@infodb/p3-kit`・`@infodb/p3-tasks`・`@infodb/p3-observer` だけ（`test/package.test.ts`）

## 2. クリーンな依存の解決と検査

```bash
git clone <このリポジトリ> /tmp/p3-release && cd /tmp/p3-release   # 隣に llmcs が無い場所で
pnpm install --frozen-lockfile
pnpm -s check                                                    # 境界と層・型検査・lint・テスト・画面のビルド・UI テスト
```

## 3. 配布物の確認

```bash
node scripts/verify-pack.mjs --docker     # pnpm build → npm pack ./dist/package → 実行時の依存だけで別の場所に入れて動かす（pnpm verify:pack でも同じ）
```

- [ ] 全段が `ok`。確かめる段: Node の版と engines / tarball の中身（入口・同梱した tasks と kit・画面・skills・docs。ソースは入らない）/
  `npm install`（開発用の依存・tsx・esbuild・公開しない `@infodb/p3-tasks`・`@infodb/p3-observer`・`@infodb/p3-kit` が入らず、入れた manifest と実行時の import に
  workspace のパッケージ・チェックアウトの参照が残らない）/ pnpm で入れてもビルドのスクリプトの許可を聞かない /
  別のリポジトリで `init --agents`・`init --agents codex` と `p3 agents`（後から足す・`--force`）・`whoami`・要望の作成・Mock の Preflight・メモを足した再評価・`serve`（画面・資産・API）/
  `codex update`（`--docker`。未登録・未認証のまま本物の Docker でイメージを作り直し、版を読む）
- [ ] 公開の前に、作った tarball をチェックアウトの外で npm と pnpm の一時実行でも動かす（入れずに動かす経路。登録の前の guide が版を返す）:
  `npm exec --yes --package <作った tarball> -- p3 guide --json`・`pnpm dlx --config.minimum-release-age=0 --package <作った tarball> p3 guide --json`
- [ ] 下限の Node（24.0.0）でも、作った tarball で通す（開発用の依存のインストールとビルドは下限の版で要らない）:
  `PATH=$(dirname $(npx -y node@24.0.0 -e "console.log(process.execPath)")):$PATH node scripts/verify-pack.mjs --tgz <作った tarball>`
- [ ] Node の下限を上げた版を出すときは、リリースノートに知らせる: 前の下限の Node では、npm は警告を出して入れ（`engine-strict` なら断る）、
  pnpm・`pnpx` は警告を出さずに入れる（止められない）ので、利用者が `node -v` を確かめること、
  Node を上げて入れ直すこと、Docker のイメージは pull してコンテナを作り直すこと（Node 22 → 24 以上は [導入ガイド](installation.md#補足-nodejs-の版と同じ版で動かすこと) の「Node 22 から上げるとき」）
- [ ] Docker が無い環境で確かめたときは、`codex update` の段が「実行していない」と出る。その場合は Docker のある環境で
  `--docker` を付けて通すまで、公開に進まない

## 4. 公開する中身

- [ ] `pnpm build` の後の `npm pack ./dist/package --dry-run` の一覧に `.env`・個人設定・デモデータ・テスト・ソース（`packages/`・`src/`）・
  開発用のスキル（`.claude/`）が無い（`test/pack.test.ts`）
- [ ] その一覧に README から辿る文書（`docs/`）とそのリンクの先がある（`test/pack.test.ts`）。README と docs/ の相対リンクと節のアンカーが
  解決する（`test/docs.test.ts`）
- [ ] 公開するリポジトリと tarball に、環境に固有のパス・個人の情報が無い。例は `~/p3-data/myapp`・`/home/me/...`・
  `/workspaces`（DevContainer の慣例）のような汎用のものにする。コンテナの中の `/workspace`（リポジトリ）と `/data`
  （データのフォルダ）は Codex のコンテナとの約束なので残す
- [ ] `packages/p3/package.json` の `repository` / `homepage` / `bugs` が実際の公開先を指している（リポジトリを公開してから確かめる）
- [ ] 版を上げた（ルートと `packages/*`（p3・tasks・observer・kit）の `package.json` の `version` を同じ版に）

## 5. 公開（人が行う）

```bash
npm login                          # @infodb のスコープに公開できるアカウント
pnpm build                         # 画面と CLI・serve をビルドし、公開する中身を dist/package に組み立てる
npm publish ./dist/package         # 入口の @infodb/p3 だけを出す。publishConfig.access は public（kit・製品は同梱済みで出さない）
```

公開した後に、別の環境で `pnpx @infodb/p3 --help` が動くことを確かめる（その版も公開から1日は pnpm の既定では入らない。
`npx @infodb/p3` か、`pnpm dlx --config.minimum-release-age=0 @infodb/p3` で確かめる）。

## 6. Docker Hub（tamuto/p3）

イメージの中の p3 は、そのときのチェックアウトから npm に出すのと同じ中身（`pnpm build` の後の `npm pack ./dist/package` の tarball）で作る
（npm から取らない）。実行時の依存は、workspace の lockfile のまま入口の分だけを `pnpm --filter @infodb/p3 deploy --prod` で入れる（入口用の
lockfile で固定する）。npm に公開した版と同じ
コミット（版のタグ `v<版>`）から作り、タグも同じ版にする。ベースの Node はメジャー版だけを指定しているので、`--pull` を付けて
その時点の最新（同じメジャーのセキュリティリリースなど）を取って作る。Node の更新だけを取り込むときも、同じコミットから作り直して
push する（公開済みのイメージ・起動中のコンテナは自動では変わらない）。

- [ ] npm の公開（5.）と同じコミットにいる（`git describe --tags` が `v<版>`、作業ツリーに変更が無い）
- [ ] スモークが全段 ok: `node scripts/verify-docker.mjs --image tamuto/p3:<版>`（DevContainer の中では `--work`・`--network-of auto`・
  `P3_CODEX_PATH_MAP`。[development.md](development.md#docker-のイメージ)）
- [ ] ソケットを渡したコンテナ（root）で Codex のイメージを作れる: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock tamuto/p3:<版> codex update`
- [ ] 本物の Codex（ChatGPT の接続・ソケット）で、コンテナから Preflight が終わる（接続できる環境で手で確かめる）
- [ ] 作るのは `linux/amd64` だけ。arm64 は確かめるマシンが無いので作らない（対応していない）

```bash
V=$(node -p "require('./packages/p3/package.json').version")
docker login                                                   # tamuto に push できるアカウント
docker buildx build --pull --platform linux/amd64 --build-arg P3_VERSION=$V \
  -t tamuto/p3:$V -t tamuto/p3:latest --push .
docker buildx imagetools inspect tamuto/p3:$V                  # 動かす platform が linux/amd64 だけか（unknown/unknown は来歴の記録で、動かす対象ではない）
```

公開した後に、別の環境で `docker run --rm tamuto/p3:<版> --help` と、[導入ガイド](installation.md#docker-で動かすプロジェクトを跨ぐ-serve)
の手順で起動して一覧が出ることを確かめる。Docker Hub の説明（Overview）は導入ガイドの「Docker で動かす」へのリンクにする。

## 履歴の確認（2026-10-11、0.1.0 の準備のとき）

公開の前に Git の履歴（全ブランチ・63 コミット）を確かめた。

- 秘密の値（API キー・トークン・JWT・秘密鍵・npm / GitHub のトークン・`refresh_token`）: 見つからなかった
- 秘密のファイル（`.env`・`auth.json`・`chatgpt.json`・鍵）: 追跡されたことは無い（以前は値の無い例の `.env.example` だけを追跡していたが、P3 は `.env` を読まないので消した）
- 個人の情報: コミットの作成者のメールアドレス（全コミット。Git の通常の記録）と、初期のコミットの README・デモの例に
  同じメールアドレスがあった（今のファイルには無い）。履歴は書き換えていない。公開してよいかは持ち主が判断する
