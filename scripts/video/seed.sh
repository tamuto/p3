#!/bin/bash
# 動画の ② 以降の前提: しばらく使ったあとの状態（v1.0 をリリース済み、次は v1.1）。p3 init の後に record.mjs が呼ぶ
set -euo pipefail
cd "$HOME/src/expense"
day() { date -d "$1 days" +%F; }
p3 milestone add v1.0 --title "初回リリース" --due $(day -12) >/dev/null
p3 milestone add v1.1 --title "領収書と通知" --due $(day 14) >/dev/null
past() { # タイトル 本文 タスク...
  local title=$1 body=$2; shift 2
  local rid=$(p3 request new "$title" --body "$body" --milestone v1.0 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
  local n=1
  for t in "$@"; do
    P3_ACTOR=ai:claude p3 new "$t" --req $rid >/dev/null
    printf '## 変えたこと\n- %s\n\n## なぜ\n- 要望 %s のため\n' "$t" "$title" | P3_ACTOR=ai:claude p3 move T00$n done --req $rid --output "https://github.com/example/expense/pull/$((RANDOM % 20 + 1))" --record - >/dev/null
    p3 check T00$n --req $rid >/dev/null
    n=$((n+1))
  done
  p3 request set $rid status=done >/dev/null
  echo $rid
}
past "経費の申請と一覧" "- 日付・金額・科目・目的を入力して申請する
- 自分の申請の一覧で状態を見る" "申請の入力と保存" "申請の一覧と状態の表示"
past "上長の承認と差し戻し" "- 上長が部下の申請を承認・差し戻しする" "承認と差し戻しの操作" "部下の申請だけに絞る権限"
p3 request new "差し戻しにコメントを付ける" --body "- 差し戻すときに理由を書けるようにする" >/dev/null
p3 release-notes save v1.0 --body - >/dev/null <<'X'
# expense v1.0

## できるようになったこと
- 経費を申請し、自分の申請の状態を一覧で確かめられます
- 上長が部下の申請を承認・差し戻しできます（部下の申請だけが表示されます）
X
p3 milestone set v1.0 --done >/dev/null
