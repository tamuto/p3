// pnpm check の最初（型検査の前）に、UI テストのブラウザ（Chromium headless shell）を起動できるかを確かめる。
// 使えなければ理由と入れ方を出して止める（判定は test/ui/chromium.ts。docs/development.md の「UI テスト」）
import { checkBrowser } from "../test/ui/chromium.ts";

const r = await checkBrowser();
if (!r.ok) {
  console.error(`✗ ${r.message}`);
  process.exit(1);
}
