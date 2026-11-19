# infodb p3 を Docker で動かすイメージ（Docker Hub の tamuto/p3）。中に p3 本体（npm の @infodb/p3 と同じ中身）を入れ、
# 既定はプロジェクトを跨ぐ serve（p3 serve --all-projects --host 0.0.0.0）。
#
#   docker run -d --name p3 -p 127.0.0.1:4310:4310 -v ~/.config/infodb-p3:/root/.config/infodb-p3 \
#     -v /home/me/work:/home/me/work -v /var/run/docker.sock:/var/run/docker.sock tamuto/p3
#
# 通常の serve（1つのプロジェクト）にするなら、コマンドを明示する（例: ... tamuto/p3 serve --project myapp --host 0.0.0.0）。
# root で動かす。個人設定・ChatGPT の接続は root の既定の場所（/root/.config/infodb-p3）のまま変えないので、開発コンテナ（root）と
# 同じマウントを付けたサイドカーにすれば、個人設定をそのまま共有できる。プロジェクトのデータと参照先はホストのフォルダをマウントする。
# Preflight（Codex）と画面イメージの描画は、ホストの Docker（ソケット）を使う。コンテナの中にデーモンは立てない。
# 手順と注意は docs/installation.md の「Docker で動かす」。作り方と公開は docs/publishing.md の「Docker Hub」。
#
# Node はメジャー版（と Debian の系統）だけを指定し、同じメジャーの中の更新（セキュリティリリースなど）は作り直すと入るようにする。
# 手元にある古いベースを使わないよう、作るときは --pull を付ける（docs/development.md の「Docker のイメージ」）。
# Docker の CLI と pnpm は版を固定する（中身の変わり方をこちらで決める）

# --- ビルド: npm で配るのと同じ中身（入口 @infodb/p3 に tasks・kit を同梱したもの）を作る -------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /src
# ルートの package.json の packageManager と同じ版の pnpm（Node に付いた corepack はこの版の配布の形を扱えないので npm で入れる）
RUN npm install -g pnpm@12.10.1
# workspace の manifest と lockfile だけを先に写して依存を入れる（ソースを変えてもこの層は作り直さない）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/p3/package.json packages/p3/
COPY packages/tasks/package.json packages/tasks/
COPY packages/kit/package.json packages/kit/
RUN pnpm install --frozen-lockfile
COPY . .
# 画面と CLI・serve をビルドし、公開する中身（dist/package）を npm pack で tarball にして展開する（npm に出すものと同じ）
RUN pnpm build && mkdir -p /pack && npm pack ./dist/package --pack-destination /pack && mkdir /opt/p3 && tar -xzf /pack/*.tgz -C /opt/p3 --strip-components=1
# 実行時の依存は workspace の lockfile のまま、入口の実行時の依存だけを入れる（pnpm deploy が入口用の lockfile で固定する。
# 開発用の依存と workspace の kit・tasks は入れない。kit・tasks は lib/ に同梱済み）
RUN pnpm --filter @infodb/p3 deploy --prod /opt/deps && mv /opt/deps/node_modules /opt/p3/node_modules

FROM docker:27.5.1-cli AS docker-cli

# --- 実行 ------------------------------------------------------------------------------------------------------
FROM node:26-bookworm-slim
# 版は package.json の version を渡す（docs/publishing.md）
ARG P3_VERSION=dev
LABEL org.opencontainers.image.title="infodb p3" \
      org.opencontainers.image.description="要望ごとにフォルダを分けて管理するファイルベースのタスク管理（Preflight は Codex）。既定はプロジェクトを跨ぐ serve" \
      org.opencontainers.image.source="https://github.com/tamuto/p3" \
      org.opencontainers.image.url="https://github.com/tamuto/p3" \
      org.opencontainers.image.documentation="https://github.com/tamuto/p3/blob/main/docs/installation.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${P3_VERSION}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # マウントしたリポジトリは持ち主（ホストの UID）が違うので、git の safe.directory で読めるようにする
    && git config --system --add safe.directory '*'
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /opt/p3 /opt/p3
RUN ln -s /opt/p3/bin/p3.mjs /usr/local/bin/p3

# root で動かす（USER を置かない）。個人設定は /root/.config/infodb-p3（XDG_CONFIG_HOME を変えない）。残すならマウントする
WORKDIR /root
EXPOSE 4310
# 待ち受けているか（P3_PORT で変えたときもそのポート）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.P3_PORT || 4310}/api/mode`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# exec の形にして、node が SIGTERM（docker stop）を受ける（実行中の Preflight・生成を取り消して記録してから止まる）
ENTRYPOINT ["p3"]
CMD ["serve", "--all-projects", "--host", "0.0.0.0"]
