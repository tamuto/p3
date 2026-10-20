# infodb p3 を Docker で動かすイメージ。既定はプロジェクトを跨ぐ serve（p3 serve --all-projects --host 0.0.0.0）。
#
#   docker build -t infodb-p3 .
#   docker run -d --name p3 -p 127.0.0.1:4310:4310 -v p3-config:/config -v /home/me/work:/home/me/work infodb-p3
#
# 通常の serve（1つのプロジェクト）にするなら、コマンドを明示する（例: ... infodb-p3 serve --project myapp --host 0.0.0.0）。
# 個人設定・ChatGPT の接続は /config（XDG_CONFIG_HOME）に置く。プロジェクトのデータと参照先はホストのフォルダをマウントする。
# Preflight（Codex）と画面イメージの描画は、ホストの Docker（ソケット）を使う。コンテナの中にデーモンは立てない。
# 手順と注意は docs/installation.md の「Docker で動かす」。

# --- ビルド: 画面をビルドし、npm で配るのと同じ中身（package.json の files）を作る -----------------------------
FROM node:24.11.1-bookworm-slim AS build
WORKDIR /src
# package.json の packageManager と同じ版の pnpm（Node に付いた corepack はこの版の配布の形を扱えないので npm で入れる）
RUN npm install -g pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# prepack で画面をビルドしてから、配る中身だけを tarball にする
RUN pnpm pack --pack-destination /pack && mkdir /opt/p3 && tar -xzf /pack/*.tgz -C /opt/p3 --strip-components=1
# 実行に要る依存だけを、ロックファイルどおりに入れる
RUN cp pnpm-lock.yaml pnpm-workspace.yaml /opt/p3/ && cd /opt/p3 && pnpm install --prod --frozen-lockfile

# --- Docker の CLI（ホストのデーモンを使う。buildx は Codex・描画のイメージを作るため） --------------------------
FROM docker:27.5.1-cli AS docker-cli

# --- 実行 ------------------------------------------------------------------------------------------------------
FROM node:22.21.1-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # マウントしたリポジトリは持ち主（ホストの UID）が違うので、git の safe.directory で読めるようにする
    && git config --system --add safe.directory '*'
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /opt/p3 /opt/p3
RUN ln -s /opt/p3/bin/p3.mjs /usr/local/bin/p3 \
    && mkdir -p /config \
    && chown node:node /config

# 個人設定（config.yaml）と ChatGPT の接続（chatgpt.json）の置き場所。ボリュームにして残す
ENV XDG_CONFIG_HOME=/config
VOLUME ["/config"]
USER node
WORKDIR /home/node
EXPOSE 4310
# exec の形にして、node が SIGTERM（docker stop）を受ける（実行中の Preflight・生成を取り消して記録してから止まる）
ENTRYPOINT ["p3"]
CMD ["serve", "--all-projects", "--host", "0.0.0.0"]
