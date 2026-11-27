import { SOURCE_SUBS } from "../features/requirements/cli/requirementCommands.ts";

/**
 * 読むだけの操作か（データのフォルダ・個人設定・ファイルを変えず、外の生成も始めない）。
 * 登録が1つだけでプロジェクトが決まったとき（via: only）に、読むだけなら警告して続け、ほかは止めるために使う（main.ts）。
 * 載っていない操作（新しいコマンド・知らないサブコマンド）は書く操作として扱う。サブコマンドの省略は各コマンドの既定に合わせる。
 * 引数の読み方（対象の ID とサブコマンドの見分け）は各コマンドのハンドラと同じにし、書き込みに変わるオプション（--sources-json など）も見る。
 */
export function readsOnly(cmd: string, args: string[], opts: Readonly<Record<string, unknown>> = {}): boolean {
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
    case "retrospective": {
      // retro [<要望>] [show]（retroCommands.ts と同じ読み方）
      const rest = sub !== undefined && !["show", "confirm", "judge"].includes(sub) ? args.slice(1) : args;
      return (rest[0] ?? "show") === "show";
    }
    case "premise":
    case "premises": {
      // premise [<要望>] [ls]（revisitCommands.ts と同じ読み方）
      const rest = sub !== undefined && !["add", "ack", "ls"].includes(sub) ? args.slice(1) : args;
      return (rest[0] ?? "ls") === "ls";
    }
    case "source":
    case "sources":
      return sourceReadsOnly(args, opts);
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

/**
 * source の一覧だけか（requirementCommands.ts の sourceCommand と同じ読み方）。--sources-json はファイルか標準入力の操作をまとめて当てるので、
 * 操作の語が無くても書く操作。対象が要望なら source [<要望>] [ls|show]、タスク・案なら source <T|D> [<基準>] [ls|show]
 */
function sourceReadsOnly(args: string[], opts: Readonly<Record<string, unknown>>): boolean {
  if (opts["sources-json"] !== undefined) return false;
  const head = args[0];
  const criterionTarget = !!head && /^(?:[^/]+\/)?[DT]\d+$/i.test(head);
  let rest = head !== undefined && !SOURCE_SUBS.has(head) ? args.slice(1) : args;
  if (criterionTarget && rest[0] !== undefined && !SOURCE_SUBS.has(rest[0])) rest = rest.slice(1);
  return rest[0] === undefined || rest[0] === "ls" || rest[0] === "show";
}
