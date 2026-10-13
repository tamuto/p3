/**
 * 画面の操作（ボタンなど）から待たずに走らせる非同期の処理。失敗は onError に文言で渡す
 * （未処理の拒否にして黙って消さない。画面の側で知らせ、必要なら読み直す）。
 * 失敗を自分で受け止める関数（try / catch で知らせるもの）は `void f()` で呼べばよく、これは要らない。
 */
export function runAction(f: () => Promise<unknown>, onError: (message: string) => void): void {
  const run = async () => {
    try {
      await f();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  void run();
}
