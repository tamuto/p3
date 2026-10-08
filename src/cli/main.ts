import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { daysUntil, localToday } from "../shared/dates.ts";
import { absRef } from "../shared/refs.ts";
import { RELATION_TYPES, REQUEST_STATUSES, relationTypes, type Relation, type RelationType, type Request, type Task, TASK_STATUSES, isTaskStatus, type TaskStatus } from "../shared/types.ts";
import { loadMachineEnv, openProject, type PcubeContext } from "../server/context.ts";
import { addRelation, listTasks, progress, removeRelation, resolve, resolveRef, resolveRequestId, titleOf } from "../server/ops.ts";
import { startServer } from "../server/server.ts";
import { ConflictError, NotFoundError } from "../server/store/collection.ts";
import { DATA_DIR_NAME, locateDataDir } from "../server/store/locate.ts";
import { table } from "./format.ts";
import { config, currentRequest, init, resolveActor, UsageError } from "./project.ts";

/**
 * pcube CLI。人も AI エージェントも使う。
 *
 * サーバを経由せず、データディレクトリ（.pcube/）のファイルを直接読み書きする。
 * だから認証は要らず、サーバが動いていれば変更は監視経由でそのまま画面に反映される。
 * AI は `--json` で機械可読な出力を得て、`PCUBE_ACTOR=ai:<name>` で変更者を名乗る。
 *
 * 作業の単位は要望。タスクの操作は「今の要望」に対して行う。今の要望は --req、PCUBE_REQUEST、
 * または要望の作業ツリー（ブランチ req/<要望ID>-...）から決まる。
 */

const HELP = `pcube — 要望ごとにフォルダを分けて管理するファイルベースのタスク管理

使い方: pcube <コマンド> [引数] [オプション]

プロジェクト
  init                         .pcube/ を作り初期設定する（端末では対話式）
                               --name --description --docs a,b --instructions 観点 --agents --yes
  config [set キー=値 ...]      設定の表示・変更（name description docs branchPattern worktreeDir instructions repo）
  progress                     要望ごとの進捗（マイルストーンごと。--all で完了・見送りも）
  milestone [ls | add <id> | set <id> | rm <id>]  マイルストーン（リリース）  --title 名前 --due YYYY-MM-DD --done
  whoami                       変更者と今の要望
  serve [--port] [--host]      ブラウザ用のビューアを起動

要望
  request new <タイトル>         --body 本文|- --area パス --due YYYY-MM-DD --milestone id --tag t
  request ls                   一覧（--status draft,active ... --milestone id --tag t）
  request show [<要望>]
  request set [<要望>] キー=値   title status due milestone tags areas（status: ${REQUEST_STATUSES.join(" ")}）
  request archive <要望>

タスク（今の要望の中。--req <要望> で指定、要望の作業ツリーの中なら省略可）
  ls                           一覧  --status s1,s2  --area パス  -q 語句  --all（全要望）
  show <T003|要望|語句>          詳細と関係（明示・暗黙・影響範囲）
  new <タイトル>                 --body 本文|- --area a --label l --status
  set <T003> キー=値 ...         title status labels areas outputs（空で消す）
  move <T003> <ステータス>        --output URL/パス（成果物を足す）
  check <T003> [--off]         完了したタスクを人が確認して「済み」にする（--off で外す）
  link <T003> <種類> <相手>       --note 理由 --confidence 0..1（相手は T004 / <要望>/T004 / <要望>）
  unlink <T003> <種類> <相手>
  archive <T003>               .archive/ へ移す
  find <語句> / impact <T003>    対象を探す / 変更が波及する項目

Preflight
  preflight [<要望>]            評価・細分化を実行し、完了まで待つ  --engine codex|mock
  drafts [<要望>]               最新の評価とタスク案  --run PF-...
  accept [<要望>]               タスク案をタスク化  --run PF-...  --only D1,D2  --skip D3

共通オプション
  --dir パス     データディレクトリ（既定: git のメインの作業ツリー → 上位へ辿って .pcube/ を探す）
  --req 要望     今の要望（既定: $PCUBE_REQUEST → 要望の作業ツリー）。ID の一部（k7m3x）でもよい
  --json        JSON で出力（AI 向け）
  --actor 名前   変更者（既定: $PCUBE_ACTOR → human:<git の user.name>）
  --rev 番号     楽観ロック。指定した rev でなければ更新しない（set / move）

関係の種類: ${relationTypes.map((t) => `${t}(${RELATION_TYPES[t].label})`).join(" ")}
`;

const OPTIONS = {
  dir: { type: "string" },
  req: { type: "string" },
  request: { type: "string" },
  json: { type: "boolean" },
  actor: { type: "string" },
  rev: { type: "string" },
  help: { type: "boolean", short: "h" },
  all: { type: "boolean" },
  status: { type: "string" },
  area: { type: "string", multiple: true },
  label: { type: "string", multiple: true },
  output: { type: "string", multiple: true },
  q: { type: "string", short: "q" },
  due: { type: "string" },
  milestone: { type: "string" },
  tag: { type: "string", multiple: true },
  title: { type: "string" },
  done: { type: "boolean" },
  off: { type: "boolean" },
  body: { type: "string" },
  note: { type: "string" },
  confidence: { type: "string" },
  engine: { type: "string" },
  run: { type: "string" },
  only: { type: "string" },
  skip: { type: "string" },
  name: { type: "string" },
  repo: { type: "string" },
  description: { type: "string" },
  docs: { type: "string" },
  instructions: { type: "string" },
  agents: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  port: { type: "string" },
  host: { type: "string" },
} as const;

const parse = (argv: string[]) => parseArgs({ args: joinValues(argv), options: OPTIONS, allowPositionals: true });

/** `--body "- 箇条書き"` のように値が - で始まっても受け取れるよう、`--body=...` の形にまとめる */
function joinValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = /^--([a-z]+)$/.exec(argv[i])?.[1];
    const opt = name ? (OPTIONS as Record<string, { type: string }>)[name] : undefined;
    if (opt?.type === "string" && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out.push(`${argv[i]}=${argv[++i]}`);
    } else {
      out.push(argv[i]);
    }
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parse(argv);
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  loadMachineEnv();
  const cwd = process.cwd();

  if (cmd === "init") {
    console.log(
      await init({ cwd, dir: o.dir, name: o.name, description: o.description, docs: o.docs, instructions: o.instructions, agents: o.agents, yes: o.yes }),
    );
    return 0;
  }

  const dataDir = locateDataDir(cwd, o.dir ?? process.env.PCUBE_DATA_DIR);
  if (!dataDir) throw new UsageError(`${DATA_DIR_NAME}/ が見つかりません。リポジトリのルートで \`pcube init\` してください`);

  if (cmd === "serve") {
    await startServer({
      dataDir,
      port: Number(o.port ?? process.env.PCUBE_PORT ?? 4310),
      host: o.host ?? process.env.PCUBE_HOST ?? "0.0.0.0",
      static: true,
    });
    return await new Promise<number>(() => {}); // 終了まで動き続ける
  }

  const ctx = await openProject(dataDir);
  const out = new Output(o.json ?? false);
  const actor = resolveActor(o.actor ?? process.env.PCUBE_ACTOR, cwd);
  const current = currentRequest(ctx, o.req ?? o.request ?? process.env.PCUBE_REQUEST, cwd);
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

  switch (cmd) {
    case "config": {
      const r = await config(ctx.ws, args);
      return out.result(r.data, () => r.text);
    }

    case "whoami":
      return out.result({ actor, request: current ?? null }, () =>
        [`変更者  ${actor}`, `要望    ${current ? `${current}  ${titleOf(ctx, current)}` : "（なし）"}`].join("\n"),
      );

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

    // --- 要望 ---------------------------------------------------------------
    case "request":
    case "req":
      return requestCommand(ctx, out, args, o, actor, requestArg, expectedRev);

    // --- タスク -------------------------------------------------------------
    case "ls":
    case "list": {
      const filter = { status: o.status?.split(","), area: o.area?.[0], q: o.q };
      const tasks = listTasks(ctx, { ...filter, request: o.all ? undefined : requestArg(undefined) });
      return out.result(tasks, () =>
        table(tasks.map((t) => [o.all ? t.ref : t.id, t.status, t.title, deps(t)])) || "タスクはありません",
      );
    }

    case "show": {
      const query = args.join(" ");
      const ref = resolveRef(ctx, query, current) ?? resolve(ctx, query, current).match;
      if (!ref) return ambiguous(out, ctx, query, current);
      if (!ref.includes("/")) return requestCommand(ctx, out, ["show", ref], o, actor, requestArg, expectedRev);
      const item = ctx.ws.requireTask(ref);
      const graph = ctx.index.neighborhood(ref);
      const file = relative(cwd, split(ref).col.path(item.id));
      return out.result({ item, graph, file }, () => formatEntity(ctx, item, graph, file));
    }

    case "find":
    case "resolve": {
      const r = resolve(ctx, args.join(" "), current);
      return out.result(r, () => table(r.candidates.map((c) => [c.ref, c.score.toFixed(2), c.title, c.reasons.join(" / ")])) || "見つかりません");
    }

    case "impact": {
      const ref = taskArg(args[0]);
      const scope = ctx.index.impactScope(ref);
      return out.result(scope, () => table(scope.map((x) => [x, ctx.ws.task(x)?.status ?? ctx.ws.requests.get(x)?.status ?? "", titleOf(ctx, x)])) || "なし");
    }

    case "new":
    case "add": {
      // 互換: new task <タイトル> / new request <タイトル>
      if (args[0] === "request" || args[0] === "req") return requestCommand(ctx, out, ["new", ...args.slice(1)], o, actor, requestArg, expectedRev);
      const title = (args[0] === "task" ? args.slice(1) : args).join(" ").trim();
      if (!title) throw new UsageError("タイトルを指定してください");
      const rid = requestArg(undefined);
      const status = o.status ?? "todo";
      checkStatus(status);
      const t = await ctx.ws.tasksOf(rid).create(
        {
          title,
          status,
          labels: o.label ?? [],
          areas: o.area ?? [],
          outputs: o.output ?? [],
          body: readBody(o.body),
        },
        actor,
      );
      return out.result(t, () => `作成: ${t.ref}  ${t.title}`);
    }

    case "set": {
      const ref = taskArg(args[0]);
      const patch = parseTaskAssignments(args.slice(1));
      if (o.body !== undefined) patch.body = readBody(o.body);
      if (!Object.keys(patch).length) throw new UsageError("キー=値 を指定してください");
      const { col, tid } = split(ref);
      const next = await col.update(tid, patch, { expectedRev, actor });
      return out.result(next, () => `更新: ${next.ref} (rev ${next.rev})  ${Object.keys(patch).join(", ")}`);
    }

    case "move": {
      const ref = taskArg(args[0]);
      const status = args[1];
      if (!status) throw new UsageError("移動先のステータスを指定してください");
      checkStatus(status);
      const { col, tid } = split(ref);
      const cur = col.require(tid);
      const patch: Partial<Task> = { status };
      if (o.output?.length) patch.outputs = [...new Set([...cur.outputs, ...o.output])];
      const next = await col.update(tid, patch, { expectedRev, actor });
      return out.result(next, () => `${next.ref} → ${status}${o.output?.length ? `  (${o.output.join(", ")})` : ""}`);
    }

    case "check": {
      const ref = taskArg(args[0]);
      const { col, tid } = split(ref);
      const cur = col.require(tid);
      if (!o.off && cur.status !== "done") {
        throw new UsageError(`${ref} はまだ完了していません（済みにできるのは完了したタスクだけ）`);
      }
      const next = await col.update(tid, { checkedAt: o.off ? undefined : new Date().toISOString() }, { expectedRev, actor });
      return out.result(next, () => `${next.ref} ${o.off ? "の済みを外しました" : "を済みにしました"}`);
    }

    case "link":
    case "unlink": {
      const ref = taskArg(args[0]);
      const type = args[1];
      if (!type || !(type in RELATION_TYPES)) throw new UsageError(`関係の種類: ${relationTypes.join(", ")}`);
      const target = resolveRef(ctx, args[2] ?? "", ref.split("/")[0]);
      if (!target) throw new NotFoundError(args[2] ?? "（相手）");
      if (cmd === "unlink") {
        const next = await removeRelation(ctx, ref, { type, target }, actor);
        return out.result(next, () => `外しました: ${ref} ${type} ${target}`);
      }
      const rel: Relation = { type: type as RelationType, target, note: o.note };
      if (o.confidence !== undefined) rel.confidence = num(o.confidence, "confidence");
      const next = await addRelation(ctx, ref, rel, actor);
      return out.result(next, () => `張りました: ${ref} ${RELATION_TYPES[rel.type].label} ${target}`);
    }

    case "archive": {
      const ref = taskArg(args[0]);
      const { col, tid } = split(ref);
      await col.archive(tid);
      return out.result({ archived: ref }, () => `アーカイブ: ${ref}`);
    }

    // --- Preflight ----------------------------------------------------------
    case "preflight": {
      const rid = requestArg(args[0]);
      const engine = o.engine as "codex" | "mock" | undefined;
      const off = ctx.ws.on((e) => {
        if (e.type === "preflight-log" && !out.json) process.stderr.write(`${e.entry.at.slice(11, 19)} ${e.entry.text}\n`);
      });
      const started = await ctx.preflight.start(rid, { engine, actor });
      if (!out.json) process.stderr.write(`preflight ${started.id} (${started.engine})\n`);
      const run = await ctx.preflight.wait(rid, started.id);
      off();
      if (!run) throw new Error("preflight の結果が読めません");
      out.result(run, () => formatRun(ctx, rid, run));
      return run.status === "completed" ? 0 : 1;
    }

    case "drafts": {
      const rid = requestArg(args[0]);
      const run = await pickRun(ctx, rid, o.run);
      return out.result(run, () => formatRun(ctx, rid, run));
    }

    case "accept": {
      const rid = requestArg(args[0]);
      const run = await pickRun(ctx, rid, o.run);
      const keys = (s: string | undefined) => s?.split(",").map((x) => x.trim().toUpperCase());
      const only = keys(o.only);
      const skip = keys(o.skip) ?? [];
      for (const d of run.drafts) {
        const include = (only ? only.includes(d.key) : d.include) && !skip.includes(d.key);
        if (include !== d.include) await ctx.preflight.updateDraft(rid, run.id, d.key, { include });
      }
      const created = await ctx.preflight.materialize(rid, run.id, actor);
      return out.result(created, () => `タスク化 (${rid} / ${run.id}):\n${table(created.map((t) => [t.id, t.title, deps(t)]))}`);
    }

    default:
      throw new UsageError(`不明なコマンド: ${cmd}（pcube help）`);
  }
}

// --- 要望 -----------------------------------------------------------------

async function requestCommand(
  ctx: PcubeContext,
  out: Output,
  args: string[],
  o: ReturnType<typeof parse>["values"],
  actor: string,
  requestArg: (raw: string | undefined) => string,
  expectedRev: number | undefined,
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "new":
    case "add": {
      const title = rest.join(" ").trim();
      if (!title) throw new UsageError("タイトルを指定してください");
      if (o.milestone) checkMilestone(ctx, o.milestone);
      const r = await ctx.ws.requests.create(
        { title, body: readBody(o.body), areas: o.area ?? [], tags: o.tag ?? [], due: o.due && date(o.due), milestone: o.milestone, status: "draft" },
        actor,
      );
      return out.result(r, () => `作成: ${r.id}  ${r.title}\n  ${relative(process.cwd(), ctx.ws.requests.path(r.id))}`);
    }
    case undefined:
    case "ls":
    case "list": {
      const status = o.status?.split(",");
      const reqs = ctx.ws.requests
        .list()
        .filter((r) => !status || status.includes(r.status))
        .filter((r) => !o.milestone || r.milestone === o.milestone)
        .filter((r) => !o.tag?.length || o.tag.some((t) => r.tags.includes(t)));
      return out.result(reqs, () =>
        table(reqs.map((r) => [r.id, r.status, r.title, r.milestone ?? "", r.due ?? "", r.tags.map((t) => `#${t}`).join(" ")])) || "要望はありません",
      );
    }
    case "show": {
      const rid = requestArg(rest[0]);
      const r = ctx.ws.requests.require(rid);
      const graph = ctx.index.neighborhood(rid);
      const file = relative(process.cwd(), ctx.ws.requests.path(rid));
      return out.result({ item: r, tasks: ctx.ws.tasksOf(rid).list(), graph, file }, () => {
        const tasks = ctx.ws.tasksOf(rid).list();
        return [
          formatEntity(ctx, r, graph, file),
          "",
          `タスク (${tasks.length}):`,
          table(tasks.map((t) => [`  ${t.id}`, t.status, t.title, deps(t)])) || "  （なし）",
        ].join("\n");
      });
    }
    case "set": {
      // 1つ目が要望の参照なら対象、キー=値なら今の要望
      const explicit = rest[0] && !rest[0].includes("=") ? rest.shift() : undefined;
      const rid = requestArg(explicit);
      const patch: Partial<Request> = {};
      for (const pair of rest) {
        const [key, value] = splitPair(pair);
        if (key === "title") patch.title = value;
        else if (key === "areas") patch.areas = list(value);
        else if (key === "tags") patch.tags = list(value);
        else if (key === "due") patch.due = value ? date(value) : undefined;
        else if (key === "milestone") {
          if (value) checkMilestone(ctx, value);
          patch.milestone = value || undefined;
        }
        else if (key === "status") {
          if (!REQUEST_STATUSES.includes(value as Request["status"])) throw new UsageError(`要望のステータスは ${REQUEST_STATUSES.join(", ")}`);
          patch.status = value as Request["status"];
        } else throw new UsageError("変更できるキー: title status due milestone tags areas");
      }
      if (o.body !== undefined) patch.body = readBody(o.body);
      if (!Object.keys(patch).length) throw new UsageError("キー=値 を指定してください");
      const next = await ctx.ws.requests.update(rid, patch, { expectedRev, actor });
      return out.result(next, () => `更新: ${next.id} (rev ${next.rev})  ${Object.keys(patch).join(", ")}`);
    }
    case "archive": {
      const rid = requestArg(rest[0]);
      await ctx.ws.requests.archive(rid);
      return out.result({ archived: rid }, () => `アーカイブ: ${rid}（requests/.archive/ へ）`);
    }
    default:
      throw new UsageError("pcube request [new | ls | show | set | archive]");
  }
}

// --- マイルストーン -----------------------------------------------------------

function checkMilestone(ctx: PcubeContext, id: string) {
  if (!ctx.ws.project.milestones.some((m) => m.id === id)) throw new UsageError(`マイルストーンがありません: ${id}（pcube milestone add ${id}）`);
}

/** マイルストーン（リリース）。複数の要望をまとめる単位で、project.yaml に書く */
async function milestoneCommand(ctx: PcubeContext, out: Output, args: string[], o: ReturnType<typeof parse>["values"]): Promise<number> {
  const [sub, id] = args;
  const ms = ctx.ws.project.milestones;
  const count = (mid: string) => ctx.ws.requests.list().filter((r) => r.milestone === mid).length;
  if (sub === "add" || sub === "set") {
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError(`pcube milestone ${sub} <id>（英数字と . _ -）`);
    const cur = ms.find((m) => m.id === id);
    if (sub === "add" && cur) throw new UsageError(`既にあります: ${id}（変えるなら pcube milestone set）`);
    if (sub === "set" && !cur) throw new UsageError(`マイルストーンがありません: ${id}`);
    const next = {
      id,
      title: o.title ?? cur?.title ?? id,
      due: o.due !== undefined ? (o.due ? date(o.due) : undefined) : cur?.due,
      done: o.done ?? cur?.done,
    };
    await ctx.ws.saveProject({ milestones: cur ? ms.map((m) => (m.id === id ? next : m)) : [...ms, next] });
    return out.result(next, () => `${cur ? "更新" : "追加"}しました: ${next.title}（${id}${next.due ? ` · ${next.due}` : ""}）`);
  }
  if (sub === "rm" || sub === "remove") {
    if (!id || !ms.some((m) => m.id === id)) throw new UsageError(`マイルストーンがありません: ${id ?? ""}`);
    if (count(id)) throw new UsageError(`${id} を使っている要望があります（${count(id)} 件）。要望の milestone を外してから消してください`);
    await ctx.ws.saveProject({ milestones: ms.filter((m) => m.id !== id) });
    return out.result({ removed: id }, () => `外しました: ${id}`);
  }
  if (sub && sub !== "ls" && sub !== "list") throw new UsageError("pcube milestone [ls | add <id> | set <id> | rm <id>]");
  return out.result(
    ms,
    () =>
      table(ms.map((m) => [m.id, m.title, m.due ?? "", m.done ? "済" : "", `要望 ${count(m.id)}`])) ||
      "マイルストーンはありません（pcube milestone add v0.1 --title 最初のリリース --due 2026-11-30）",
  );
}

// --- 表示 -----------------------------------------------------------------

class Output {
  constructor(readonly json: boolean) {}
  result(data: unknown, human: () => string): number {
    process.stdout.write(this.json ? `${JSON.stringify(data, null, 2)}\n` : `${human()}\n`);
    return 0;
  }
}

function formatEntity(ctx: PcubeContext, item: Task | Request, graph: ReturnType<PcubeContext["index"]["neighborhood"]>, file: string): string {
  const head = "ref" in item ? item.ref : item.id;
  const home = "ref" in item ? item.request : item.id;
  /** 同じ要望の中は T003 と短く見せる */
  const short = (ref: string) => (ref.startsWith(`${home}/`) ? ref.slice(home.length + 1) : ref);
  const lines = [`${head}  ${item.title}`, ""];
  const skip = new Set(["id", "ref", "request", "title", "body", "relations"]);
  for (const [k, v] of Object.entries(item)) {
    if (skip.has(k) || v === undefined || (Array.isArray(v) && !v.length)) continue;
    lines.push(`  ${k.padEnd(13)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (item.body.trim()) lines.push("", indent(item.body.trim()));
  if (graph.outgoing.length || graph.incoming.length) {
    lines.push("", "関係:");
    for (const e of graph.outgoing) {
      const origin = e.origin !== "human" ? `  [${e.origin}${e.weight !== undefined ? ` ${e.weight}` : ""}]` : "";
      lines.push(`  → ${RELATION_TYPES[e.type].label}  ${short(e.to)} ${titleOf(ctx, e.to)}${origin}`);
    }
    for (const e of graph.incoming) lines.push(`  ← ${RELATION_TYPES[e.type].inverse}  ${short(e.from)} ${titleOf(ctx, e.from)}`);
  }
  if (graph.implicit.length) {
    lines.push("", "関係しそう:");
    for (const r of graph.implicit) lines.push(`  ${r.score.toFixed(2)}  ${short(r.ref)} ${r.title}  (${r.reasons.join(" / ")})`);
  }
  if (graph.impactScope.length) lines.push("", `影響範囲: ${graph.impactScope.map(short).join(", ")}`);
  lines.push("", `ファイル: ${file}`);
  return lines.join("\n");
}

function ambiguous(out: Output, ctx: PcubeContext, query: string, current?: string): number {
  const r = resolve(ctx, query, current);
  out.result(r, () =>
    r.candidates.length ? `候補が複数あります:\n${table(r.candidates.map((c) => [c.ref, c.score.toFixed(2), c.title]))}` : `見つかりません: ${query}`,
  );
  return 1;
}

async function pickRun(ctx: PcubeContext, rid: string, runId?: string) {
  const runs = await ctx.preflight.list(rid);
  const run = runId ? runs.find((r) => r.id === runId) : runs[0];
  if (!run) throw new NotFoundError(runId ?? `${rid} の preflight`);
  return run;
}

function formatRun(ctx: PcubeContext, rid: string, run: Awaited<ReturnType<typeof pickRun>>): string {
  const lines = [`${rid} / ${run.id}  ${run.engine}  ${run.status}`];
  if (run.error) lines.push(`エラー: ${run.error}`);
  const a = run.assessment;
  if (a) {
    lines.push("", `判定: ${a.verdict}  妥当性 ${a.validity.score} / 実現可能性 ${a.feasibility.score}`, indent(a.summary));
    if (a.risks.length) lines.push("", "リスク:", ...a.risks.map((x) => `  - ${x}`));
    if (a.questions.length) lines.push("", "確認事項:", ...a.questions.map((x) => `  - ${x}`));
    if (a.impacts.length) lines.push("", "既存項目への影響:", ...a.impacts.map((i) => `  ${i.type} ${i.target} (${i.confidence})  ${i.reason}`));
  }
  if (run.drafts.length) {
    lines.push("", `タスク案 (${run.drafts.filter((d) => d.include).length}/${run.drafts.length} 件を採用):`);
    lines.push(table(run.drafts.map((d) => [d.include ? "[x]" : "[ ]", d.key, d.title, d.dependsOn.length ? `← ${d.dependsOn.join(",")}` : ""])));
    lines.push("", `ファイル: ${relative(process.cwd(), join(ctx.ws.preflight.runDir(rid, run.id), "drafts"))}/`);
  }
  if (run.materialized?.length) lines.push("", `タスク化済み: ${run.materialized.join(", ")}`);
  return lines.join("\n");
}

// --- 入力 -----------------------------------------------------------------

const TASK_KEYS = ["title", "status", "labels", "areas", "outputs"];

function parseTaskAssignments(pairs: string[]): Partial<Task> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const [key, raw] = splitPair(pair);
    if (!TASK_KEYS.includes(key)) throw new UsageError(`変更できるキー: ${TASK_KEYS.join(", ")}`);
    if (raw === "") {
      patch[key] = key === "labels" || key === "areas" || key === "outputs" ? [] : undefined;
      continue;
    }
    if (key === "labels" || key === "areas" || key === "outputs") patch[key] = list(raw);
    else if (key === "status") {
      checkStatus(raw);
      patch[key] = raw;
    } else patch[key] = raw;
  }
  return patch as Partial<Task>;
}

function splitPair(pair: string): [string, string] {
  const eq = pair.indexOf("=");
  if (eq < 1) throw new UsageError(`キー=値 の形で指定してください: ${pair}`);
  return [pair.slice(0, eq), pair.slice(eq + 1).trim()];
}

function checkStatus(status: string | undefined): asserts status is TaskStatus {
  if (!isTaskStatus(status)) throw new UsageError(`ステータスは ${TASK_STATUSES.join(", ")} のいずれか`);
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

function num(v: string, name: string) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`${name} は数値で指定してください`);
  return n;
}

function date(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new UsageError(`日付は YYYY-MM-DD: ${v}`);
  return v;
}

function readBody(v: string | undefined): string {
  if (v === undefined) return "";
  return v === "-" ? readFileSync(0, "utf8") : v;
}

/** 依存先（同じ要望なら T003、別の要望なら絶対参照） */
const deps = (t: Task) => {
  const d = t.relations.filter((r) => r.type === "depends_on").map((r) => (absRef(r.target, t.request)?.startsWith(`${t.request}/`) ? r.target : (absRef(r.target, t.request) ?? r.target)));
  return d.length ? `← ${d.join(",")}` : "";
};

const bar = (ratio: number, width = 10) => {
  const n = Math.round(ratio * width);
  return `${"█".repeat(n)}${"░".repeat(width - n)}`;
};

const indent = (s: string) => s.split("\n").map((l) => `  ${l}`).join("\n");

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ConflictError) {
      process.stderr.write(`競合: ${e.message}。最新を取得してやり直してください\n`);
      process.exit(3);
    }
    if (e instanceof NotFoundError) {
      process.stderr.write(`見つかりません: ${e.id}\n`);
      process.exit(2);
    }
    process.stderr.write(`${e instanceof UsageError ? "" : "エラー: "}${(e as Error).message}\n`);
    process.exit(1);
  },
);
