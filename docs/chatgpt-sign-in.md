# Sign in with ChatGPT（Preflight を各自の ChatGPT プランで動かす）

要望 261009-6ad4x の設計（T004）。Preflight の Codex を、Codex の初期設定でサインインした `auth.json` ではなく、
P3 が自分でサインインした ChatGPT アカウント（Sign in with ChatGPT のプラン利用）で動かす。
P3 自体の本人認証は足さない（ローカルの個人用ツールのまま）。

公式資料（2026-10-10 に確認。以下の契約はこれに合わせる）:

- 登録とサインイン: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- アカウントとセッション（更新・サインアウト）: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Codex app-server: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- トークン・エラー・制限: `.../token-reference`、`.../errors-and-recovery`、`.../preview-limitations`、UI: `/siwc/ui-ux-guidelines`
- OpenID の設定: https://auth.openai.com/.well-known/openid-configuration（`jwks_uri`、`revocation_endpoint`）

## 全体

```
p3 chatgpt login（CLI）/ 設定画面の「Continue with ChatGPT」
  └─ 127.0.0.1:1455/auth/callback で待つ → ブラウザで auth.openai.com にサインイン・同意
       └─ コード交換・ID トークン検証 → ~/.config/infodb-p3/chatgpt.json（0600）
Preflight
  └─ 期限が近ければ更新（排他）→ access token を子プロセスの環境変数 ACCESS_TOKEN で
     docker run -e ACCESS_TOKEN … codex app-server -c model_provider=openai_chatgpt_plan …
```

## サインイン（P3 側。T006）

| 項目 | 値 |
| --- | --- |
| authorize | `https://auth.openai.com/api/accounts/authorize`（`response_type=code`、PKCE S256、`state`、`nonce` は毎回新しく） |
| token | `https://auth.openai.com/api/accounts/oauth/token`（form。`authorization_code` / `refresh_token`） |
| revoke | `https://auth.openai.com/api/accounts/oauth/revoke`（`token`、`token_type_hint=refresh_token`、`client_id`） |
| JWKS | `https://auth.openai.com/.well-known/jwks.json`（ID トークンは RS256） |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| resource | `https://api.openai.com/v1`（authorize とコード交換・更新で同じ値） |
| redirect_uri | `http://127.0.0.1:<port>/auth/callback`（既定 1455。使えなければ別のポート。`localhost` にしない、パスは変えない） |

- **登録**: 初回は `client_id=dynamic_agent_client`、`agent_name_hint=infodb_p3`、`ext_agent_host_id` で authorize する。
  コールバックの `client_id`（`oaiapp_...`）が発行された client ID。別の登録窓口や client secret は無い。
- **ホスト ID**（`ext_agent_host_id`）: マシンごとに1つ、`urn:uuid:<乱数>` を作って `chatgpt.json` に残し、ずっと使う。
- **再サインイン**: 保存した client ID と `id_token_hint`（あれば `login_hint`）で authorize する（`agent_name_hint` は送らない）。
  新しい ID トークンの `sub` が保存したアカウントと違えば、**保存を上書きせず失敗**にする（別のアカウントに切り替えるには、先に接続を解除する）。
- **ID トークンの検証**: JWKS で署名（RS256）、`iss=https://auth.openai.com`、`aud` に発行された client ID、`exp`、保存した `nonce`。
  検証した `sub` をアカウントの識別に使う。
- **プラン利用の確認**: トークン応答の `scope` に `chatgpt.tokens.use.direct` が無ければ「サインインはできたがプラン利用は許可されていない」
  として保存し、Preflight には使わない（同意をやり直すには、もう一度サインイン）。
- **新しい試行が終わるまで既存の接続は変えない**（コード交換と検証に成功してから、まとめて書き換える）。
- 拒否（`error=access_denied`）・取消・5分のタイムアウト・ポートが使えない・ブラウザを開けない（URL を表示して手で開く）を扱う。

### 保存

```
~/.config/infodb-p3/config.yaml   個人設定（プロジェクトなど）。秘密は置かない
~/.config/infodb-p3/chatgpt.json  接続（0600。一時ファイルも 0600 で書いて rename）
~/.config/infodb-p3/chatgpt.lock  更新の排他（O_EXCL。古い lock は 60 秒で取り直す）
```

`chatgpt.json`（1接続。初期は1つだけを扱う）:

```json
{
  "hostId": "urn:uuid:…",
  "clientId": "oaiapp_…",
  "account": { "sub": "…", "email": "…" },
  "tokens": {
    "accessToken": "…", "refreshToken": "…", "idToken": "…",
    "expiresAt": "2026-10-10T01:00:00Z", "scopes": ["…"], "savedAt": "…"
  }
}
```

- `config.yaml` とは別のファイルにするので、プロジェクトや画面の設定を保存しても接続は消えず、その逆も起きない。
- CLI の `--json`、API、ログ、エラーには、トークンを出さない（状態として出すのはアカウントの email、プラン利用の可否、期限、ホスト ID・client ID の有無）。
- **接続の解除**（`p3 chatgpt logout`）: refresh token を revoke してから、`tokens` を消す。ホスト ID・client ID・アカウントは残す
  （次のサインインで同じ登録を使う。公式: サインアウトしても登録したクライアントは消えない）。revoke が通らなかったら
  ローカルのトークンは消し、「ChatGPT の設定で接続を切ってください」と伝える。`--forget` で登録ごと消す。
- 旧来の `auth.json`（Codex の初期設定でのサインイン）は変換しない。新しくサインインしてもらう。

### 更新

- 期限の 35 分前を過ぎていたら、使う前に更新する（Preflight の1ターンの上限 30 分 + 余裕。access token は 1 時間）。
- `refresh_token` グラント（発行された client ID、`resource`、`scope` は送らない）。応答の access token・期限・scope・新しい refresh token を
  まとめて書き換える（refresh token は毎回入れ替わる）。
- 同じマシンの CLI・serve・並行する Preflight が同時に更新しないよう、lock を取り、取ったら読み直して、まだ必要なら更新する。
- `invalid_grant` などの更新できないエラーは、トークンを消して「サインインし直してください」。ネットワークや 5xx では消さない。

## llmcs（@llmcs/codex-workspace。T005）

公式の Codex app-server の手順に合わせ、llmcs に足すもの（旧来の `authVolume` / `authFile` はそのまま使える）:

- `dockerCommand(workspace, { accessTokenEnv: "ACCESS_TOKEN" })`: 認証のマウントをせず、`-e ACCESS_TOKEN`（**値は argv に入れない**。
  起動するプロセスの環境から引き継ぐ）と、次の `-c` を付ける:
  `model_provider="openai_chatgpt_plan"`、`model_providers.openai_chatgpt_plan.name="ChatGPT plan"`、`…base_url="https://api.openai.com/v1"`、
  `…env_key="ACCESS_TOKEN"`、`…wire_api="responses"`、`…requires_openai_auth=false`、`…supports_websockets=false`
- `WorkspaceSession.open(command, { env, clientInfo })`: 子プロセスに渡す環境変数（ここに ACCESS_TOKEN）と、`initialize` の
  `clientInfo`（`name` は `agent_name_hint` と同じ `infodb_p3`、`title`、`version`）。
- `session.restart({ env })` と `session.resumeThread(threadId)`: 更新したトークンで起動し直し、スレッドを続ける（公式の更新手順）。
- 使用量の上限: `subscription_sharing_usage_limit_exceeded`（429）も `UsageLimitError` にする。
- `usage()`（`account/rateLimits/read`）は ChatGPT アカウントでのサインインを前提とする API なので、この方式では呼ばなくてよい
  （呼ぶ側の任意。P3 は呼ばず、「利用状況は取得できません」と表示する）。

### スレッドの続き（thread/resume）について

Codex 0.162.0 の app-server には `thread/resume` があるが、P3 は記録を残さないスレッド（`ephemeral`）を、終わると消える
コンテナ（`--rm`）で動かしている。起動し直すと元のスレッドは無いので、**P3 は実行の途中で更新しない**:
実行を始める前に、1ターン（最長 30 分）より長く使えるトークンにしておく。新しい run はこれまでどおり新しいスレッドで始める。
llmcs の `restart` / `resumeThread` は、記録を残す使い方（`ephemeral` にしない、`CODEX_HOME` を残す）のための部品として足す。

## Preflight（T007）

認証の選び方（上から）:

1. `PCUBE_CODEX_AUTH=legacy` と `PCUBE_CODEX_AUTH_VOLUME` / `PCUBE_CODEX_AUTH_FILE` → 旧来の `auth.json`（明示したときだけ）
2. ChatGPT に接続していてプラン利用が許可されている → Sign in with ChatGPT
3. 旧来の `PCUBE_CODEX_AUTH_VOLUME` / `PCUBE_CODEX_AUTH_FILE` だけがある → 旧来の `auth.json`（移行期間の互換）
4. どれも無い → Codex は使えない。画面と CLI で「ChatGPT でサインインしてください」と案内する
   （`PCUBE_PREFLIGHT_ENGINE=mock` を明示したときだけ Mock。**認証の失敗を Mock の成功に見せない**）

- 状態の表示は、未接続 / プラン利用が未許可 / 期限切れで更新できない / 使用量の上限 / Docker が無い / 旧方式 / Mock を分けて、次にすることを出す。
- 接続の変化（CLI でサインインした・解除した）を、起動中の serve にもすぐ反映する（状態のキャッシュは接続のファイルの更新日時が変わったら捨てる）。
- `model/list` は手元の一覧を返すことがあるので、使えるかの判断には使わない。使えたかはターンが `completed` になったかで決まる。
- 公式の制限: Responses の `tool_search` を出す設定は失敗する。ローカルのシェルや関数ツールは使える（P3 の Preflight はこれで足りる）。

## 画面（T008）

- 設定画面に、プロジェクトの設定とは分けた「Use your ChatGPT plan」の欄を置く。状態、ボタン「Continue with ChatGPT」（公式の表記）、
  待っている間の取消、解除、「Manage usage」（https://chatgpt.com/settings/usage）。初回の接続後に一度だけ
  「You're using your ChatGPT plan」の説明を出す。使用量の上限では「Usage limit reached」。
- サインインの待ち受けは serve のプロセスが行う（CLI と同じ部品）。同時に1つだけ。ページを読み直しても待っている試行を表示する。
- **変更の API（開始・取消・解除）を受けるのは、自分のマシンからだけ**: 接続元が 127.0.0.1 / ::1 で、`Origin` があり `Host` と同じこと。
  serve は既定で 0.0.0.0 で待つので、LAN の別のマシンからサインインの開始や解除をされないようにする（`Origin` が無いだけでは通さない）。
  状態の API も同じ条件にする（アカウントの email を出すため）。

### DevContainer

- コールバックは**ブラウザのあるマシン**の 127.0.0.1 に来る。VS Code の DevContainer で動かすときは、待ち受けたポート（1455）を
  VS Code が自動で転送するので、ホストのブラウザからのコールバックがコンテナに届く（Codex の CLI のサインインと同じ形）。
- 転送されない環境（別のコンテナ・リモートの VM・SSH）では、ブラウザがコールバックの URL を開けずエラーになる。そのときは
  アドレスバーの URL（`http://127.0.0.1:1455/auth/callback?code=…`）を `p3 chatgpt login --paste` に貼れば、続きを CLI で行う。
- serve の API はブラウザから見ると転送された localhost に来る。VS Code の転送の接続元はコンテナの中の 127.0.0.1 になるので、上の条件を満たす。
  `docker run -p` で公開した serve は接続元がゲートウェイになるため、画面からの接続はできない（CLI を使う）。

## 依存

- 足さない。PKCE・JWT の検証は Node の `crypto`（`createPublicKey({ format: "jwk" })`、`verify`）、HTTP は `fetch`。
- pnpm（12.10）の `minimumReleaseAge` はこのリポジトリでも個人設定でも明示されていない（`pnpm config get` で undefined）。
  依存を足すときは pnpm の既定値に従う。

## 範囲外・今後

- 複数の接続（アカウント）の切り替え。今は1つ。
- ホストごとの利用状況の表示（公式に利用状況を読む API が無い）。
- VM へのトークンの持ち出し（公式: 持ち出したセッションのホストごとの取り消しはまだできない）。
