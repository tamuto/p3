import { DEFAULT_IMAGE, DOCKER_CONTEXT, parseCreated } from "@infodb/codex-workspace";
import { DOCKER_LIMITS, DockerAbortError, DockerCommandError, dockerExec, runNamedContainer } from "./docker.ts";

/**
 * Codex を動かすコンテナのイメージ（@infodb/codex-workspace が同梱する Dockerfile から作る）。
 *
 *   - いつもの Preflight: 無いか、作ってから1日より古ければ作り直す（ensureCodexImage）
 *   - p3 codex update: 作った日時によらず今すぐ作り直す（updateCodexImage）
 *
 * どちらも作り直すたびに Codex を入れる段からやり直すので、その時点の最新の Codex が入る。
 * 認証情報もプロジェクトのフォルダも使わない。
 *
 * 更新の判定とビルドは codex-workspace の ensureImage と同じ（同梱の DOCKER_CONTEXT と parseCreated を使い、Dockerfile は写さない）。
 * ただし、ensureImage は inspect・build・版の確認のどれにも待つ時間の上限が無く、取消も受けないので、ここで上限（docker.ts の
 * DOCKER_LIMITS）と取消を持たせて行う。版の確認のコンテナには名前を付け、終わらなければそのコンテナだけを消す
 */
export interface CodexImageOptions {
  docker?: string;
  image?: string;
  /** 取消（Preflight の中止） */
  signal?: AbortSignal;
  /** 上限（テストが短くする） */
  limits?: Partial<typeof DOCKER_LIMITS>;
  /** 片付け（残ったコンテナを消した・消せなかった）の知らせ */
  onCleanup?: (text: string) => void;
  /** 今の時刻（テスト） */
  now?: Date;
}

const DAY = 86_400_000;

/** いつもの Preflight の前に: 無いか1日より古ければ作り直す。中の Codex の版を返す */
export async function ensureCodexImage(o: CodexImageOptions = {}): Promise<string> {
  return (await prepare(o, DAY)).version;
}

/** イメージを確かめ、maxAgeMs より古ければ作り直し、中の版を読む（ensureImage と同じ判定） */
async function prepare(o: CodexImageOptions, maxAgeMs: number): Promise<{ version: string; built: boolean }> {
  const { docker = "docker", image = DEFAULT_IMAGE, signal } = o;
  const limits = { ...DOCKER_LIMITS, ...o.limits };
  const moment = o.now ?? new Date();
  const created = await imageCreated(docker, image, limits.inspectMs, signal);
  const built = created === null || moment.getTime() - created.getTime() > maxAgeMs;
  if (built) {
    const refresh = moment.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    await dockerExec(docker, ["build", "-q", "-t", image, "--build-arg", `CODEX_REFRESH=${refresh}`, DOCKER_CONTEXT], {
      stage: "Codex のイメージのビルド",
      timeoutMs: limits.buildMs,
      signal,
    });
  }
  return { version: await codexVersion(docker, image, limits.versionMs, signal, o.onCleanup), built };
}

async function imageCreated(docker: string, image: string, timeoutMs: number, signal?: AbortSignal): Promise<Date | null> {
  try {
    const { stdout } = await dockerExec(docker, ["image", "inspect", "--format", "{{.Created}}", image], { stage: "イメージの確認", timeoutMs, signal });
    return parseCreated(stdout.trim());
  } catch (e) {
    // 時間切れ・取消は「無い」とみなさない（無いと思って作り直しに進まない）
    if (e instanceof DockerAbortError) throw e;
    return null;
  }
}

export type ImageStep = "docker" | "daemon" | "build" | "version";

/** 更新に失敗した段と、次にすること */
export class CodexImageError extends Error {
  constructor(
    readonly step: ImageStep,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface ImageUpdate {
  image: string;
  /** 作り直したイメージの中の Codex の版（codex --version） */
  version: string;
  /** 作り直す前の版（イメージが無かった・読めなかったときは null） */
  previous: string | null;
  /** 作り直したイメージの作成日時 */
  createdAt: string | null;
}

/** 今すぐ作り直して、入った Codex の版を返す。進み具合は onProgress へ（CLI は stderr に出す） */
export async function updateCodexImage({
  docker = "docker",
  image = DEFAULT_IMAGE,
  onProgress = () => {},
  ...rest
}: CodexImageOptions & { onProgress?: (text: string) => void } = {}): Promise<ImageUpdate> {
  const limits = { ...DOCKER_LIMITS, ...rest.limits };
  try {
    await dockerExec(docker, ["version", "--format", "{{.Server.Version}}"], { stage: "Docker デーモンの確認", timeoutMs: limits.inspectMs, signal: rest.signal });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new CodexImageError("docker", "docker コマンドが見つかりません。Docker をインストールし、PATH から docker を実行できるようにしてください");
    }
    throw new CodexImageError(
      "daemon",
      "Docker デーモンに接続できません。Docker を起動し、この利用者が使える（docker version が通る）ことを確かめてください",
      firstLine(err.stderr) ?? (e instanceof DockerAbortError ? e.message : undefined),
    );
  }

  const exists = await dockerExec(docker, ["image", "inspect", "--format", "{{.Id}}", image], { stage: "イメージの確認", timeoutMs: limits.inspectMs, signal: rest.signal }).then(
    () => true,
    () => false,
  );
  const previous = exists ? await codexVersion(docker, image, limits.versionMs, rest.signal, rest.onCleanup).catch(() => null) : null;
  onProgress(`Codex のイメージ ${image} を作り直しています（最新の Codex を入れます。数分かかることがあります）`);
  let version: string;
  try {
    // 作った日時によらず作り直す（maxAgeMs を -∞ にすると、どんな作成日時でも「古い」になる）。返すのは作り直した中の版
    version = (await prepare({ docker, image, ...rest }, Number.NEGATIVE_INFINITY)).version;
  } catch (e) {
    const err = e as Error & { cmd?: string; stderr?: string; stage?: string };
    if (err.cmd?.includes(" build ") || (e instanceof DockerAbortError && e.stage.includes("ビルド"))) {
      throw new CodexImageError("build", "イメージを作れませんでした。ネットワーク（Codex の取得）と Docker のディスクの空きを確かめて、もう一度実行してください", lastLine(err.stderr) ?? err.message);
    }
    throw new CodexImageError("version", "イメージは作りましたが、中の Codex の版を読めませんでした。もう一度実行してください", lastLine(err.stderr ?? err.message));
  }
  if (!version) throw new CodexImageError("version", "イメージは作りましたが、中の Codex の版を読めませんでした。もう一度実行してください");
  const createdAt = await dockerExec(docker, ["image", "inspect", "--format", "{{.Created}}", image], { stage: "イメージの確認", timeoutMs: limits.inspectMs })
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);
  return { image, version, previous, createdAt };
}

/** 中の Codex の版（認証は使わない）。名前を付けたコンテナで動かし、上限を過ぎたらそのコンテナを消す */
async function codexVersion(docker: string, image: string, timeoutMs: number, signal?: AbortSignal, onCleanup?: (text: string) => void): Promise<string> {
  const { stdout } = await runNamedContainer(docker, ["--entrypoint", "codex", image, "--version"], { stage: "Codex の版の確認", timeoutMs, signal, kind: "codex-version", onCleanup });
  const v = stdout.trim();
  if (!v) throw new DockerCommandError("codex --version が空", 0, "", "codex --version");
  return v;
}

const firstLine = (s?: string) => s?.trim().split("\n")[0] || undefined;
const lastLine = (s?: string) => s?.trim().split("\n").at(-1) || undefined;
