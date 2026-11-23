# 導入ガイド

infodb p3（以下 P3）を使い始めるまでの手順。全部を一度にそろえなくてよい。段階 0 だけで要望とタスクを使い始められ、
段階 1・2 は必要になってから足す。要望を作ってからの使い方は [使い方ガイド](how-to-use.md) へ続く。

| 段階 | すること | できるようになること | 要るもの |
| --- | --- | --- | --- |
| [0](#段階-0-要望とタスクを使う) | プロジェクトに参加する（か新しく作る）・画面を開く | 要望とタスクを書いて進める | Node.js と Git |
| [1](#段階-1-preflight-を足す) | Preflight の評価のしかたを選んで準備する | 要望をタスクにする前に、リポジトリを読んだ評価とタスク案を受け取る | Codex で評価するなら Docker と ChatGPT。手元の AI エージェントで評価するなら足すものは無い |
| [2](#段階-2-必要になったら足す) | 品質基準・レビューなどを、要るものだけ足す | 守る水準の確認・完了したタスクやマイルストーンの確かめ | 機能による（段階 2 の表） |

この文書の例では `npx @infodb/p3` と書く（Node.js に付いてくる npm の `npx`。pnpm があれば `pnpx @infodb/p3` でも同じ）。
`pnpm add -g @infodb/p3` / `npm i -g @infodb/p3` で入れたなら `p3` に読み替える。

## 段階 0: 要望とタスクを使う

**すること**: プロジェクトに参加する（か新しく作る）・画面を開く。**できるようになること**: 要望とタスクを書いて進める。
Docker・ChatGPT・パスの設定は要らない。

要るのは **Node.js 24 以上（推奨 26）** と **Git**（`node -v` と `git --version` で確かめる）。版の補足は後の「[Node.js の版](#補足-nodejs-の版と同じ版で動かすこと)」。

### 参加する（ほかの人が作ったプロジェクト）

共有されたリポジトリを取得してある（`git clone` 済み）なら、3つで始められる。

1. そのリポジトリのフォルダに移る: `cd ~/src/myapp`
2. 参加する: `npx @infodb/p3 join --yes`
3. 画面を開く: `npx @infodb/p3 serve` を実行したまま、ブラウザで http://localhost:4310 を開く

**できたと分かる目安**: ブラウザに、そのプロジェクトの「進捗」（要望の一覧）が出る。

- `join` は、このマシンの個人設定にプロジェクトを登録するだけ。データ（要望・タスク）とリポジトリのファイルは書かない。
  データを取ってくることも、同期することもしない（データはリポジトリの `.p3` なら `git pull` で、共有ドライブなら同期で届く）
- データがリポジトリの外（共有ドライブなど）にあるプロジェクトでは、その場所を指定する: `npx @infodb/p3 join --yes --dir ~/p3-data/myapp`。
  どこにあるかはプロジェクトを作った人に聞く
- 詳しい決まりは後の「[参加の決まり](#参加の決まり)」

### 新しく作る

管理したいリポジトリの中で:

1. `cd ~/src/myapp`
2. 作る: `npx @infodb/p3 init --yes`（リポジトリの `.p3` にデータのフォルダを作り、個人設定に登録する）
3. 画面を開く: `npx @infodb/p3 serve` を実行したまま、ブラウザで http://localhost:4310 を開く

**できたと分かる目安**: ブラウザに「進捗」（まだ要望が無い一覧）と「新しい要望」のボタンが出る。

- できた `.p3` をリポジトリに入れて共有すれば、ほかの人は上の「参加する」で加われる。git に入れるか（`.gitignore` に書くか）は
  自分で決める（p3 は `.gitignore` を書き換えず、データをコミットもしない）
- 作るときの細かい選び方（データをリポジトリの外に置く・何のプロジェクトかを書く・AI 向けの入口を置く）は後の「[作るときに選べること](#作るときに選べること)」。
  後から変えられるので、最初は `--yes` のままでよい

### 画面について

- 既定では `0.0.0.0:4310` で待つ（DevContainer の外から見るため）。画面には認証が無いので、信頼できないネットワークでは
  `npx @infodb/p3 user-config set serve.host=127.0.0.1` で絞る。待ち受け（`serve.host` / `serve.port`）を変えたら serve を起動し直す
- **DevContainer:** 4310 をホストへ転送して、ホストのブラウザで開く
- 開けないときは「[うまくいかないとき](#うまくいかないとき)」

### 作るときに選べること

`init` は対話でも使える（`--yes` を付けなければ聞く）。データのフォルダの既定は **リポジトリのルートの `.p3`**
（git のメインの作業ツリーの直下。サブフォルダや要望の作業ツリーから実行してもそこ。git 管理外なら実行した場所の `.p3`）で、
ふつうはこのまま Enter で決める。

公開できない要望を含むときや、複数のリポジトリにまたがるプロジェクトをどのリポジトリとも別に管理したいときは、リポジトリの外の
フォルダを指定する（例: `~/p3-data/myapp`。チームで共有するなら同期するフォルダ）。相対パスは実行した場所から、`~` はホームから。
DevContainer で外に置くときは、ホストから見える（バインドマウントされた）場所にする。

```bash
cd ~/src/myapp
npx @infodb/p3 init
#   プロジェクト名（切り替えに使う短い名前） [myapp]:
#   データを置くフォルダ（相対パスは今いる場所から。リポジトリの外も指定できます） [/home/me/src/myapp/.p3]:
#   何を作っているプロジェクトか（Preflight の前提になります）: 社内向けの経費精算アプリ
#   最初に読むドキュメント（カンマ区切り。Preflight が評価の前に読みます） [docs, README.md]:
#   Preflight で重視する観点・制約（任意）: 個人情報を扱う変更は必ずリスクに挙げる
#   AI 向けの p3 の使い方（AGENTS.md の節とスキル）を置く先（claude / codex / both） [both]:
```

AI やスクリプトからは引数で（`--yes` で質問しない）。作業に使う AI エージェントで選ぶ:

| 作業に使う AI | コマンド |
| --- | --- |
| Claude Code | `npx @infodb/p3 init --yes --agents claude --description "社内向けの経費精算アプリ"` |
| Codex | `npx @infodb/p3 init --yes --agents codex --description "社内向けの経費精算アプリ"` |
| 両方・決めていない | `npx @infodb/p3 init --yes --description "社内向けの経費精算アプリ"`（`--agents` を省くと both） |

Preflight を Codex でするか、手元の AI エージェントに頼むかは、ここでは選ばない。Codex にサインインしたマシンなら `p3 preflight` が使え、
どのマシンでも AI エージェントに頼める（[段階 1](#段階-1-preflight-を足す)）。例:「Preflight は Codex、作業は Claude Code」なら、上の
Claude Code の行で作り、段階 1 の「Codex で評価する」を準備する。データをリポジトリの外に置くなら `--dir ~/p3-data/myapp` を足す。

- データのフォルダには `project.yaml` と空の `requests/` ができる。このリポジトリは **本体の参照先**（Preflight が読むリポジトリ。
  最初に読む・作業先にできる）として登録される
- `init` は新しく作るだけ。そのフォルダに既にプロジェクト（`project.yaml`）があれば、何も変えずに断って `p3 join` を案内する
- AI エージェント向けの入口（手順は CLI の `p3 guide` から読ませる短い指示）を `AGENTS.md`（無ければ作る。`CLAUDE.md` は変えない）に
  追記し、スキルを `--agents` で選んだ先に置く: `claude` は `.claude/skills/p3/SKILL.md`（Claude Code）、`codex` は `.agents/skills/p3/SKILL.md`（Codex）、`both` は両方
  （省くと both。対話では聞き、Enter は both）。置いたファイルはリポジトリに入れて共有する。
  作った後から置く・最新にするのは `p3 agents`（[使い方ガイド](how-to-use.md#ai-エージェントから使う) の「AI エージェントから使う」。`init --agents` を
  既にあるプロジェクトで実行し直しても置かない）
- 何のプロジェクトか（`description`）を `--yes` で省いたら、後から `p3 config set description="..."` で書ける（Preflight の精度に効く。
  [使い方ガイド: プロジェクトの設定](how-to-use.md#プロジェクトの設定)）
- 登録はこのマシンの **個人設定**（`~/.config/infodb-p3/config.yaml`。`XDG_CONFIG_HOME` があればその下。共有しない）に入る

### 参加の決まり

`p3 join` は、個人設定に「プロジェクト名 → データのフォルダ・このリポジトリのこのマシンのパス」を登録するだけで、
データ（`project.yaml`・要望）とリポジトリのファイル（スキル・`AGENTS.md`）は書かない。
チームで消した AI 向けのファイルが、参加した人の操作で戻ることはない。

```bash
cd ~/src/myapp
npx @infodb/p3 join --yes                                   # リポジトリの .p3 に入れて共有しているとき（既定はルートの .p3）
npx @infodb/p3 join --yes --dir ~/p3-data/myapp             # リポジトリの外のフォルダ（共有ドライブなど）のとき
npx @infodb/p3 join --yes --project myapp                   # このマシンで使う名前を決める（省くとフォルダ名）
```

- データのフォルダの決め方（既定・相対・`~`・絶対、サブフォルダや作業ツリーから実行してもルートの `.p3`）は `init` と同じ。
  端末では聞き、`--yes` か非対話なら引数と既定値で進める
- このリポジトリは、共有の定義にある参照先として登録する: `--repo-name` の名前 → フォルダ名と同じ名前 → 参照先が1つならそれ。
  決まらなければ登録せず、`p3 repo ls` と `p3 repo path <名前> <パス>` を案内する
- データのフォルダが無い・`project.yaml` が無い・壊れている・読めないときは、理由を出して止まり、何も登録しない（作りもしない。
  新しく作るなら `init`）。同じ名前で別のフォルダは断る。同じ参加をもう一度しても何も変えない
- `--agents` と、作るときだけの項目（`--name`・`--description`・`--instructions`）は使えない（共有の定義を変えるなら `p3 config set`）

### 登録を確かめる

```bash
npx @infodb/p3 whoami
# プロジェクト  myapp  /home/me/src/myapp/.p3
# 決まり方      cwd（今いる場所）
# 今いる参照先  myapp  ブランチ main
# 変更者        human:<git の user.name>
# 要望          （なし）
# Preflight     Codex は使えません: ChatGPT にサインインしてください（…）。手元の AI エージェントに「要望 <要望ID> の Preflight をして」と頼めます
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

段階 0 のままでも、Preflight を通さずにタスクを作って進められる（[使い方ガイド: Preflight を通さずにタスクを作る](how-to-use.md#preflight-を通さずにタスクを作る)）。

## 段階 1: Preflight を足す

**すること**: Preflight の評価のしかたを準備する。**できるようになること**: 要望をタスクにする前に、リポジトリと過去の経緯を
読んだ評価と、着手できる粒度のタスク案を受け取る。

### どちらで評価するか

設定は無い。どちらも使える。このマシンで Codex を使えるかは `npx @infodb/p3 whoami` の Preflight の行に出る。

| 評価するもの | 頼み方 | 要る準備 |
| --- | --- | --- |
| Codex | 人が `p3 preflight <要望ID>` か画面から実行する | Docker と ChatGPT のアカウント（プラン）。下の「[Codex で評価する](#codex-で評価する)」 |
| 手元の AI エージェント（Claude Code・Codex など） | チャットで「要望 261009-k7m3x の Preflight をして」と頼む | 足すものは無い（`init` が置いた入口で動く） |

- 手元の評価は Docker を使わない（評価に付く画面の絵を PNG に描くときだけ使い、無くても評価は残る）。詳しくは
  [使い方ガイド: 手元の対話エージェントで Preflight する](how-to-use.md#手元の対話エージェントで-preflight-する)
- 作るときに `description`（何のプロジェクトか）を省いたなら、ここで書くと評価の精度が上がる: `npx @infodb/p3 config set description="..."`

**できたと分かる目安**: `npx @infodb/p3 drafts <要望ID>`（か画面の要望）で、評価とタスク案が読める。

### Codex で評価する

Codex を **Docker のコンテナの中で** 動かし、各自の ChatGPT アカウント（プラン）で評価させる。つまずくのはほとんどが Docker と
パスの見え方なので、そこを詳しく書く。

| # | すること | 終わったと分かる目安 |
| --- | --- | --- |
| 1 | Docker に繋がるか確かめる | `docker version` に **Client と Server の両方** が出る |
| 2 | どこで P3 を動かすか決める（ホスト / DevContainer） | 下の「動かす場所」のどちらかに当てはまる |
| 3 | （DevContainer のときだけ）パスを確かめる | `p3 user-config paths <リポジトリ> <データのフォルダ>` が「全部決まりました」 |
| 4 | ChatGPT に接続する | `p3 chatgpt status` が「ChatGPT プランを使います」 |
| 5 | Codex のイメージを作る | `p3 codex update` が「Codex を更新しました: codex-cli …」 |
| 6 | 画面で試しに Preflight を動かす | 評価とタスク案が出る |

- Codex をこのマシンに入れる必要はない（コンテナのイメージに入れる）。画面はビルド済みのものが入っているので、ビルドも要らない
- Docker と ChatGPT の接続を使うのは、Preflight（Codex）・リリースノートの要約の生成・タスクとマイルストーンの AI レビュー・
  画面イメージの描画（Docker だけ）。準備が済むまでの間も、Preflight を通さずにタスクを作って進められる
  （[使い方ガイド: Preflight を通さずにタスクを作る](how-to-use.md#preflight-を通さずにタスクを作る)）

#### 1. Docker に繋がるか確かめる

Docker（CLI とデーモン）は、Preflight の Codex を、リポジトリとデータのフォルダだけを見せたコンテナの中で動かすのに使う。
画面イメージの描画にも使う。

```bash
docker version --format 'Client {{.Client.Version}} / Server {{.Server.Version}}'
# Client 29.8.2 / Server 29.3.0      ← 両方出れば繋がっている
```

| 出たもの | 意味と次にすること |
| --- | --- |
| `docker: command not found` | Docker の CLI が無い。Docker Desktop か Docker Engine を入れ、`PATH` を確かめる。DevContainer なら、CLI を入れる設定（docker-outside-of-docker の feature など）を足す |
| Server の行が無い・`Cannot connect to the Docker daemon` | デーモンに繋がらない。Docker を起動する。繋ぎ先は `docker context ls`（`*` が今のもの）と環境変数 `DOCKER_HOST` で確かめる。DevContainer なら、ホストのソケット（`/var/run/docker.sock`）が渡っているか |
| `permission denied ... docker.sock` | ソケットを使う権限が無い。Linux なら利用者を `docker` グループに入れ直してログインし直す（または管理者に相談する） |

#### 2. 動かす場所

P3 が Codex のコンテナを作るとき、リポジトリとデータのフォルダを **Docker のデーモンから見たパス** でマウントする。
そのため、次の3つのパスを区別する。

| パス | 例 | 説明 |
| --- | --- | --- |
| P3 から見たパス（このマシンのパス） | `/workspaces/myapp` | `p3` を動かしている場所でのパス。個人設定に登録する |
| Docker のデーモン（ホスト）から見たパス | `/home/me/workspaces/myapp` | コンテナを作るのはデーモンなので、マウントはこのパスで指定する |
| Codex のコンテナの中のパス | `/workspace/myapp`、`/data` | 参照先は `/workspace/<名前>`（読むだけ）、データのフォルダは `/data` |

動かし方は2通りある。

- **A. ホストで直接動かす**（Mac・Linux・WSL の中で `p3` を実行し、Docker も同じ環境のもの）: 1つ目と2つ目のパスが同じなので、
  パスについてすることは無い（P3 はそのまま渡す。Docker Desktop・WSL でも同じ）
- **B. VS Code の DevContainer の中で動かし、Docker はホストのデーモンを使う**（docker-outside-of-docker）: 1つ目と2つ目の
  パスが違う。P3 が自分のコンテナのマウントから2つ目のパスを自動で決めるので、3. で確かめるだけでよい。リポジトリとデータの
  フォルダは、ホストのフォルダをマウント（bind）した場所の下に置く

> リモートの Docker（`DOCKER_HOST` で別のマシンを指す）や、P3 のコンテナが接続先のデーモンに無い形では、自動では決まらない。
> そのときは 3. の確かめで理由が出るので、「自動で決まらないとき」の手順で手で書く。

#### 3. パスを確かめる（DevContainer のときだけ）

ホストで直接動かす（2. の A）なら飛ばしてよい。

P3 は Preflight と描画のたびに、自分が動いているコンテナを Docker に確かめ、そのマウントからリポジトリとデータのフォルダの
ホストのパスを決める（ホスト名がコンテナの名前と違ってもよい。結果は保存しない）。決まるかは、このマシンで確かめられる:

```bash
p3 user-config paths . ~/p3-data/myapp          # リポジトリとデータのフォルダ（リポジトリの .p3 ならリポジトリだけでよい）
# p3 が動いている場所: コンテナの中（自分のコンテナ 3f2a… を Docker で確かめました。マウントから決めます）
# /workspaces/myapp
#   → /home/me/workspaces/myapp  自動（p3 が動いているコンテナのマウントから）（マウント /workspaces）
# 全部決まりました（Preflight と描画でこのとおりにマウントします）
```

決まらないものがあると、理由と次にすること（1つ）が出る。Preflight と描画も、そのフォルダを使うときはコンテナを起こさずに
同じ理由で止まる（間違ったパスでは動かない）。

| 理由 | 次にすること |
| --- | --- |
| ホストのフォルダではないマウント（volume・tmpfs）の下・コンテナの中だけにある | フォルダを、ホストのフォルダをマウント（bind）した場所の下へ移す |
| 自分のコンテナを確かめられない（リモートの Docker・別のデーモン・ID が分からない） | 下の「自動で決まらないとき」で手で書く |
| 見つけたコンテナのマウントの元が、このマシンのマウントと合わない（ネットワークを共有するコンテナ・シンボリックリンクを通した bind） | 下の「ネットワークを共有するコンテナで動かすとき」の手順で手で書く |
| 手で書いた対応と、コンテナのマウントから決めたものが違う | 手で書いた対応を直すか外す（`p3 user-config set codex.pathMap-=<このマシンのパス>`。外せば自動で決まる） |

##### 自動で決まらないとき（手で書く）

ホストから見たパスを調べ（ホストで `docker inspect <この開発コンテナ>` の `Mounts`。`Source` がホスト、`Destination` がこのマシン）、
`Destination` ごとに1件書く。左がこのマシンのパス、右がホストのパス。

```bash
p3 user-config set codex.pathMap+=/workspaces=/home/me/workspaces
p3 user-config set codex.pathMap-=/workspaces                     # 1件外す（codex.pathMap= で全部外す）
```

- 手で書いた対応は自動より先に使う（前から順に、境界（`/`）が合う最初の対応。同じ左側をもう一度足すと置き換える）。当たらない
  フォルダだけ自動で決める
- 書き間違い（`=` が無い、相対パスなど）は、何を直すかを出して何も書かない
- 直したら、serve を起動し直さなくても **次の Preflight から** 効く。`p3 user-config paths` で結果を確かめる

##### ネットワークを共有するコンテナで動かすとき

Compose の `network_mode: service:<別のサービス>`（`docker run --network container:<別のコンテナ>`）で、ネットワークを別のコンテナ
（共有元）と共有するコンテナの中で p3 を動かすと、パスは **自動では決まらない**。コンテナの中から見える自分のコンテナの手がかり
（`/etc/hostname` などの元・ホスト名）が共有元のものになり、自分のコンテナを確かめられないため。共有元を自分と取り違えると
共有元のフォルダをマウントしてしまうので、p3 は見つけたコンテナのマウントの元がこのマシンのマウントと合わなければ止まる
（「マウントの元が、このマシンのマウントと合いません」）。ホストでシンボリックリンクを通して bind したフォルダも、Docker が答える
元（リンク）とこのマシンから見える元（実体）が違うので同じく止まる。どちらも次の手順で手で書けば進む:

1. **ホストで** `docker inspect <p3 を動かしているコンテナ>` の `Mounts` を見る（共有元ではなく、p3 を動かしている側。Compose なら
   `docker compose ps -q <p3 を動かしているサービス>` で ID が分かる）。リポジトリとデータのフォルダを含む `Type: bind` ごとに、
   `Destination`（このマシンのパス）と `Source`（ホストのパス）を控える
2. 控えたものを1件ずつ書く: `p3 user-config set codex.pathMap+=<Destination>=<Source>`
3. `p3 user-config paths <リポジトリ> <データのフォルダ>` で、全部の対象が「codex.pathMap の対応あり」で、行き先が手順 1 の
   `Source` の下になり「全部決まりました」と出るのを確かめる（決まらない対象が残れば、その対象を含む bind を足す）

- 共有元のマウントや `Source` を書き換えて合わせない（共有元のフォルダを使うことになる）。対応を書かない対象をそのまま渡すことも
  しない（このマシンのパスはホストのパスとは限らない）
- 以前の版の p3 は、共有元にも同じ `Destination` があると、共有元の `Source` を自動で選んでいた。正しい対応を書くと
  「手で書いた対応と、コンテナのマウントから決めたものが違う」（conflict）で止まった。この表示が出ても対応を外さない（外すと共有元のフォルダを
  使う）。p3 を上げるか、ネットワークを共有しないコンテナ・ホストから動かす

#### 4. ChatGPT に接続する

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

#### 5. Codex のイメージを作る

```bash
p3 codex update
# Codex のイメージ llmcs-codex-workspace:local を作り直しています（最新の Codex を入れます。数分かかることがあります）
# Codex を更新しました: codex-cli 0.162.1（変わらず。これが最新）
#   イメージ llmcs-codex-workspace:local（2026-10-13 05:08:07 作成）
```

- 初回は数分かかる（ネットワークから Codex を入れる）。プロジェクトの登録やサインインは要らない
- しなくても、最初の Preflight の前に自動で作る。その後も、作ってから1日より古ければ Preflight の前に作り直す
  （止めるなら `p3 user-config set codex.ensureImage=false`）
- 作り直すかどうかは作った日時だけで決まる。P3 を上げてイメージの中身（入れる道具）が変わったときは、`p3 codex update` で
  今すぐ作り直す（しなくても1日以内に作り直される）
- 画面イメージの描画のイメージ（`infodb-p3-render`）は、最初に画面イメージを描くときに作る（`p3 render update` で今すぐ）
- イメージの確認・作り直しは、開始を受け付けた後の実行の中で行う（実行ログに「コンテナのイメージを確かめています」と出る）。Codex に頼む機能
  （Preflight・リリースノートの要約・マイルストーンレビュー・タスクの AI レビュー・観測の手順の提案と候補）で共通。画面のボタンは押した直後から
  「開始を待っています…」（開始の応答待ち）になり、受け付けられると「実行中…」（実行の中でイメージを用意している間も含む）に変わる

#### 6. 画面で試しに Preflight を動かす

`p3 serve` で開いた画面（段階 0）の概要ページの上にエンジンの状態が出る（Codex なら Docker・認証・イメージを確かめ、使えなければ
理由を出して実行のボタンを止める）。ここで問題が無ければ、試しに要望を1件作って Preflight を実行する（[使い方ガイド](how-to-use.md) の 1.〜2.）。

Preflight の実行ログの最初の方に、参照先とデータのフォルダが **コンテナの中のどこに当たったか** が出る:

```text
パスの対応（Docker のホストから見たパス）:
  参照先 myapp → コンテナ /workspace/myapp（自動（p3 が動いているコンテナのマウントから））
  データ → コンテナ /data（自動（p3 が動いているコンテナのマウントから））
```

ログには決め方だけが出る（実際のパスは共有の記録に残さない）。パスそのものは、このマシンで 3. の `p3 user-config paths` で見る。

**できたと分かる目安**: 評価とタスク案が画面（か `p3 drafts <要望ID>`）に出る。

## 段階 2: 必要になったら足す

**すること**: 要る機能だけを足す（全部を設定しなくてよい）。**できるようになること**: プロジェクトとして守る水準を確かめる・完了した
タスクやマイルストーンを別の目で確かめる。

| 機能 | 何ができるか | 要るもの | 操作 |
| --- | --- | --- | --- |
| 品質基準 | 守る最低限の水準（lint・検証・文書など）を項目にし、タスクの受け入れ基準に取り込む | 足すものは無い（Codex の準備も要らない） | [使い方ガイド: 品質基準](how-to-use.md#品質基準) |
| タスクの AI レビュー | 完了したタスクが本文・受け入れ基準を満たしているかを、別の Codex に確かめさせる | 段階 1 の Codex の接続（Docker と ChatGPT） | [使い方ガイド: タスクの AI レビュー](how-to-use.md#タスクの-ai-レビュー) |
| マイルストーンレビュー | マイルストーンの目的に対して、できあがったものが足りているかを確かめる | 段階 1 の Codex の接続 | [使い方ガイド: マイルストーンレビュー](how-to-use.md#マイルストーンレビュー) |
| リリースノートの要約 | タスクの変更の記録から機能の要約の案を作る（手で書いて保存するだけなら要るものは無い） | 段階 1 の Codex の接続 | [使い方ガイド: リリースノート](how-to-use.md#リリースノート) |

**できたと分かる目安**: 足した機能の結果（選んだ品質基準・レビューの結果など）を、画面か CLI で読める。

## うまくいかないとき

失敗はログとエラーに **次にすること** を添えて出す。直して、もう一度同じ操作をする。

Preflight を使えない・失敗したとき（Docker・ChatGPT の接続・使用量の上限など、理由によらない）は、概要ページ・失敗した run・
CLI の出力に、Preflight を通さずにタスクを作る道も出る。直すまでの間はそれで進めてよい（[使い方ガイド: Preflight を通さずにタスクを作る](how-to-use.md#preflight-を通さずにタスクを作る)）。Preflight を Claude Code などの手元の対話エージェントに
頼むなら Docker と ChatGPT は要らない（[どちらで評価するか](#どちらで評価するか)）。

| どこで | 出るもの | 確かめる | 直す |
| --- | --- | --- | --- |
| Preflight・`codex update` | `docker` が無い（ENOENT） | `docker version` | Docker を入れ、`PATH` を確かめる |
| 〃 | `Cannot connect to the Docker daemon` | `docker version` の Server、`docker context ls`、`DOCKER_HOST` | Docker を起動する。繋ぎ先と権限（[段階 1 の 1.](#1-docker-に繋がるか確かめる)）を直す |
| 〃 | `permission denied ... docker.sock` | `ls -l /var/run/docker.sock` | `docker` グループなど、ソケットの権限を直す |
| Preflight・描画 | 「マウントするフォルダが Docker のホストのどこにあるか決められないので、コンテナを起こしません」 | 出ている理由と次にすること、`p3 user-config paths <フォルダ>` | [段階 1 の 3.](#3-パスを確かめるdevcontainer-のときだけ) の表のとおり |
| Preflight | `bind source path does not exist: <参照先 …>` / `<データ>` | ログの「パスの対応」、`p3 user-config paths <フォルダ>` | 手で書いた対応（`codex.pathMap`）の右側（ホストのパス）の誤り。直すか外す（[自動で決まらないとき](#自動で決まらないとき手で書く)）。serve はそのままで次の Preflight から効く |
| Preflight | 「Codex のイメージを用意できません（app-server を起こす前）」 | `p3 codex update` の出力 | ネットワーク（プロキシ）を確かめて `p3 codex update` をやり直す。`Unable to find image` も同じ |
| Preflight | 「〜が 60 秒で終わらないので止めました」（イメージの確認 15 秒・版の確認 60 秒・ビルド 10 分） | `docker ps -a --filter label=infodb.p3`（P3 が起こしたコンテナ） | P3 はそのコンテナを消してから終わる。Docker が重い・止まっていないかを確かめてやり直す。「コンテナ p3-… を消せませんでした（残っているかもしれません）」と出たら、出ている `docker rm -f <名前>` で消す |
| Preflight・画面 | 「ChatGPT にサインインしてください」「ChatGPT の接続が切れています」「プランの利用が許可されていません」 | `p3 chatgpt status` | `p3 chatgpt login`（届かなければ `--paste`）。プランの利用に同意する |
| Preflight | 「Usage limit reached」 | ChatGPT の Manage usage（https://chatgpt.com/settings/usage） | 上限が戻るのを待つ |
| Preflight・画面 | 個人設定を読めない（YAML の行と直すファイル） | `~/.config/infodb-p3/config.yaml` | 書き間違いを直す。serve はそのままで次の Preflight から効く |
| CLI | プロジェクトが決まらない | `p3 whoami`、`p3 project` | `--project <名前>`、または `p3 project add <名前> <フォルダ>` |
| CLI・serve | 「データのフォルダがありません」「データのフォルダに project.yaml がありません」 | `p3 project ls` の登録先、フォルダを移していないか、共有ドライブ（同期するフォルダ）がつながっているか | つながっていなければつないでやり直す。移したなら `p3 project rm <名前>` → `p3 project add <名前> <正しいフォルダ>`（rm はデータを消さない。そのあと `p3 repo path` で手元のリポジトリを登録し直す）。新しく作るなら管理したいリポジトリの中で `p3 init --project <名前>`（外に置くなら `--dir <フォルダ>`） |
| `join` | データのフォルダ・`project.yaml` が無い | リポジトリを `git pull` したか、データの場所（共有ドライブ）を聞いたか | `.p3` が届いていなければ取得する。外にあるなら `--dir <フォルダ>` で指定する |
| 画面 | 開けない | serve のログ、ポートの転送 | 4310 を転送する。`serve.port` を変えたら転送先も変える |

## 設定の決まり

マシン（と人）ごとの設定は、プロジェクトのデータではなく個人設定に置くか、環境変数で渡す。`.env` は読まない。
値は項目ごとに **CLI の明示（`--port` / `--host` / `--engine`）→ 環境変数 → 個人設定 → 既定値** の順で決まる
（環境変数を空にすると既定値に戻す）。

| 個人設定 | 環境変数 | 内容 | 効くとき |
| --- | --- | --- | --- |
| `codex.pathMap` | `P3_CODEX_PATH_MAP`（`a=b,c=d`） | このマシンのパス → Docker のデーモンから見たパス（自動で決まらないときだけ書く） | 次の Preflight |
| `codex.auth` | `P3_CODEX_AUTH` | `auto`（既定。ChatGPT に接続していればそれ）/ `legacy`（下の旧来の認証） | 次の Preflight |
| `codex.authVolume` / `codex.authFile` | `P3_CODEX_AUTH_VOLUME` / `P3_CODEX_AUTH_FILE` | 旧来の認証の `auth.json` の置き場所 | 次の Preflight |
| `codex.model` / `codex.effort` | `P3_CODEX_MODEL` / `P3_CODEX_EFFORT` | モデル・推論の深さ（省けば Codex の既定） | 次の Preflight |
| `codex.ensureImage` | `P3_CODEX_ENSURE_IMAGE`（`0` / `1`） | Preflight の前のイメージの作り直し（1日ごと） | 次の Preflight |
| `preflight.engine` | `P3_PREFLIGHT_ENGINE` | `mock` にすると Mock で評価する（下の補足） | 次の Preflight |
| `serve.host` / `serve.port` | `P3_HOST` / `P3_PORT` | `p3 serve` の待ち受け（既定 `0.0.0.0` / `4310`） | serve を起動し直したとき |
| `ui.theme` | — | 画面のテーマ（`system` / `light` / `dark`） | 画面を読み直したとき |

`p3 user-config` で全部の値と出どころを見て、`p3 user-config set キー=値` で変える（`キー=` で消す）。コメントとほかの項目は残る。
環境変数は serve を起動したときのものが使われる。

## Docker で動かす（プロジェクトを跨ぐ serve）

P3 をイメージにして、コンテナで動かすこともできる。イメージの既定は **プロジェクトを跨ぐ serve**（`p3 serve --all-projects
--host 0.0.0.0`）で、個人設定に登録したプロジェクトを画面で選んで扱う（[使い方ガイド](how-to-use.md#画面)）。閲覧専用ではなく、
要望・タスクの作成と編集・添付・Preflight もいつもどおり使える。

イメージは Docker Hub の **`tamuto/p3`**。中に p3 本体（npm の `@infodb/p3` と同じ版・同じ中身）と、Node 26・git・Docker の CLI が
入っている（Codex は入れない。Preflight のたびにホストの Docker で Codex のイメージを使う）。版のタグ（`tamuto/p3:0.16.0` など）と
`latest` がある。決まった版で使うなら版のタグを指す。対応する platform は `linux/amd64` だけ（arm64 は確かめるマシンが無いので
作っていない）。

```bash
docker pull tamuto/p3:0.16.0
```

リポジトリから作るときは `docker build --pull -t tamuto/p3:dev .`（`--pull` で今の Node のベースを取る。[開発ガイド](development.md#docker-のイメージ)）。
イメージの Node は同じメジャーの中で更新を追う（作り直した版に入る）。起動中のコンテナは自動では変わらないので、新しいイメージを
pull して起動し直す。

コンテナは **root** で動く。個人設定と ChatGPT の接続は root の既定の場所（`/root/.config/infodb-p3`）のままで、イメージでは
変えない。データのフォルダと参照先（リポジトリ）はホストのフォルダをマウントする（データは書く、参照先は Preflight が読むだけ）。
マウントしたリポジトリは持ち主が違っても読めるよう、イメージの git は `safe.directory` を `*` にしている。

### 開発コンテナのサイドカーとして動かす

root で動く開発コンテナ（DevContainer など）で p3 の CLI を使っているなら、その横に p3 のコンテナを置き、**開発コンテナと同じ
マウント**を付ける。個人設定（登録など）と ChatGPT の接続を開発コンテナと共有するので、コンテナの中で登録し直す・
接続し直す必要はない。登録・接続・テーマの変更は、開発コンテナの中の CLI でいつもどおり行い、画面の「一覧を読み直す」で反映する。

```yaml
# 開発コンテナの compose に足す例（パスは開発コンテナのマウントに合わせる）
services:
  p3:
    image: tamuto/p3:0.16.0
    restart: unless-stopped
    ports:
      - "127.0.0.1:4310:4310"
    environment:
      - TZ=Asia/Tokyo
    volumes:
      - /home/me/workspaces:/workspaces                  # 開発コンテナと同じ（リポジトリ・データ）
      - ./.devcontainer/.config:/root/.config            # 開発コンテナと同じ ~/.config（個人設定・ChatGPT の接続）
      - /home/me/p3-data:/p3-data                         # データを別の場所に置いているなら、それも同じに
      - /var/run/docker.sock:/var/run/docker.sock         # Preflight（Codex）と画面イメージの描画
```

- p3 のコンテナも、自分のマウントからホストのパスを自動で決める（開発コンテナで手で書いた `codex.pathMap` があれば、同じパスで見えるのでそのまま効く）
- 個人設定は開発コンテナと p3 のコンテナの両方から書かれることがあるが、書くときはファイルのロックで順に行う

### 単独で動かす

```bash
docker run -d --name p3 --restart unless-stopped \
  -p 127.0.0.1:4310:4310 \
  -v ~/.config/infodb-p3:/root/.config/infodb-p3 \
  -v /home/me/work:/home/me/work \
  -v /var/run/docker.sock:/var/run/docker.sock \
  tamuto/p3:0.16.0

# 登録が無ければ、コンテナの中で登録する（既にあるデータに参加する。新しく作るなら p3 init）
docker exec -w /home/me/work/myapp p3 p3 join --project myapp --yes
```

- データと参照先はホストと **同じパスで** マウントするのが分かりやすい（違うパスでも、p3 が自分のマウントからホストのパスを自動で
  決める）。ホストの個人設定を使うなら、その登録のパスとマウントのパスをそろえる
- root で動くので、コンテナが作るファイル（要望・タスクなど）の持ち主は root になる

### どちらでも

- 待ち受けは `127.0.0.1` に公開する。ブラウザで http://localhost:4310 を開く。登録が1つならそのプロジェクトが開き、複数なら一覧から選ぶ
- **通常の serve に戻す**: コマンドを明示する（例: `docker run ... tamuto/p3:0.16.0 serve --project myapp --host 0.0.0.0`。compose なら
  `command:`）。明示しない限り、コンテナの中かどうかで自動では切り替えない
- **止める**: `docker stop p3`（SIGTERM。実行中の Preflight・生成を取り消して記録してから止まる。10 秒まで待つ）
- **新しい版にする**: 版のタグを変えて作り直す（個人設定と接続はマウントした ~/.config、データはホストに残る）。
  中の P3 が変わると Codex のイメージの中身も変わることがあるので、`docker exec p3 p3 codex update`
- 状態はヘルスチェック（`/api/mode` に答えるか）で `docker ps` に出る

**ブラウザから変えられない操作**: コンテナに公開したポートからの接続は「このマシン」からではないので、ローカルだけの操作
（ChatGPT の接続・テーマ・参照先のこのマシンのパス）は画面からは断られる。サイドカーなら開発コンテナの中の CLI で、単独なら
コンテナの中の CLI で行う:

```bash
docker exec -it p3 p3 chatgpt login --paste      # 表示された URL をホストのブラウザで開き、「接続できません」の URL を貼る
docker exec p3 p3 user-config set ui.theme=dark
docker exec p3 p3 --project myapp repo path main /home/me/work/myapp
```

要望・タスクの作成と編集、Preflight の実行など、ほかの操作は画面からできる。

**Preflight（Codex）と画面イメージの描画**: コンテナの中に Docker のデーモンは無い。ホストのデーモンのソケットを渡すと使える

（上の例の `-v /var/run/docker.sock:/var/run/docker.sock`）。root で動くので、ソケットの権限の設定は要らない。

```bash
docker exec p3 p3 codex update      # Codex のイメージを作る（ホストのデーモンに作る）
```

- ソケットを渡すと、コンテナの中から **ホストの Docker を何でも操作できる**（ホストの管理者と同じ強さ）。信頼できるマシンでだけ渡す
- Codex・描画のコンテナはホストのデーモンが作り、データのフォルダと参照先を **ホストのパスで** マウントする。p3 のコンテナの
  マウント（bind）から自動で決まる。名前付きボリュームの下に置いたフォルダは決まらないので、ホストのフォルダを bind する。
  決まるかは `docker exec p3 p3 user-config paths <コンテナの中のパス>` で確かめる（[段階 1 の 3.](#3-パスを確かめるdevcontainer-のときだけ)）
- ChatGPT の接続はマウントした ~/.config に残るので、コンテナを作り直しても接続し直さなくてよい
- ソケットを渡していない・繋がらないときも、要望・タスクの作成と編集・プロジェクトの選択は使える。Preflight は
  使えない理由と直し方を出して止まる（Mock には落とさない）。その間は Preflight を通さずにタスクを作ってよい
  （[使い方ガイド](how-to-use.md#preflight-を通さずにタスクを作る)）
- P3 を作り直してイメージの中身（入れる道具）が変わったら `docker exec p3 p3 codex update`

## 補足: Node.js の版と、同じ版で動かすこと

- P3 そのものを開発するときと、Docker のイメージ（`tamuto/p3`・描画のイメージ）は Node 26 を使う（[開発ガイド](development.md)）。
  使うだけなら 24 以上でよい
- **Node 22 から上げるとき**: Node 22 はサポートの終わり（2027-04-30）が近いので、この版から P3 は Node 24 以上で動かす（`engines` は
  `>=24`）。Node 22 のままでも止められるとは限らない: npm は入れるときに警告（`EBADENGINE`）を出して入れ、`engine-strict=true`
  なら断る。pnpm（12.10 で確かめた）と `pnpx` は警告を出さずに入れて動かす。`node -v` を確かめ、24 以上（推奨 26）に上げてから入れ直す。Docker で動かしているなら、新しいイメージを `docker pull` してコンテナを作り直す
  （起動し直すだけでは前のイメージの Node のまま）
- 同じデータを使う人と AI は、なるべく同じ版で動かす（`npx @infodb/p3@<版>` / `pnpx @infodb/p3@<版>` のように版を付けられる。
  `npx`・`pnpx` は取った版をしばらく使い続ける）。古い版で更新すると、新しい版で足した項目が消えることがある（[データの形](architecture.md#データの形)）

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
