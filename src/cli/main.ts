import { renderCommand } from "./render.ts";
import { daysUntil, localToday } from "../shared/dates.ts";
import { openProject } from "../core/context.ts";
import { machineSettingsSource, resolveMachineSettings, SettingsError } from "../core/machineSettings.ts";
import { progress, resolveRef, resolveRequestId, titleOf } from "../core/ops.ts";
import { OpRuleError } from "../core/requestOps.ts";
import { startServer } from "../server/server.ts";
import { ConflictError, NotFoundError } from "../core/store/collection.ts";
import { ProjectNotResolvedError, resolveProject } from "../core/store/locate.ts";
import { loadUserConfig, UserConfigError } from "../core/userConfig.ts";
import { codexCommand } from "./codex.ts";
import { userConfigCommand } from "./userConfig.ts";
import { chatgptCommand } from "./chatgpt.ts";
import { table } from "./format.ts";
import { config, currentRequest, init, locateHere, projectCommand, repoCommand, resolveActor, UsageError } from "./project.ts";
import { HELP } from "./help.ts";
import { parse, type CommandEnv } from "./args.ts";
import { Output, bar } from "./output.ts";
import { requestCommand, milestoneCommand } from "./requestCommands.ts";
import { taskCommand } from "./taskCommands.ts";
import { preflightCommand } from "./preflightCommands.ts";
import { releaseNotesCommand } from "./releaseNotesCommands.ts";
import { ReleaseNoteError } from "../core/releaseNotes/store.ts";
import { GenerationRejected } from "../core/releaseNotes/generate.ts";

/**
 * p3 CLI。人も AI エージェントも使う。
 *
 * サーバを経由せず、プロジェクトのデータのフォルダのファイルを直接読み書きする。
 * 操作するプロジェクトは --project、今いる場所（登録したリポジトリの中か）、個人設定から決める（store/locate.ts）。
 * だから認証は要らず、サーバが動いていれば変更は監視経由でそのまま画面に反映される。
 * AI は `--json` で機械可読な出力を得て、`P3_ACTOR=ai:<name>` で変更者を名乗る。
 *
 * 作業の単位は要望。タスクの操作は「今の要望」に対して行う。今の要望は --req、P3_REQUEST、
 * または要望の作業ツリー（ブランチ req/<要望ID>-...）から決まる。
 */

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parse(argv);
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const cwd = process.cwd();
  const out = new Output(o.json ?? false);

  if (cmd === "init") {
    console.log(
      await init({
        cwd,
        project: o.project,
        dir: o.dir,
        name: o.name,
        description: o.description,
        instructions: o.instructions,
        agents: o.agents,
        yes: o.yes,
        repoName: o["repo-name"],
      }),
    );
    return 0;
  }

  // ChatGPT との接続はこのマシンのもの（どのプロジェクトにも属さない）なので、プロジェクトを決める前に扱う
  if (cmd === "chatgpt") {
    const r = await chatgptCommand(args, o);
    out.result(r.data, () => r.text);
    return r.code ?? 0;
  }

  // Codex のイメージはこのマシンの Docker のもの。プロジェクト・認証が無くても更新できる
  if (cmd === "codex") {
    const r = await codexCommand(args);
    out.result(r.data, () => r.text);
    return r.code ?? 0;
  }

  // 描画はこのマシンの Docker のもの。プロジェクトが決まらなくても使える（パスの対応は個人設定から）
  if (cmd === "render") {
    const r = await renderCommand(args, o, resolveMachineSettings(await loadUserConfig(), process.env));
    out.result(r.data, () => r.text);
    return r.code ?? 0;
  }

  // 個人設定（このマシン・この人）。プロジェクトが決まらなくても使える
  if (cmd === "user-config") {
    const r = await userConfigCommand(args);
    return out.result(r.data, () => r.text);
  }

  const user = await loadUserConfig();
  if (cmd === "project") {
    let current: string | undefined;
    try {
      current = resolveProject({ cwd, dir: o.dir, project: o.project, user }).name;
    } catch {
      // 決まらなくても一覧は出す
    }
    const r = await projectCommand(cwd, args, o, current);
    return out.result(r.data, () => r.text);
  }

  const target = resolveProject({ cwd, dir: o.dir, project: o.project, user });
  // マシンごとの設定は環境変数と個人設定から（.env は読まない）
  const settings = resolveMachineSettings(user, process.env, { port: o.port, host: o.host });

  if (cmd === "serve") {
    // 待ち受け（host / port）は起動のときに決める。Codex と Preflight の設定は Preflight を始めるたびに個人設定から読み直す
    const source = machineSettingsSource({ cli: { port: o.port, host: o.host } });
    await startServer({ dataDir: target.dataDir, repos: target.repos, projectName: target.name, port: settings.serve.port, host: settings.serve.host, static: true, settings: source });
    return await new Promise<number>(() => {}); // 終了まで動き続ける
  }

  const ctx = await openProject(target.dataDir, { repos: target.repos, settings, projectName: target.name });
  const actor = resolveActor(o.actor ?? process.env.P3_ACTOR, cwd);
  const current = currentRequest(ctx, o.req ?? o.request ?? process.env.P3_REQUEST, cwd);
  const expectedRev = o.rev !== undefined ? Number(o.rev) : undefined;

  /** 要望の引数（省略時は今の要望） */
  const requestArg = (raw: string | undefined): string => {
    if (raw) {
      const id = resolveRequestId(ctx, raw);
      if (!id) throw new NotFoundError(raw);
      return id;
    }
    if (!current) throw new UsageError("要望を指定してください（引数か --req。要望の作業ツリーの中なら省略可）");
    return current;
  };
  /** タスクの引数（T003 は今の要望の中） */
  const taskArg = (raw: string | undefined): string => {
    if (!raw) throw new UsageError("タスクを指定してください（T003 / <要望>/T003）");
    const ref = resolveRef(ctx, raw, current);
    if (ref?.includes("/")) return ref;
    if (!ref && !raw.includes("/") && !current) throw new UsageError(`${raw}: 要望を --req で指定してください`);
    throw new NotFoundError(raw);
  };
  const split = (ref: string) => {
    const [rid, tid] = ref.split("/");
    return { col: ctx.ws.tasksOf(rid), rid, tid };
  };

  const env: CommandEnv = { ctx, out, args, o, actor, current, expectedRev, requestArg, taskArg, split, cwd, target };
  const handled = (await taskCommand(cmd, env)) ?? (await preflightCommand(cmd, env));
  if (handled !== undefined) return handled;

  switch (cmd) {
    case "config": {
      const r = await config(ctx.ws, args);
      return out.result(r.data, () => r.text);
    }

    case "repo": {
      const r = await repoCommand(ctx.ws, target.name, cwd, args, { local: o.local });
      return out.result(r.data, () => r.text);
    }

    case "whoami": {
      const here = locateHere(ctx, cwd);
      return out.result({ project: target.name ?? null, dataDir: target.dataDir, here: here.repos, branch: here.branch ?? null, actor, request: current ?? null }, () =>
        [
          `プロジェクト  ${target.name ?? "（未登録）"}  ${target.dataDir}`,
          `今いる参照先  ${here.repos.length ? here.repos.join(", ") : "（どの参照先の中でもない。p3 repo ls）"}${here.branch ? `  ブランチ ${here.branch}` : ""}`,
          `変更者        ${actor}`,
          `要望          ${current ? `${current}  ${titleOf(ctx, current)}` : "（なし）"}`,
        ].join("\n"),
      );
    }

    case "progress": {
      const ps = progress(ctx).filter((p) => o.all || !["done", "rejected"].includes(p.request.status));
      const today = localToday();
      return out.result(ps, () => {
        const groups = [
          ...ctx.ws.project.milestones.map((m) => ({ m, ps: ps.filter((p) => p.request.milestone === m.id) })),
          { m: undefined, ps: ps.filter((p) => !p.request.milestone) },
        ];
        return (
          groups
            .filter((g) => g.ps.length)
            .map((g) => {
              const done = g.ps.reduce((n, p) => n + p.done, 0);
              const total = g.ps.reduce((n, p) => n + p.total, 0);
              const head = g.m
                ? `■ ${g.m.title}（${g.m.id}${g.m.due ? ` · ${g.m.due}` : ""}${g.m.done ? " · リリース済み" : ""}）  タスク ${done}/${total}`
                : "■ マイルストーンなし";
              const rows = g.ps.map((p) => [
                `  ${p.request.id}`,
                p.request.status,
                `${bar(p.total ? p.done / p.total : 0)} ${p.done}/${p.total}`,
                p.request.due
                  ? `${p.request.due}${daysUntil(p.request.due, today) < 0 && !["done", "rejected"].includes(p.request.status) ? " 超過" : ""}`
                  : "",
                p.request.tags.map((t) => `#${t}`).join(" "),
                p.request.title,
              ]);
              return `${head}\n${table(rows)}`;
            })
            .join("\n\n") || "要望はありません"
        );
      });
    }

    case "milestone":
    case "milestones":
      return milestoneCommand(ctx, out, args, o);

    case "release-notes":
    case "release-note":
      return releaseNotesCommand(env);

    // --- 要望 ---------------------------------------------------------------
    case "request":
    case "req":
      return requestCommand(ctx, out, args, o, actor, requestArg, expectedRev);

    default:
      throw new UsageError(`不明なコマンド: ${cmd}（p3 help）`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConflictError) {
      process.stderr.write(`競合: ${e.message}。最新を取得してやり直してください\n`);
      process.exit(3);
    }
    if (e instanceof UserConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof SettingsError) {
      process.stderr.write(`設定: ${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof ProjectNotResolvedError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    // リリースノート: 無い → 2、版の競合・既にある → 3、読めない・ID が使えない → 1
    if (e instanceof ReleaseNoteError) {
      process.stderr.write(`${e.code === "conflict" ? "競合: " : ""}${e.message}\n`);
      process.exit(e.code === "not_found" ? 2 : e.code === "conflict" || e.code === "exists" ? 3 : 1);
    }
    // 生成を始められない（材料が無い・上限・実行中）。Codex は呼んでいない
    if (e instanceof GenerationRejected) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof NotFoundError) {
      process.stderr.write(`見つかりません: ${e.id}\n`);
      process.exit(2);
    }
    process.stderr.write(`${e instanceof UsageError || e instanceof OpRuleError ? "" : "エラー: "}${(e as Error).message}\n`);
    process.exit(1);
  },
);

