import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { RELATION_TYPES, relationTypes, type Relation, type RelationType, type Task } from "../shared/types.ts";
import { loadMachineEnv, openProject, type PcubeContext } from "../server/context.ts";
import { addRelation, listTasks, normalizeId, removeRelation, resolve } from "../server/ops.ts";
import { startServer } from "../server/server.ts";
import { ConflictError, NotFoundError } from "../server/store/collection.ts";
import { DATA_DIR_NAME, locateDataDir } from "../server/store/locate.ts";
import { table } from "./format.ts";
import { config, init, member, resolveActor, UsageError } from "./project.ts";

/**
 * pcube CLI。人も AI エージェントも使う。
 *
 * サーバを経由せず、データディレクトリ（.pcube/）のファイルを直接読み書きする。
 * だから認証は要らず、サーバが動いていれば変更は監視経由でそのまま画面に反映される。
 * AI は `--json` で機械可読な出力を得て、`PCUBE_ACTOR=ai:<name>` で変更者を名乗る。
 */

const HELP = `pcube — ファイルベースのタスク管理 CLI

使い方: pcube <コマンド> [引数] [オプション]

プロジェクト
  init                                  .pcube/ を作り初期設定する（端末では対話式）
                                        --name --description --docs a,b --member id:名前:メール
                                        --instructions 観点 --agents（AGENTS.md に追記） --yes
  config [set キー=値 ...]               設定の表示・変更  name description docs branchPattern
                                        worktreeDir instructions repo
  member [ls | add <id> | rm <id>]      メンバー  --name 表示名 --email メール --role 役割 --ai
  whoami                                CLI の変更者（git の user.email からメンバーを判定）
  serve [--port 4310] [--host 0.0.0.0]  ブラウザ用のビューアを起動

参照
  ls [tasks|requests]                   一覧  --status s1,s2  --request REQ  --area パス  -q 語句
  show <ID|語句>                         詳細と関係（明示・暗黙・影響範囲）
  find <語句>                            ID・タイトル・内容から対象を探す
  impact <ID>                           変更が波及する項目（推移的）

作成・更新
  new task <タイトル>                    --request REQ --status s --area a --label l --estimate 人日
                                        --start YYYY-MM-DD --due YYYY-MM-DD --assignee 名前 --body 本文|-
  new request <タイトル>                 --area a --body 本文|-
  set <ID> キー=値 ...                   title status assignee estimate start due progress request labels areas
                                        （値を空にすると消す。labels/areas はカンマ区切り）
  move <ID> <ステータス>                  かんばんの列を移動
  link <ID> <種類> <相手ID>              関係を張る  --note 理由 --confidence 0..1
  unlink <ID> <種類> <相手ID>            関係を外す
  archive <ID>                          .archive/ へ移す

Preflight
  preflight <REQ>                       評価・細分化を実行し、完了まで待つ  --engine codex|mock
  drafts <REQ>                          最新の評価とタスク案  --run PF-...
  accept <REQ>                          タスク案をタスク化  --run PF-...  --only T1,T2  --skip T3

共通オプション
  --dir パス     データディレクトリ（既定: git のメインの作業ツリー → 上位へ辿って .pcube/ を探す）
  --json        JSON で出力（AI 向け）
  --actor 名前   変更者（既定: $PCUBE_ACTOR → git の user.email が一致するメンバー → human:$USER）
  --rev 番号     楽観ロック。指定した rev でなければ更新しない（set / move）

関係の種類: ${relationTypes.map((t) => `${t}(${RELATION_TYPES[t].label})`).join(" ")}
`;

const OPTIONS = {
  dir: { type: "string" },
  json: { type: "boolean" },
  actor: { type: "string" },
  rev: { type: "string" },
  help: { type: "boolean", short: "h" },
  status: { type: "string" },
  request: { type: "string" },
  area: { type: "string", multiple: true },
  label: { type: "string", multiple: true },
  q: { type: "string", short: "q" },
  estimate: { type: "string" },
  start: { type: "string" },
  due: { type: "string" },
  assignee: { type: "string" },
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
  member: { type: "string", multiple: true },
  instructions: { type: "string" },
  agents: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  email: { type: "string" },
  role: { type: "string" },
  ai: { type: "boolean" },
  port: { type: "string" },
  host: { type: "string" },
} as const;

type Opts = ReturnType<typeof parse>["values"];
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
  if (cmd === "init") {
    const text = await init({
      cwd: process.cwd(),
      dir: o.dir,
      name: o.name,
      description: o.description,
      docs: o.docs,
      members: o.member,
      instructions: o.instructions,
      agents: o.agents,
      yes: o.yes,
    });
    console.log(text);
    return 0;
  }

  const dataDir = locateDataDir(process.cwd(), o.dir ?? process.env.PCUBE_DATA_DIR);
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
  const actor = resolveActor(ctx.ws, o.actor ?? process.env.PCUBE_ACTOR, process.cwd());
  /** メンバー以外を担当にしたら警告だけ出す（メンバー未登録のプロジェクトでは何もしない） */
  const checkAssignee = (a: string | undefined) => {
    if (a && ctx.ws.project.members.length && !ctx.ws.member(a)) {
      process.stderr.write(`警告: ${a} はメンバーにいません（pcube member add ${a}）\n`);
    }
  };
  const id = (raw: string | undefined, what = "ID") => {
    if (!raw) throw new UsageError(`${what} を指定してください`);
    const found = normalizeId(ctx, raw, what === "要望" ? "REQ" : "TASK");
    if (!found) throw new NotFoundError(raw);
    return found;
  };
  const expectedRev = o.rev !== undefined ? Number(o.rev) : undefined;

  switch (cmd) {
    case "config": {
      const r = await config(ctx.ws, args);
      return out.result(r.data, () => r.text);
    }

    case "member":
    case "members": {
      const r = await member(ctx.ws, args, o);
      return out.result(r.data, () => r.text);
    }

    case "whoami": {
      const m = ctx.ws.member(actor);
      return out.result({ actor, member: m ?? null }, () => `${actor}${m ? `  ${m.name}${m.role ? ` (${m.role})` : ""}` : "  （メンバー未登録）"}`);
    }

    case "ls":
    case "list": {
      if (args[0] === "requests" || args[0] === "req") {
        const reqs = ctx.ws.requests.list();
        return out.result(reqs, () => table(reqs.map((r) => [r.id, r.status, r.title, r.workstream?.branch ?? ""])));
      }
      const tasks = listTasks(ctx, { status: o.status?.split(","), request: o.request && id(o.request, "要望"), area: o.area?.[0], q: o.q });
      return out.result(tasks, () =>
        table(tasks.map((t) => [t.id, t.status, t.title, t.request ?? "", t.estimate !== undefined ? `${t.estimate}d` : "", t.assignee ? `@${t.assignee}` : ""])),
      );
    }

    case "show": {
      const query = args.join(" ");
      const target = normalizeId(ctx, query) ?? resolve(ctx, query).match;
      if (!target) return ambiguous(out, ctx, query);
      const item = ctx.ws.tasks.get(target) ?? ctx.ws.requests.get(target)!;
      const graph = ctx.index.neighborhood(target);
      return out.result({ item, graph, file: relative(process.cwd(), join(dataDir, target.startsWith("REQ") ? "requests" : "tasks", `${target}.md`)) }, () => {
        const lines = [`${item.id}  ${item.title}`, ""];
        const meta = Object.entries(item).filter(([k, v]) => !["id", "title", "body", "relations"].includes(k) && v !== undefined && !(Array.isArray(v) && !v.length));
        for (const [k, v] of meta) lines.push(`  ${k.padEnd(10)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
        if (item.body.trim()) lines.push("", indent(item.body.trim()));
        const title = (x: string) => ctx.ws.tasks.get(x)?.title ?? ctx.ws.requests.get(x)?.title ?? "?";
        if (graph.outgoing.length || graph.incoming.length) {
          lines.push("", "関係:");
          for (const e of graph.outgoing) lines.push(`  → ${RELATION_TYPES[e.type as RelationType]?.label ?? e.type}  ${e.to} ${title(e.to)}${e.origin !== "human" ? `  [${e.origin}${e.weight !== undefined ? ` ${e.weight}` : ""}]` : ""}`);
          for (const e of graph.incoming) lines.push(`  ← ${RELATION_TYPES[e.type as RelationType]?.inverse ?? e.type}  ${e.from} ${title(e.from)}`);
        }
        if (graph.implicit.length) {
          lines.push("", "関係しそう:");
          for (const r of graph.implicit) lines.push(`  ${r.score.toFixed(2)}  ${r.id} ${r.title}  (${r.reasons.join(" / ")})`);
        }
        if (graph.impactScope.length) lines.push("", `影響範囲: ${graph.impactScope.join(", ")}`);
        return lines.join("\n");
      });
    }

    case "find":
    case "resolve": {
      const r = resolve(ctx, args.join(" "));
      return out.result(r, () => table(r.candidates.map((c) => [c.id, c.score.toFixed(2), c.title, c.reasons.join(" / ")])) || "見つかりません");
    }

    case "impact": {
      const target = id(args[0]);
      const scope = ctx.index.impactScope(target);
      return out.result(scope, () => table(scope.map((x) => [x, ctx.ws.tasks.get(x)?.status ?? ctx.ws.requests.get(x)?.status ?? "", ctx.ws.tasks.get(x)?.title ?? ctx.ws.requests.get(x)?.title ?? ""])) || "なし");
    }

    case "new":
    case "add": {
      const [kind, ...rest] = args;
      const title = rest.join(" ").trim();
      if (!title) throw new UsageError("タイトルを指定してください");
      const body = readBody(o.body);
      if (kind === "request" || kind === "req") {
        const r = await ctx.ws.requests.create({ title, body, areas: o.area ?? [], relations: [], status: "draft" }, actor);
        return out.result(r, () => `作成: ${r.id}  ${r.title}`);
      }
      if (kind !== "task") throw new UsageError("new task か new request を指定してください");
      const status = o.status ?? ctx.ws.project.statuses[0]?.id ?? "backlog";
      checkStatus(ctx, status);
      checkAssignee(o.assignee);
      const t = await ctx.ws.tasks.create(
        {
          title,
          status,
          request: o.request ? id(o.request, "要望") : undefined,
          assignee: o.assignee,
          labels: o.label ?? [],
          areas: o.area ?? [],
          estimate: o.estimate !== undefined ? num(o.estimate, "estimate") : undefined,
          start: o.start && date(o.start),
          due: o.due && date(o.due),
          relations: [],
          body,
        },
        actor,
      );
      return out.result(t, () => `作成: ${t.id}  ${t.title}`);
    }

    case "set": {
      const target = id(args[0]);
      const patch = parseAssignments(ctx, target.startsWith("REQ") ? "request" : "task", args.slice(1), (raw) => id(raw, "要望"));
      if (o.body !== undefined) patch.body = readBody(o.body);
      if (!Object.keys(patch).length) throw new UsageError("キー=値 を指定してください");
      checkAssignee((patch as Partial<Task>).assignee);
      const col = target.startsWith("REQ") ? ctx.ws.requests : ctx.ws.tasks;
      const next = await col.update(target, patch as never, { expectedRev, actor });
      return out.result(next, () => `更新: ${next.id} (rev ${next.rev})  ${Object.keys(patch).join(", ")}`);
    }

    case "move": {
      const target = id(args[0]);
      const status = args[1];
      if (!status) throw new UsageError("移動先のステータスを指定してください");
      checkStatus(ctx, status);
      const next = await ctx.ws.tasks.update(target, { status }, { expectedRev, actor });
      return out.result(next, () => `${next.id} → ${status}`);
    }

    case "link":
    case "unlink": {
      const [from, type, to] = [id(args[0]), args[1], id(args[2], "相手の ID")];
      if (!type || !(type in RELATION_TYPES)) throw new UsageError(`関係の種類: ${relationTypes.join(", ")}`);
      if (cmd === "unlink") {
        const next = await removeRelation(ctx, from, { type, target: to }, actor);
        return out.result(next, () => `外しました: ${from} ${type} ${to}`);
      }
      const rel: Relation = { type: type as RelationType, target: to, note: o.note };
      if (o.confidence !== undefined) rel.confidence = num(o.confidence, "confidence");
      const next = await addRelation(ctx, from, rel, actor);
      return out.result(next, () => `張りました: ${from} ${RELATION_TYPES[rel.type].label} ${to}`);
    }

    case "archive": {
      const target = id(args[0]);
      await (target.startsWith("REQ") ? ctx.ws.requests : ctx.ws.tasks).archive(target);
      return out.result({ archived: target }, () => `アーカイブ: ${target}`);
    }

    case "preflight": {
      const req = id(args[0], "要望");
      const engine = o.engine as "codex" | "mock" | undefined;
      const off = ctx.ws.on((e) => {
        if (e.type === "preflight-log" && !out.json) process.stderr.write(`${e.entry.at.slice(11, 19)} ${e.entry.text}\n`);
      });
      const started = await ctx.preflight.start(req, { engine, actor });
      if (!out.json) process.stderr.write(`preflight ${started.id} (${started.engine})\n`);
      const run = await ctx.preflight.wait(req, started.id);
      off();
      if (!run) throw new Error("preflight の結果が読めません");
      out.result(run, () => formatRun(ctx, run.requestId, run));
      return run.status === "completed" ? 0 : 1;
    }

    case "drafts": {
      const req = id(args[0], "要望");
      const run = await pickRun(ctx, req, o.run);
      return out.result(run, () => formatRun(ctx, req, run));
    }

    case "accept": {
      const req = id(args[0], "要望");
      const run = await pickRun(ctx, req, o.run);
      const only = o.only?.split(",").map((s) => s.trim().toUpperCase());
      const skip = o.skip?.split(",").map((s) => s.trim().toUpperCase()) ?? [];
      for (const d of run.drafts) {
        const include = (only ? only.includes(d.key) : d.include) && !skip.includes(d.key);
        if (include !== d.include) await ctx.preflight.updateDraft(req, run.id, d.key, { include });
      }
      const created = await ctx.preflight.materialize(req, run.id, actor);
      return out.result(created, () => `タスク化 (${run.id}):\n${table(created.map((t) => [t.id, t.title, deps(t)]))}`);
    }

    default:
      throw new UsageError(`不明なコマンド: ${cmd}（pcube help）`);
  }
}

// --- helpers ---------------------------------------------------------------

class Output {
  constructor(readonly json: boolean) {}
  result(data: unknown, human: () => string): number {
    process.stdout.write(this.json ? `${JSON.stringify(data, null, 2)}\n` : `${human()}\n`);
    return 0;
  }
}

function ambiguous(out: Output, ctx: PcubeContext, query: string): number {
  const r = resolve(ctx, query);
  out.result(r, () =>
    r.candidates.length ? `候補が複数あります:\n${table(r.candidates.map((c) => [c.id, c.score.toFixed(2), c.title]))}` : `見つかりません: ${query}`,
  );
  return 1;
}

async function pickRun(ctx: PcubeContext, req: string, runId?: string) {
  const runs = await ctx.preflight.list(req);
  const run = runId ? runs.find((r) => r.id === runId) : runs[0];
  if (!run) throw new NotFoundError(runId ?? `${req} の preflight`);
  return run;
}

function formatRun(ctx: PcubeContext, req: string, run: Awaited<ReturnType<typeof pickRun>>): string {
  const lines = [`${req} / ${run.id}  ${run.engine}  ${run.status}`];
  if (run.error) lines.push(`エラー: ${run.error}`);
  const a = run.assessment;
  if (a) {
    lines.push("", `判定: ${a.verdict}  妥当性 ${a.validity.score} / 実現可能性 ${a.feasibility.score}`, indent(a.summary));
    if (a.risks.length) lines.push("", "リスク:", ...a.risks.map((x) => `  - ${x}`));
    if (a.questions.length) lines.push("", "確認事項:", ...a.questions.map((x) => `  - ${x}`));
    if (a.impacts.length) lines.push("", "既存項目への影響:", ...a.impacts.map((i) => `  ${i.type} ${i.target} (${i.confidence})  ${i.reason}`));
  }
  if (run.drafts.length) {
    const total = run.drafts.filter((d) => d.include).reduce((s, d) => s + d.estimateDays, 0);
    lines.push("", `タスク案 (${total} 人日):`);
    lines.push(table(run.drafts.map((d) => [d.include ? "[x]" : "[ ]", d.key, `${d.estimateDays}d`, d.title, d.dependsOn.length ? `← ${d.dependsOn.join(",")}` : ""])));
    lines.push("", `ファイル: ${relative(process.cwd(), join(ctx.ws.preflight.runDir(req, run.id), "drafts"))}/`);
  }
  if (run.materialized?.length) lines.push("", `タスク化済み: ${run.materialized.join(", ")}`);
  return lines.join("\n");
}

const SETTABLE = {
  task: ["title", "status", "assignee", "estimate", "start", "due", "progress", "request", "labels", "areas"],
  request: ["title", "status", "areas"],
};
const REQUEST_STATUSES = ["draft", "preflight", "reviewed", "accepted", "rejected"];

function parseAssignments(ctx: PcubeContext, kind: "task" | "request", pairs: string[], reqId: (raw: string) => string): Partial<Task> {
  const patch: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UsageError(`キー=値 の形で指定してください: ${pair}`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1).trim();
    if (!SETTABLE[kind].includes(key)) throw new UsageError(`変更できるキー: ${SETTABLE[kind].join(", ")}`);
    if (raw === "") {
      patch[key] = key === "labels" || key === "areas" ? [] : undefined;
      continue;
    }
    switch (key) {
      case "estimate":
      case "progress":
        patch[key] = num(raw, key);
        break;
      case "start":
      case "due":
        patch[key] = date(raw);
        break;
      case "labels":
      case "areas":
        patch[key] = raw.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "status":
        if (kind === "task") checkStatus(ctx, raw);
        else if (!REQUEST_STATUSES.includes(raw)) throw new UsageError(`要望のステータスは ${REQUEST_STATUSES.join(", ")} のいずれか`);
        patch[key] = raw;
        break;
      case "request":
        patch[key] = reqId(raw);
        break;
      default:
        patch[key] = raw;
    }
  }
  return patch as Partial<Task>;
}

function checkStatus(ctx: PcubeContext, status: string) {
  const ids = ctx.ws.project.statuses.map((s) => s.id);
  if (!ids.includes(status)) throw new UsageError(`ステータスは ${ids.join(", ")} のいずれか`);
}

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

const deps = (t: Task) => {
  const d = t.relations.filter((r) => r.type === "depends_on").map((r) => r.target);
  return d.length ? `← ${d.join(",")}` : "";
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
