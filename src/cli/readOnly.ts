/**
 * 読むだけの操作か（データのフォルダ・個人設定・ファイルを変えず、外の生成も始めない）。
 * 登録が1つだけでプロジェクトが決まったとき（via: only）に、読むだけなら警告して続け、ほかは止めるために使う（main.ts）。
 * 載っていない操作（新しいコマンド・知らないサブコマンド）は書く操作として扱う。サブコマンドの省略は各コマンドの既定に合わせる。
 */
export function readsOnly(cmd: string, args: string[]): boolean {
  const sub = args[0];
  switch (cmd) {
    case "whoami":
    case "progress":
    case "ls":
    case "list":
    case "show":
    case "find":
    case "resolve":
    case "notes":
    case "drafts":
      return true;
    case "request":
    case "req":
      return sub === "ls" || sub === "list" || sub === "show";
    case "milestone":
    case "milestones":
      return sub === undefined || sub === "ls" || sub === "list";
    case "config":
      return sub === undefined;
    case "repo":
    case "attach":
      return sub === undefined || sub === "ls";
    case "release-notes":
    case "release-note":
      return sub === undefined || sub === "ls" || sub === "list" || sub === "show" || sub === "export";
    default:
      return false;
  }
}
