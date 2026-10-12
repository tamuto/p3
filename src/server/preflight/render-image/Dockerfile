# P3 の画面イメージの描画（自己完結した HTML / CSS を PNG にする）。
#
# Codex のコンテナとは別のイメージ。P3（ホストのプロセス）が docker run で動かし、
# ネットワークなし・認証情報なし・リポジトリなしで、確かめた原稿（読むだけ）と出力のフォルダだけをマウントする。
# Playwright と Chromium（headless shell）の版は固定し、日本語のフォント（Noto CJK, SIL Open Font License 1.1）を入れる。
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

WORKDIR /render
RUN npm install --no-save --no-audit --no-fund --no-package-lock playwright@1.63.0 \
    && npx playwright install --with-deps --only-shell chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
    && useradd --create-home --uid 10001 render

COPY render.mjs /render/render.mjs

USER render
ENV HOME=/tmp
ENTRYPOINT ["node", "/render/render.mjs"]
