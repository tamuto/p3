import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 中継（launcher.mjs）。app-server の stderr と終わり方を残す */
const LAUNCHER = fileURLToPath(new URL("./launcher.mjs", import.meta.url));

/** app-server（docker run）の終わり方 */
export interface LaunchExit {
  /** 起動できなかった（ENOENT など）。終了コードは作らない */
  spawnError?: string;
  code?: number | null;
  signal?: string | null;
}

export interface LaunchResult {
  /** 終わっていない（待っても終わらなかった）なら undefined */
  exit?: LaunchExit;
  /** 子の stderr（上限まで。省略したところは印がある）。伏せる前の生の値 */
  stderr: string;
  /** 応答しないので P3 が止めた */
  stopped?: boolean;
}

/**
 * app-server を中継ごしに起こす準備。run ごとに一時フォルダを作り、そこに診断を書かせる。
 * 呼ぶ側は command で起こし、失敗したら result() で診断を読み、最後に cleanup() する（中継が残っていれば止める）。
 */
export async function prepareLaunch(command: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "p3-launch-"));
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => undefined);
  const pid = async () => Number(await read("pid")) || undefined;
  const exited = async (): Promise<LaunchExit | undefined> => {
    const text = await read("exit.json");
    return text ? (JSON.parse(text) as LaunchExit) : undefined;
  };
  const wait = async (ms: number) => {
    const until = Date.now() + ms;
    for (;;) {
      const e = await exited();
      if (e || Date.now() >= until) return e;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** 中継を止める（子にも伝わる）。少し待っても残っていれば強制で */
  const stop = async () => {
    const p = await pid();
    if (!p || !alive(p)) return;
    process.kill(p, "SIGTERM");
    if (!(await wait(3000)) && alive(p)) process.kill(p, "SIGKILL");
  };

  return {
    command: [process.execPath, LAUNCHER, dir, "--", ...command],
    /**
     * 終わり方と stderr を読む。終わったばかりなら waitMs まで出し切りを待つ。
     * stopIfRunning: まだ動いていれば止めてから読む（初期化に失敗したとき）
     */
    async result({ waitMs = 3000, stopIfRunning = false } = {}): Promise<LaunchResult> {
      let exit = await wait(waitMs);
      let stopped = false;
      if (!exit && stopIfRunning) {
        await stop();
        stopped = true;
        exit = await exited();
      }
      return { exit, stderr: (await read("stderr")) ?? "", stopped };
    },
    /** 中継が残っていれば止め、一時フォルダを消す */
    async cleanup() {
      await stop().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export type Launch = Awaited<ReturnType<typeof prepareLaunch>>;
