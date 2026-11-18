/**
 * 読むだけの操作か（データのフォルダ・個人設定・ファイルを変えず、外の生成も始めない）。
 * 登録が1つだけでプロジェクトが決まったとき（via: only）に、読むだけなら警告して続け、ほかは止めるために使う（main.ts）。
 * 載っていない操作（新しいコマンド・知らないサブコマンド）は書く操作として扱う。サブコマンドの省略は各コマンドの既定に合わせる。
 */
export function readsOnly(cmd: string, args: string[]): boolean {
  const sub = args[0];
  switch (cmd) {
    case "whoami":
    case "guide":
    case "progress":
    case "ls":
    case "list":
    case "show":
    case "find":
    case "resolve":
    case "notes":
    case "drafts":
    case "clarify":
    case "revisit":
      return true;
    case "retro":
    case "retrospective":
      return !args.includes("confirm") && !args.includes("judge");
    case "premise":
    case "premises":
      return !args.some((a) => a === "add" || a === "ack");
    case "source":
    case "sources":
      // 対象（要望・T001・D1）と基準の ID の後に操作が無ければ読むだけ
      return !args.some((a) => ["add", "edit", "set", "confirm", "rm", "remove"].includes(a));
    case "request":
    case "req":
      return sub === "ls" || sub === "list" || sub === "show";
    case "quality":
      return sub === undefined || sub === "show" || sub === "templates" || sub === "template";
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
