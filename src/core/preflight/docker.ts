import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Preflight が使う docker の操作に、待つ時間の上限と取消を持たせる（261103-gtfcg/T003）。
 * 以前は版の確認（docker run ... codex --version）・ビルド・inspect に上限が無く、版を出力した後も終わらないコンテナを待って
 * Preflight が止まった。時間切れ・取消では docker の CLI を止め、名前を付けて起こしたコンテナはそのコンテナだけを消す
 * （docker ps の全部・イメージ名では消さない）。
 */

/** 上限の既定（テストは短くする。docs/architecture.md の「Docker の待ち時間の上限」） */
export const DOCKER_LIMITS = {
  /** docker version / image inspect など、デーモンに聞くだけの操作 */
  inspectMs: 15_000,
  /** 版の確認（docker run --rm ... codex --version） */
  versionMs: 60_000,
  /** イメージのビルド（Codex を入れ直す） */
  buildMs: 10 * 60_000,
  /** コンテナを消す（docker rm -f） */
  removeMs: 10_000,
  /** 中止を頼んでも app-server が応答しないとき、打ち切るまで待つ時間 */
  abortGraceMs: 15_000,
};

/** P3 が起こしたコンテナに付けるラベル（消すときは名前で指す。ラベルは人が見分けるため） */
export const CONTAINER_LABEL = "infodb.p3";

/** 時間切れ・取消で止めた（stage は何をしていたか） */
export class DockerAbortError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: "timeout" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

/** docker の CLI の失敗（終了コード・stderr） */
export class DockerCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
    readonly cmd: string,
  ) {
    super(message);
  }
}

export interface DockerExecOptions {
  /** 何をしているか（ログ・エラーの文） */
  stage: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
}

/**
 * docker の CLI を動かして終わりを待つ。timeoutMs を過ぎるか signal で止めると、CLI を SIGTERM（2 秒後に SIGKILL）で止めて
 * DockerAbortError。終了コードが 0 でなければ DockerCommandError。起動できなければ（ENOENT など）そのエラー
 */
export function dockerExec(docker: string, args: string[], o: DockerExecOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new DockerAbortError(o.stage, "aborted", `${o.stage}を中止しました`));
    const child = spawn(docker, args, { stdio: ["ignore", "pipe", "pipe"] });
    const max = o.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString();
    });
    let stopped: DockerAbortError | undefined;
    const stop = (reason: "timeout" | "aborted") => {
      if (stopped || child.exitCode !== null) return;
      stopped = new DockerAbortError(
        o.stage,
        reason,
        reason === "timeout" ? `${o.stage}が ${Math.round(o.timeoutMs / 1000)} 秒で終わらないので止めました` : `${o.stage}を中止しました`,
      );
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => stop("timeout"), o.timeoutMs);
    const onAbort = () => stop("aborted");
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (e) => {
      done();
      reject(e);
    });
    child.once("close", (code) => {
      done();
      if (stopped) return reject(stopped);
      if (code === 0) return resolve({ stdout, stderr });
      const cmd = [docker, ...args].join(" ");
      reject(new DockerCommandError(`${o.stage}に失敗しました（終了コード ${code}）: ${lastLine(stderr) ?? ""}`, code, stderr, cmd));
    });
  });
}

/** P3 が起こすコンテナの名前（docker の名前の規則 [a-zA-Z0-9][a-zA-Z0-9_.-]+ に合わせる） */
export function containerName(kind: string, id?: string): string {
  const base = `p3-${kind}${id ? `-${id}` : ""}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `${base}-${randomBytes(3).toString("hex")}`;
}

/** docker run の引数に名前とラベルを足す（"run" の直後。docker run 以外の形なら変えない） */
export function withContainerName(command: string[], name: string, labels: Record<string, string>): string[] {
  const at = command.indexOf("run");
  if (at !== 1) return command;
  const label = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  return [...command.slice(0, at + 1), "--name", name, ...label, ...command.slice(at + 1)];
}

export type RemoveResult = { state: "removed" } | { state: "gone" } | { state: "failed"; reason: string };

/**
 * 名前で指したコンテナを消す（docker rm -f）。もう無ければ gone（--rm で消えた・起動の前に止めた）。
 * 消せない・時間切れは failed（残っているかもしれない。消えたとは断定しない）
 */
export async function removeContainer(docker: string, name: string, timeoutMs = DOCKER_LIMITS.removeMs): Promise<RemoveResult> {
  try {
    await dockerExec(docker, ["rm", "-f", name], { stage: `コンテナ ${name} の削除`, timeoutMs });
    return { state: "removed" };
  } catch (e) {
    if (e instanceof DockerCommandError && /no such container/i.test(e.stderr)) return { state: "gone" };
    return { state: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 片付けの結果をログの文にする（gone は何も言わない） */
export function removeLog(name: string, r: RemoveResult): string | undefined {
  if (r.state === "removed") return `コンテナ ${name} が残っていたので消しました`;
  if (r.state === "failed") return `コンテナ ${name} を消せませんでした（残っているかもしれません。docker ps -a --filter label=${CONTAINER_LABEL} で確かめ、docker rm -f ${name} で消してください）: ${r.reason}`;
  return undefined;
}

/**
 * 名前を付けたコンテナで docker run を動かし、終わりを待つ（版の確認など、すぐ終わるもの）。
 * 時間切れ・取消・失敗のときは、そのコンテナを消す（残っていれば）。片付けの結果は onCleanup へ。
 * 正常に終わったときは消さない（CLI が終わった直後は --rm の削除がまだ途中のことがあり、消すと「残っていた」と誤って知らせる）
 */
export async function runNamedContainer(
  docker: string,
  runArgs: string[],
  o: DockerExecOptions & { kind: string; id?: string; onCleanup?: (text: string) => void },
): Promise<{ stdout: string; stderr: string }> {
  const name = containerName(o.kind, o.id);
  try {
    return await dockerExec(docker, ["run", "--rm", "--name", name, "--label", `${CONTAINER_LABEL}=${o.kind}`, ...runArgs], o);
  } catch (e) {
    const text = removeLog(name, await removeContainer(docker, name));
    if (text) o.onCleanup?.(text);
    throw e;
  }
}

const lastLine = (s?: string) => s?.trim().split("\n").at(-1) || undefined;
