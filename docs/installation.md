# 導入ガイド

infodb p3（以下 P3）を入れて、最初の Preflight を動かせる状態にするまでの手順。要望を作ってからの使い方は
[使い方ガイド](how-to-use.md) へ続く。

P3 の Preflight は、Codex を **Docker のコンテナの中で** 動かす。導入でつまずくのはほとんどが Docker とパスの対応なので、
この文書はそこを詳しく書く。

## 全体の流れ

| # | すること | 終わったと分かる目安 |
| --- | --- | --- |
| 1 | 必要なものをそろえる | `node -v` が 22 以上、`git --version`、`docker version` が通る |
| 2 | どこで P3 を動かすか決める（ホスト / DevContainer） | 下の「動かす場所」のどちらかに当てはまる |
| 3 | Docker に繋がるか確かめる | `docker version` に **Client と Server の両方** が出る |
| 4 | プロジェクトを作る（か参加する） | `p3 whoami` にプロジェクトとデータのフォルダが出る |
| 5 | （DevContainer のときだけ）パスの対応を書く | `p3 user-config` の `codex.pathMap` に、リポジトリとデータの両方の対応がある |
| 6 | ChatGPT に接続する | `p3 chatgpt status` が「ChatGPT プランを使います」 |
| 7 | Codex のイメージを作る | `p3 codex update` が「Codex を更新しました: codex-cli …」 |
| 8 | 画面を開いて、試しに Preflight を動かす | 評価とタスク案が出る |

## 1. 必要なもの

| もの | 何に使う | 確かめ方 |
| --- | --- | --- |
| Node.js 22 以上 | P3 本体（CLI と `p3 serve`） | `node -v` |
| pnpm（`pnpx`）か npm（`npx`） | P3 を入れずに動かす。`pnpm add -g @infodb/p3` / `npm i -g @infodb/p3` で `p3` コマンドにしてもよい | `pnpm -v` / `npm -v` |
| Git | 管理したいリポジトリと、要望ごとのブランチ。Preflight の Codex も履歴を読む | `git --version` |
| Docker（CLI とデーモン） | Preflight の Codex を、リポジトリとデータのフォルダだけを見せたコンテナの中で動かす。画面イメージの描画にも使う | `docker version`（下の 3.） |
| ChatGPT のアカウント（プラン） | Preflight の Codex をその人のアカウントで動かす | 6. で接続する |

- Codex をこのマシンに入れる必要はない（コンテナのイメージに入れる）。画面はビルド済みのものが入っているので、ビルドも要らない
- P3 そのものを開発するときは Node 24 を使う（[開発ガイド](development.md)）。使うだけなら 22 以上でよい
- 以下の例では `p3` と書く。入れていなければ `pnpx @infodb/p3`（または `npx @infodb/p3`）に読み替える

## 2. 動かす場所

P3 が Codex のコンテナを作るとき、リポジトリとデータのフォルダを **Docker のデーモンから見たパス** でマウントする。
そのため、次の3つのパスを区別する。

| パス | 例 | 説明 |
| --- | --- | --- |
| P3 から見たパス（このマシンのパス） | `/workspaces/myapp` | `p3` を動かしている場所でのパス。個人設定に登録する |
| Docker のデーモン（ホスト）から見たパス | `/home/me/workspaces/myapp` | コンテナを作るのはデーモンなので、マウントはこのパスで指定する |
| Codex のコンテナの中のパス | `/workspace/myapp`、`/data` | 参照先は `/workspace/<名前>`（読むだけ）、データのフォルダは `/data` |

動かし方は2通りある。

- **A. ホストで直接動かす**（Mac・Linux・WSL の中で `p3` を実行し、Docker も同じ環境のもの）: 1つ目と2つ目のパスが同じなので、
  パスの対応は要らない
- **B. VS Code の DevContainer の中で動かし、Docker はホストのデーモンを使う**（docker-outside-of-docker）: 1つ目と2つ目の
  パスが違うので、5. でその対応（`codex.pathMap`）を書く。データのフォルダも、ホストから見える（バインドマウントされた）場所に置く

> Docker Desktop・WSL・リモートの Docker（`DOCKER_HOST` で別のマシンを指す）では、パスの見え方がさらに違うことがある。
> この文書の手順は A と B（VS Code の DevContainer と、そのホストの Docker）で書いている。ほかの形では、「Docker のデーモンから
> 見たパス」を自分の環境で確かめてから 5. の対応を書く。

## 3. Docker に繋がるか確かめる

```bash
docker version --format 'Client {{.Client.Version}} / Server {{.Server.Version}}'
# Client 29.8.2 / Server 29.3.0      ← 両方出れば繋がっている
```

| 出たもの | 意味と次にすること |
| --- | --- |
| `docker: command not found` | Docker の CLI が無い。Docker Desktop か Docker Engine を入れ、`PATH` を確かめる。DevContainer なら、CLI を入れる設定（docker-outside-of-docker の feature など）を足す |
| Server の行が無い・`Cannot connect to the Docker daemon` | デーモンに繋がらない。Docker を起動する。繋ぎ先は `docker context ls`（`*` が今のもの）と環境変数 `DOCKER_HOST` で確かめる。DevContainer なら、ホストのソケット（`/var/run/docker.sock`）が渡っているか |
| `permission denied ... docker.sock` | ソケットを使う権限が無い。Linux なら利用者を `docker` グループに入れ直してログインし直す（または管理者に相談する） |

## 4. プロジェクトを作る（か参加する）

管理したいリポジトリの中で `p3 init` を実行し、プロジェクト名と **データを置くフォルダ** を決める。データのフォルダの既定は
**リポジトリのルートの `.p3`**（git のメインの作業ツリーの直下。サブフォルダや要望の作業ツリーから実行してもそこ。git 管理外なら
実行した場所の `.p3`）で、ふつうはこのまま Enter で決める。

公開できない要望を含むときや、複数のリポジトリにまたがるプロジェクトをどのリポジトリとも別に管理したいときは、リポジトリの外の
フォルダを指定する（例: `~/p3-data/myapp`。チームで共有するなら同期するフォルダ）。相対パスは実行した場所から、`~` はホームから。
DevContainer で外に置くときは、ホストから見える（バインドマウントされた）場所にする。

```bash
cd ~/src/myapp
p3 init --agents
#   プロジェクト名（切り替えに使う短い名前） [myapp]:
#   データを置くフォルダ（相対パスは今いる場所から。リポジトリの外も指定できます） [/home/me/src/myapp/.p3]:
#   何を作っているプロジェクトか（Preflight の前提になります）: 社内向けの経費精算アプリ
#   最初に読むドキュメント（カンマ区切り。Preflight が評価の前に読みます） [docs, README.md]:
#   Preflight で重視する観点・制約（任意）: 個人情報を扱う変更は必ずリスクに挙げる

# AI やスクリプトからは引数で（--yes で質問しない。--dir を付けなければリポジトリのルートの .p3）
p3 init --yes --agents --project myapp --description "社内向けの経費精算アプリ"

# リポジトリの外に置くなら --dir で指定する
p3 init --yes --agents --project myapp --dir ~/p3-data/myapp --description "社内向けの経費精算アプリ"
```

- データのフォルダには `project.yaml` と空の `requests/` ができる。このリポジトリは **本体の参照先**（Preflight が読むリポジトリ。
  最初に読む・作業先にできる）として登録される
- 既にあるデータのフォルダ（ほかの人が作って共有したもの）を指したときは、作らずに **参加** だけする（データは書き換えない）。
  リポジトリの `.p3` に入れて共有しているなら `p3 init` だけで、リポジトリの外のフォルダなら `--dir <そのフォルダ>` を付ける
- 既定の `.p3` を git に入れるか（`.gitignore` に書くか）は自分で決める。p3 は `.gitignore` を書き換えず、データをコミットもしない
- `--agents` を付けると、AI エージェント向けの使い方を `AGENTS.md`（無ければ `CLAUDE.md`）に追記し、同じスキルを
  `.claude/skills/p3/SKILL.md`（Claude Code）と `.agents/skills/p3/SKILL.md`（Codex）に置く。置いたファイルはリポジトリに入れて共有する。
  登録済みのリポジトリでも `p3 init --agents --project <名前> --dir <データのフォルダ>`（ルートの `.p3` なら `--dir` は省ける）をもう一度実行すれば、登録はそのままで足りない方だけを置く
- 登録はこのマシンの **個人設定**（`~/.config/infodb-p3/config.yaml`。`XDG_CONFIG_HOME` があればその下。共有しない）に入る

確かめる:

```bash
p3 whoami
# プロジェクト  myapp  /home/me/src/myapp/.p3
# 決まり方      cwd（今いる場所）
# 今いる参照先  myapp  ブランチ main
# 変更者        human:<git の user.name>
# 要望          （なし）
```

プロジェクトが決まらないと、登録済みの一覧と選び方（`--project <名前>`）が出る。リポジトリの外で使うときや、複数のプロジェクトに
参加しているときに起きる。

登録が1つだけのうちは、関係ないフォルダでも `whoami` が成功する（決まり方が `only`）。これは書き込み先が決まったという意味ではない。
そのとき読むだけのコマンドは警告を出して動き、要望の登録などの変える操作は止まる。変えるときは、リポジトリかデータのフォルダの中に
移るか、プロジェクトを明示する:

```bash
cd ~/src/myapp && p3 request new "通知"         # リポジトリの中で
p3 --project myapp request new "通知"           # どこからでも、明示して
```

ほかのリポジトリ（ドキュメント・基盤など）も Preflight に読ませたいときは
[使い方ガイド](how-to-use.md#参照先と作業先) の「参照先と作業先」。

## 5. パスの対応を書く（DevContainer のときだけ）

ホストで直接動かす（2. の A）なら飛ばしてよい。

### 5-1. ホストから見たパスを調べる

DevContainer の中の `docker` はホストのデーモンに繋がっているので、中から自分のコンテナのマウントを調べられる。

```bash
docker ps --format '{{.ID}}  {{.Names}}'        # 自分のコンテナを探す（VS Code が付けた名前・compose のサービス名など）
docker inspect <コンテナの名前> --format '{{range .Mounts}}{{.Type}}  {{.Source}} → {{.Destination}}{{"\n"}}{{end}}'
# bind    /home/me/workspaces → /workspaces       ← Source がホスト、Destination がコンテナの中
# bind    /mnt/usb/assets → /mnt/assets
# volume  /var/lib/docker/volumes/xxx/_data → /home/me/.cache   ← 名前付きボリューム（下の注意）
```

- コンテナの名前は、ホスト名（`hostname`）と同じとは限らない。分からなければ `docker ps` の一覧から探す
- **リポジトリ** と **データのフォルダ** の両方について、それを含む `Destination` を探す
- `volume` は名前付きボリューム。`Source` はデーモンの中の場所で、ふつうのパスとして別のコンテナにマウントできるとは限らない。
  リポジトリとデータのフォルダは、`bind`（ホストのフォルダ）の下に置く

### 5-2. 対応を書く

左がコンテナの中（P3 から見たパス）、右がホスト（Docker のデーモンから見たパス）。`Destination` ごとに1件。

```bash
p3 user-config set codex.pathMap+=/workspaces=/home/me/workspaces
p3 user-config set codex.pathMap+=/mnt/assets=/mnt/usb/assets     # データのフォルダが別のマウントにあるとき
p3 user-config                                                    # 今の値と出どころ（環境変数 / 個人設定 / 既定）
# codex.pathMap      /workspaces → /home/me/workspaces, /mnt/assets → /mnt/usb/assets
p3 user-config set codex.pathMap-=/mnt/assets                     # 1件外す（codex.pathMap= で全部外す）
```

- 前から順に、境界（`/`）が合う最初の対応を使う。同じ左側をもう一度足すと置き換える
- 書き間違い（`=` が無い、相対パスなど）は、何を直すかを出して何も書かない
- 直したら、serve を起動し直さなくても **次の Preflight から** 効く

## 6. ChatGPT に接続する

Preflight の Codex は、各自の ChatGPT アカウント（プラン）で動く。サインインは P3 が行う（Codex の初期設定は要らない）。

```bash
p3 chatgpt login          # ブラウザが開き、ChatGPT にサインインしてプランの利用に同意する（127.0.0.1:1455 で待つ）
p3 chatgpt status
# me@example.com  ChatGPT プランを使います  トークンの期限 2026-10-12 20:57（使うときに更新）
```

- **DevContainer:** VS Code が待ち受けのポート（1455）をホストへ転送するので、ホストのブラウザから戻ってこられる
- **ブラウザが「接続できません」になる**（1455 が使えずに別のポートで待った・転送されない環境（SSH・別のコンテナ）など）:
  `p3 chatgpt login --paste` で、その「接続できません」の画面のアドレスバーの URL をそのまま貼る
- 画面の「設定」→「個人」の「Continue with ChatGPT」でも同じことができる。ただし **P3 を動かしているマシンのローカルの画面からだけ**
  （LAN の別のマシンや、`docker run -p` で公開した画面からは断る。そのときは CLI を使う）
- 接続はこのマシン・この人のもので、どのプロジェクトにも属さない。トークンは `~/.config/infodb-p3/chatgpt.json`（所有者だけが
  読める）に置き、CLI の出力・画面・ログには出さない。個人設定（`config.yaml`）とは別のファイル
- 解除は `p3 chatgpt logout`（ChatGPT 側の取り消しも行う）。`--forget` でこのマシンの登録ごと消す

## 7. Codex のイメージを作る

```bash
p3 codex update
# Codex のイメージ llmcs-codex-workspace:local を作り直しています（最新の Codex を入れます。数分かかることがあります）
# Codex を更新しました: codex-cli 0.162.1（変わらず。これが最新）
#   イメージ llmcs-codex-workspace:local（2026-10-13 05:08:07 作成）
```

- 初回は数分かかる（ネットワークから Codex を入れる）。プロジェクトの登録やサインインは要らない
- しなくても、最初の Preflight の前に自動で作る。その後も、作ってから1日より古ければ Preflight の前に作り直す
  （止めるなら `p3 user-config set codex.ensureImage=false`）
- 画面イメージの描画のイメージ（`infodb-p3-render`）は、最初に画面イメージを描くときに作る（`p3 render update` で今すぐ）

## 8. 画面を開いて、試しに Preflight を動かす

```bash
p3 serve
# http://localhost:4310 をブラウザで開く
```

- **DevContainer:** 4310 もホストへ転送して、ホストのブラウザで開く
- 既定では `0.0.0.0:4310` で待つ（DevContainer の外から見るため）。画面には認証が無いので、信頼できないネットワークでは
  `p3 user-config set serve.host=127.0.0.1` で絞る。待ち受け（`serve.host` / `serve.port`）を変えたら serve を起動し直す

概要ページの上にエンジンの状態が出る（Codex なら Docker・認証・イメージを確かめ、使えなければ理由を出して実行のボタンを止める）。
ここで問題が無ければ、試しに要望を1件作って Preflight を実行する（[使い方ガイド](how-to-use.md) の 1.〜2.）。

Preflight の実行ログの最初の方に、参照先とデータのフォルダが **コンテナの中のどこに当たったか** が出る:

```text
パスの対応（個人設定の codex.pathMap）:
  参照先 myapp → コンテナ /workspace/myapp（codex.pathMap の対応あり）
  データ → コンテナ /data（codex.pathMap の対応あり）
```

DevContainer で「対応あり」にならなければ 5. を見直す。評価とタスク案が出れば導入は終わり。

## うまくいかないとき

失敗はログとエラーに **次にすること** を添えて出す。直して、もう一度同じ操作をする。

| どこで | 出るもの | 確かめる | 直す |
| --- | --- | --- | --- |
| Preflight・`codex update` | `docker` が無い（ENOENT） | `docker version` | Docker を入れ、`PATH` を確かめる |
| 〃 | `Cannot connect to the Docker daemon` | `docker version` の Server、`docker context ls`、`DOCKER_HOST` | Docker を起動する。繋ぎ先と権限（3.）を直す |
| 〃 | `permission denied ... docker.sock` | `ls -l /var/run/docker.sock` | `docker` グループなど、ソケットの権限を直す |
| Preflight | `bind source path does not exist: <参照先 …>` / `<データ>` | ログの「パスの対応」、`p3 user-config` の `codex.pathMap`、5-1. の `docker inspect` | `p3 user-config set codex.pathMap+=<このマシンのパス>=<ホストのパス>`。「対応あり」なのに無いなら、右側（ホストのパス）の誤り。serve はそのままで次の Preflight から効く |
| Preflight | 「Codex のイメージを用意できません（app-server を起こす前）」 | `p3 codex update` の出力 | ネットワーク（プロキシ）を確かめて `p3 codex update` をやり直す。`Unable to find image` も同じ |
| Preflight・画面 | 「ChatGPT にサインインしてください」「ChatGPT の接続が切れています」「プランの利用が許可されていません」 | `p3 chatgpt status` | `p3 chatgpt login`（届かなければ `--paste`）。プランの利用に同意する |
| Preflight | 「Usage limit reached」 | ChatGPT の Manage usage（https://chatgpt.com/settings/usage） | 上限が戻るのを待つ |
| Preflight・画面 | 個人設定を読めない（YAML の行と直すファイル） | `~/.config/infodb-p3/config.yaml` | 書き間違いを直す。serve はそのままで次の Preflight から効く |
| CLI | プロジェクトが決まらない | `p3 whoami`、`p3 project` | `--project <名前>`、または `p3 project add <名前> <フォルダ>` |
| CLI・serve | 「データのフォルダがありません」「データのフォルダに project.yaml がありません」 | `p3 project ls` の登録先、フォルダを移していないか、共有ドライブ（同期するフォルダ）がつながっているか | つながっていなければつないでやり直す。移したなら `p3 project rm <名前>` → `p3 project add <名前> <正しいフォルダ>`（rm はデータを消さない。そのあと `p3 repo path` で手元のリポジトリを登録し直す）。新しく作るなら管理したいリポジトリの中で `p3 init --project <名前>`（外に置くなら `--dir <フォルダ>`） |
| 画面 | 開けない | serve のログ、ポートの転送 | 4310 を転送する。`serve.port` を変えたら転送先も変える |

## 設定の決まり

マシン（と人）ごとの設定は、プロジェクトのデータではなく個人設定に置くか、環境変数で渡す。`.env` は読まない。
値は項目ごとに **CLI の明示（`--port` / `--host` / `--engine`）→ 環境変数 → 個人設定 → 既定値** の順で決まる
（環境変数を空にすると既定値に戻す）。

| 個人設定 | 環境変数 | 内容 | 効くとき |
| --- | --- | --- | --- |
| `codex.pathMap` | `P3_CODEX_PATH_MAP`（`a=b,c=d`） | このマシンのパス → Docker のデーモンから見たパス | 次の Preflight |
| `codex.auth` | `P3_CODEX_AUTH` | `auto`（既定。ChatGPT に接続していればそれ）/ `legacy`（下の旧来の認証） | 次の Preflight |
| `codex.authVolume` / `codex.authFile` | `P3_CODEX_AUTH_VOLUME` / `P3_CODEX_AUTH_FILE` | 旧来の認証の `auth.json` の置き場所 | 次の Preflight |
| `codex.model` / `codex.effort` | `P3_CODEX_MODEL` / `P3_CODEX_EFFORT` | モデル・推論の深さ（省けば Codex の既定） | 次の Preflight |
| `codex.ensureImage` | `P3_CODEX_ENSURE_IMAGE`（`0` / `1`） | Preflight の前のイメージの作り直し（1日ごと） | 次の Preflight |
| `preflight.engine` | `P3_PREFLIGHT_ENGINE` | `mock` にすると Mock で評価する（下の補足） | 次の Preflight |
| `serve.host` / `serve.port` | `P3_HOST` / `P3_PORT` | `p3 serve` の待ち受け（既定 `0.0.0.0` / `4310`） | serve を起動し直したとき |
| `ui.theme` | — | 画面のテーマ（`system` / `light` / `dark`） | 画面を読み直したとき |

`p3 user-config` で全部の値と出どころを見て、`p3 user-config set キー=値` で変える（`キー=` で消す）。コメントとほかの項目は残る。
環境変数は serve を起動したときのものが使われる。

## 補足: 旧来の認証と Mock

ふだんは使わない。

- **旧来の認証**（ChatGPT に接続せず、Codex でサインインした `auth.json` を使う）: P3 のイメージの中の Codex でサインインして
  Docker のボリュームに置く（`codex.authVolume`）か、ホストの `~/.codex/auth.json` を Docker のホストから見たパスで書く
  （`codex.authFile`。`codex.pathMap` は効かない）。ChatGPT に接続していればそちらが優先され、接続したまま使うなら `codex.auth=legacy`

  ```bash
  docker volume create codex-state
  docker run --rm -it --entrypoint codex -v codex-state:/codex llmcs-codex-workspace:local login --device-auth
  p3 user-config set codex.authVolume=codex-state
  ```

- **Mock**: 要望本文の箇条書きをそのままタスク案にするだけの簡易評価。Codex を使えない環境で、画面とファイルの流れを
  確かめるためのもの（評価の質は確かめられない）。`--engine mock` か `preflight.engine=mock` を明示したときだけ使い、
  認証が無いときに自動で Mock に切り替えることはない

設計の背景（なぜコンテナで動かすか・サインインの仕組み）は [docs/architecture.md](architecture.md) と
[docs/chatgpt-sign-in.md](chatgpt-sign-in.md)。
