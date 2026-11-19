import { renderCommand } from "@infodb/p3-tasks/cli/render.ts";
import { machineSettingsSource, resolveMachineSettings } from "@infodb/p3-tasks/core/machineSettings.ts";
import { startServer, type RunningServer } from "../server/server.ts";
import { onlyRegistrationNotice, ProjectNotResolvedError, resolveProject } from "@infodb/p3-tasks/core/store/locate.ts";
import { loadUserConfig } from "@infodb/p3-tasks/core/userConfig.ts";
import { codexCommand } from "@infodb/p3-tasks/cli/codex.ts";
import { userConfigCommand } from "@infodb/p3-tasks/features/settings/cli/userConfig.ts";
import { chatgptCommand } from "@infodb/p3-tasks/cli/chatgpt.ts";
import { init, isAgentChoice, joinProject, placeAgents, projectCommand } from "./project.ts";
import { repoRoot, UsageError } from "@infodb/p3-kit/usage.ts";
import { HELP } from "./help.ts";
import { cliVersion, guide } from "./guide.ts";
import { setAppVersion } from "@infodb/p3-kit/appInfo.ts";
import { reportError, runTasksCommand } from "@infodb/p3-tasks/cli/tasksCli.ts";
import { agentsText, diagnoseAgents } from "./agentsStatus.ts";
import { readsOnly } from "@infodb/p3-tasks/cli/readOnly.ts";
import { checkRepeatedRepo, parse } from "@infodb/p3-tasks/cli/args.ts";
import { Output } from "@infodb/p3-tasks/cli/output.ts";
import { isPreflightRunner, PREFLIGHT_RUNNERS } from "@infodb/p3-tasks/shared/preflightRunner.ts";
import { observerCommand } from "@infodb/p3-observer/cli/observerCli.ts";
import { parseProducts } from "../shared/products.ts";

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
 *
 * 製品ごとの呼び方: 名前空間の無いコマンド（p3 ls・p3 request ... など）は今までどおり tasks。observer は p3 observer <サブコマンド> で、
 * tasks のプロジェクトの解決・個人設定を経ずに動かす（docs/architecture.md「p3-observer」）
 */

/**
 * SIGTERM（docker stop）・SIGINT（Ctrl-C）で止める。新しい要求を断り、実行中の Preflight・生成を取り消して終わるまで待ってから終わる。
 * 2回目の信号ではすぐ終わる
 */
function serveUntilSignal(server: RunningServer): Promise<number> {
  return new Promise<number>((done) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return done(1);
      stopping = true;
      process.stderr.write(`p3: ${signal} を受けたので止めます（実行中の Preflight・生成は取り消して記録します）\n`);
      void (async () => {
        try {
          const { pending } = await server.close();
          if (pending) process.stderr.write(`p3: 待ちきれずに止めました（終わっていない実行 ${pending} 件）\n`);
          done(pending ? 1 : 0);
        } catch (e) {
          process.stderr.write(`p3: 止める途中で失敗しました: ${(e as Error).message}\n`);
          done(1);
        }
      })();
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
  });
}

async function main(argv: string[]): Promise<number> {
  // 製品（tasks）が名乗る版は、配布の単位の版（この CLI のパッケージ）
  setAppVersion(cliVersion());
  const { values: o, positionals } = parse(argv);
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const cwd = process.cwd();
  const out = new Output(o.json ?? false);
  checkRepeatedRepo(cmd, o);

  // --force は p3 agents だけ（ほかのコマンドで黙って無視しない）
  if (o.force && cmd !== "agents") throw new UsageError("--force は p3 agents でだけ使えます");
  // --products は serve だけ。省くと tasks だけ（今までどおり）
  if (o.products !== undefined && cmd !== "serve") throw new UsageError("--products は p3 serve でだけ使えます（例: p3 serve --products tasks,observer）");
  const chosen = parseProducts(o.products);
  if ("error" in chosen) throw new UsageError(chosen.error);
  const products = chosen.products;
  if (cmd === "serve" && !products.includes("tasks")) {
    // tasks を使わない serve（今は observer だけ）。プロジェクトを決めない（--all-projects・--project・--dir は tasks のもの）
    const tasksOnly = (["all-projects", "project", "dir"] as const).filter((k) => o[k] !== undefined);
    if (tasksOnly.length) throw new UsageError(`${tasksOnly.map((k) => `--${k}`).join("・")} は tasks の serve の指定です。--products に tasks を含めてください（例: --products tasks,observer）`);
    if (args.length) throw new UsageError(`serve は位置引数を取りません: ${args.join(" ")}`);
    // 待ち受けの既定だけを個人設定から読む（壊れていても既定の値で起動する。登録・データは作らない）
    const user = await loadUserConfig().catch((e: Error) => {
      process.stderr.write(`⚠ ${e.message}（待ち受けは既定の値で起動します）\n`);
      return { settings: {} };
    });
    const settings = resolveMachineSettings(user, process.env, { port: o.port, host: o.host });
    return serveUntilSignal(await startServer({ products, port: settings.serve.port, host: settings.serve.host, static: true }));
  }

  // --all-projects は serve だけ。1つのプロジェクトを決める指定とは一緒に使えない（どちらかに黙って決めない）
  if (o["all-projects"]) {
    if (cmd !== "serve") throw new UsageError("--all-projects は p3 serve でだけ使えます");
    if (o.project !== undefined || o.dir !== undefined) {
      throw new UsageError("--all-projects と --project / --dir は一緒に使えません（1つのプロジェクトだけを開くなら --all-projects を外す）");
    }
    // プロジェクトを決めずに起動する（個人設定が壊れていても、画面で理由を見せて直せるように起動する）
    const user = await loadUserConfig().catch((e: Error) => {
      process.stderr.write(`⚠ ${e.message}（待ち受けは既定の値で起動します）\n`);
      return { settings: {} };
    });
    const settings = resolveMachineSettings(user, process.env, { port: o.port, host: o.host });
    const source = machineSettingsSource({ cli: { port: o.port, host: o.host } });
    return serveUntilSignal(await startServer({ allProjects: true, products, port: settings.serve.port, host: settings.serve.host, static: true, settings: source }));
  }

  // AI 向けの作業の手順。この CLI に同梱した原本を返すだけで、プロジェクトは決めない（未登録・壊れた定義でも読める）
  if (cmd === "guide") {
    if (args.length) throw new UsageError(`guide は位置引数を取りません: ${args.join(" ")}（p3 guide [--json]）`);
    const g = { ...guide(), agents: diagnoseAgents(cwd) };
    // 通常の出力は手順の本文だけ（JSON の guide と同じ）。入口に対応が要るときだけ、その要点を標準エラーに出す
    if (!o.json && !g.agents.ok) process.stderr.write(`p3: 置いた AI 向けの入口: ${agentsText(g.agents).join("\n")}\n`);
    out.result(g, () => g.guide.trimEnd());
    return 0;
  }

  // AI 向けの使い方を置く・最新にする。今いるリポジトリのルートに置くだけで、プロジェクトは決めない（データ・個人設定は変えない）
  if (cmd === "agents") {
    const [choice, ...rest] = args;
    const usage = "p3 agents claude|codex|both [--force]（置く先を選ぶ。省けません）";
    if (!isAgentChoice(choice) || rest.length) throw new UsageError(choice === undefined ? `置く先を指定してください: ${usage}` : `置く先は claude / codex / both のどれか: ${[choice, ...rest].join(" ")}（${usage}）`);
    if (o.agents !== undefined) throw new UsageError(`p3 agents に --agents は要りません（${usage}）`);
    const root = repoRoot(cwd);
    console.log([`AI 向けの使い方（${root}）`, ...(await placeAgents(root, cwd, choice, o.force))].join("\n"));
    return 0;
  }

  if (cmd === "join") {
    // 参加は個人設定に登録するだけ。AI 向けのファイルと、作るときだけの項目は受け付けない（黙って無視しない）
    if (o.agents !== undefined) throw new UsageError("join は AI 向けのファイルを置きません（--agents は使えません）。置く・最新にするなら p3 agents claude|codex|both");
    const createOnly = (["name", "description", "instructions", "preflight-runner"] as const).filter((k) => o[k] !== undefined);
    if (createOnly.length) throw new UsageError(`join では ${createOnly.map((k) => `--${k}`).join("・")} は使えません（共有の定義は変えません。変えるなら p3 config set）`);
    if (args.length) throw new UsageError(`join は位置引数を取りません: ${args.join(" ")}（p3 join [--project <名前>] [--dir <フォルダ>] [--repo-name <名前>]）`);
    console.log(await joinProject({ cwd, project: o.project, dir: o.dir, repoName: o["repo-name"], yes: o.yes }));
    return 0;
  }

  if (cmd === "init") {
    if (o.agents !== undefined && !isAgentChoice(o.agents)) throw new UsageError(`--agents は claude / codex / both のどれか（値を省くと both）: ${o.agents || "（空）"}`);
    if (args.length) throw new UsageError(`init は位置引数を取りません: ${args.join(" ")}`);
    const runner = o["preflight-runner"];
    if (runner !== undefined && !isPreflightRunner(runner)) throw new UsageError(`--preflight-runner は ${PREFLIGHT_RUNNERS.join(" / ")} のどれか: ${runner || "（空）"}`);
    console.log(
      await init({
        cwd,
        project: o.project,
        dir: o.dir,
        name: o.name,
        description: o.description,
        instructions: o.instructions,
        runner,
        agents: o.agents,
        yes: o.yes,
        repoName: o["repo-name"],
      }),
    );
    return 0;
  }

  // observer の名前空間。tasks のプロジェクトの解決・個人設定の読み込みより前に振り分ける（登録が無くても動き、tasks のデータ・登録を作らない）
  if (cmd === "observer") {
    const r = observerCommand(args);
    out.result(r.data, () => r.text);
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
  // 登録が1つだけで決まった（今いる場所では決まっていない）なら、変える操作は何も読み書きする前に止め、読むだけなら警告する
  if (target.via === "only") {
    const write = !readsOnly(cmd, args, o);
    if (write) throw new ProjectNotResolvedError(onlyRegistrationNotice(target, true));
    process.stderr.write(`${onlyRegistrationNotice(target, false)}\n`);
  }
  // マシンごとの設定は環境変数と個人設定から（.env は読まない）
  const settings = resolveMachineSettings(user, process.env, { port: o.port, host: o.host });

  if (cmd === "serve") {
    // 待ち受け（host / port）は起動のときに決める。Codex と Preflight の設定は Preflight を始めるたびに個人設定から読み直す
    const source = machineSettingsSource({ cli: { port: o.port, host: o.host } });
    return serveUntilSignal(
      await startServer({ dataDir: target.dataDir, repos: target.repos, projectName: target.name, products, port: settings.serve.port, host: settings.serve.host, static: true, settings: source }),
    );
  }

  return runTasksCommand({
    cmd,
    args,
    o,
    cwd,
    out,
    target,
    settings,
    agents: () => {
      const status = diagnoseAgents(cwd);
      return { status, lines: agentsText(status) };
    },
  });
}

/**
 * 標準出力・標準エラーを書き終えてから終わる。process.exit はパイプへの書き込みを待たないので、大きな出力（--json）を
 * パイプで渡すと途中で切れることがある
 */
function exit(code: number): void {
  let pending = 2;
  const done = () => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

main(process.argv.slice(2)).then(
  (code) => exit(code),
  (e: unknown) => exit(reportError(e)),
);
