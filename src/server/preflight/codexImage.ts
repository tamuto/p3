import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_IMAGE, ensureImage } from "@infodb/codex-workspace";

const run = promisify(execFile);

/**
 * Codex を動かすコンテナのイメージ（@infodb/codex-workspace が同梱する Dockerfile から作る）。
 *
 *   - いつもの Preflight: 無いか、作ってから1日より古ければ作り直す（ensureCodexImage）
 *   - p3 codex update: 作った日時によらず今すぐ作り直す（updateCodexImage）
 *
 * どちらも作り直すたびに Codex を入れる段からやり直すので、その時点の最新の Codex が入る。
 * 認証情報もプロジェクトのフォルダも使わない。
 */
export interface CodexImageOptions {
  docker?: string;
  image?: string;
}

/** いつもの Preflight の前に。中の Codex の版を返す */
export function ensureCodexImage({ docker = "docker", image = DEFAULT_IMAGE }: CodexImageOptions = {}): Promise<string> {
  return ensureImage({ docker, image });
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
}: CodexImageOptions & { onProgress?: (text: string) => void } = {}): Promise<ImageUpdate> {
  try {
    await run(docker, ["version", "--format", "{{.Server.Version}}"], { timeout: 15_000 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new CodexImageError("docker", "docker コマンドが見つかりません。Docker をインストールし、PATH から docker を実行できるようにしてください");
    }
    throw new CodexImageError(
      "daemon",
      "Docker デーモンに接続できません。Docker を起動し、この利用者が使える（docker version が通る）ことを確かめてください",
      firstLine(err.stderr),
    );
  }

  const exists = await run(docker, ["image", "inspect", "--format", "{{.Id}}", image]).then(() => true, () => false);
  const previous = exists ? await codexVersion(docker, image).catch(() => null) : null;
  onProgress(`Codex のイメージ ${image} を作り直しています（最新の Codex を入れます。数分かかることがあります）`);
  let version: string;
  try {
    // 作った日時によらず作り直す（maxAgeMs を -∞ にすると、どんな作成日時でも「古い」になる）。返すのは作り直した中の版
    version = await ensureImage({ docker, image, maxAgeMs: Number.NEGATIVE_INFINITY });
  } catch (e) {
    const err = e as Error & { cmd?: string; stderr?: string };
    if (err.cmd?.includes(" build ")) {
      throw new CodexImageError("build", "イメージを作れませんでした。ネットワーク（Codex の取得）と Docker のディスクの空きを確かめて、もう一度実行してください", lastLine(err.stderr));
    }
    throw new CodexImageError("version", "イメージは作りましたが、中の Codex の版を読めませんでした。もう一度実行してください", lastLine(err.stderr ?? err.message));
  }
  if (!version) throw new CodexImageError("version", "イメージは作りましたが、中の Codex の版を読めませんでした。もう一度実行してください");
  const createdAt = await run(docker, ["image", "inspect", "--format", "{{.Created}}", image])
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);
  return { image, version, previous, createdAt };
}

async function codexVersion(docker: string, image: string): Promise<string> {
  const { stdout } = await run(docker, ["run", "--rm", "--entrypoint", "codex", image, "--version"], { timeout: 60_000 });
  const v = stdout.trim();
  if (!v) throw new Error("codex --version が空");
  return v;
}

const firstLine = (s?: string) => s?.trim().split("\n")[0] || undefined;
const lastLine = (s?: string) => s?.trim().split("\n").at(-1) || undefined;
