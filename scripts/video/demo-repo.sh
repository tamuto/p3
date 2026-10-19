#!/bin/bash
# 動画のデモの環境を作り直す: 使い捨ての HOME（$DEMO_HOME）と、架空の経費精算アプリのリポジトリ（~/src/expense）。
# p3 は ~/bin/p3 から、このチェックアウトのもの（$P3_BIN）を動かす。record.mjs が呼ぶ
set -euo pipefail
: "${DEMO_HOME:?}" "${P3_BIN:?}"
rm -rf "$DEMO_HOME"
mkdir -p "$DEMO_HOME"/bin "$DEMO_HOME"/src/expense/{docs,src/routes} "$DEMO_HOME"/.config
touch "$DEMO_HOME/.p3-video-demo" # 動画のために作ったことの印（無いフォルダは消さない）
printf '#!/bin/sh\nexec node %s "$@"\n' "$P3_BIN" > "$DEMO_HOME/bin/p3"
chmod +x "$DEMO_HOME/bin/p3"
cd "$DEMO_HOME/src/expense"
git init -q -b main
git config user.name demo
git config user.email demo@example.com
git config commit.gpgsign false
cat > README.md <<'X'
# expense

社内向けの経費精算アプリ。申請・承認・精算の3段階で、経理の確認を減らす。

- 申請者は経費を入力して申請する
- 上長が承認し、経理が精算する
X
cat > docs/index.md <<'X'
# 仕様

## 申請
- 日付・金額・科目・目的を入力する
- 申請の一覧で状態（下書き・申請中・承認済み・精算済み）を見る

## 承認
- 上長は自分の部下の申請だけを承認・差し戻しできる
X
echo 'export const routes = ["/claims", "/approvals"];' > src/routes/index.ts
echo 'export type Claim = { id: string; date: string; amount: number; category: string; purpose: string };' > src/claim.ts
git add -A
git commit -qm "最初の版"
