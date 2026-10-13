import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE } from "@infodb/codex-workspace";
import { ChatGptAccount } from "../src/core/chatgpt/account.ts";
import { OPENAI_ENDPOINTS } from "../src/core/chatgpt/oauth.ts";
import { saveConnection } from "../src/core/chatgpt/store.ts";
import { CodexWorkspaceEngine } from "../src/core/preflight/codexEngine.ts";
import { describeMapping, diagnoseLaunch, mapPath } from "../src/core/preflight/diagnose.ts";
import { prepareLaunch } from "../src/core/preflight/launch.ts";
import { makeRepo, newRequest, openTestProject, tempDir } from "./helpers.ts";

const FAKE_RUN = fileURLToPath(new URL("./fixtures/fake-docker-run.mjs", import.meta.url));
const PLAN = ["openid", "offline_access", "chatgpt.tokens.use.direct"];

async function chatgptAccount() {
  const file = join(tempDir(), "chatgpt.json");
  await saveConnection(
    {
      hostId: "urn:uuid:h",
      clientId: "oaiapp_1",
      account: { sub: "u", email: "a@example.com" },
      tokens: { accessToken: "at-secret-value", refreshToken: "rt", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: PLAN, savedAt: new Date().toISOString() },
    },
    file,
  );
  return new ChatGptAccount(file, { endpoints: OPENAI_ENDPOINTS, fetch: async () => new Response("{}", { status: 500 }), now: Date.now });
}

/** 偽の docker run で Preflight を1回動かす */
async function runWith(mode: string | string[], opts: { chatgpt?: boolean; pathMap?: [string, string][] } = {}) {
  const repo = await makeRepo();
  const codex = new CodexWorkspaceEngine({
    authVolume: opts.chatgpt ? undefined : "vol",
    account: opts.chatgpt ? await chatgptAccount() : new ChatGptAccount(join(tempDir(), "none.json")),
    pathMap: opts.pathMap ?? [[repo.root, "/host/repo"]],
    ensureImage: false,
    command: () => (Array.isArray(mode) ? mode : [process.execPath, FAKE_RUN, mode]),
  });
  const ctx = await openTestProject(repo.dataDir, { codex });
  const req = await newRequest(ctx, { title: "x", status: "draft" });
  const { id } = await ctx.preflight.start(req.id);
  const run = (await ctx.preflight.wait(req.id, id))!;
  const saved = readFileSync(join(ctx.ws.preflight.runDir(req.id, id), "run.json"), "utf8");
  return { run, saved, repo, log: run.log.map((l) => `${l.kind}: ${l.text}`).join("\n") };
}

describe("app-server（docker run）がすぐ終わったときの診断", () => {
  it("マウントのエラー: Docker のメッセージと終了コード、codex.pathMap の案内と今の対応を出す", async () => {
    const { run, log, repo, saved } = await runWith("mount");
    expect(run.status).toBe("failed");
    expect(run.error).toContain('初期化の前に終わりました（終了コード 125）: docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: <参照先 main>');
    // 診断はエラーのログに1回だけ
    expect(run.log.filter((l) => l.text.includes("codex.pathMap を確かめてください"))).toHaveLength(1);
    expect(run.error).toContain("参照先 main のパスが Docker のホストにありません。個人設定（config.yaml）の codex.pathMap を確かめてください");
    expect(run.error).toContain("直し方: 対応の行き先（Docker のホストから見たパス）が違います"); // 対応は当たっていた
    expect(run.error).toContain("p3 user-config set codex.pathMap+=<このマシンのパス>=<Docker のホストから見たパス>");
    expect(run.error).toContain("参照先 main → コンテナ /workspace/main（codex.pathMap の対応あり）");
    expect(run.error).toContain("データ → コンテナ /data（codex.pathMap の対応あり）");
    // 共有の記録（run.json）に、このマシンのパスも Docker のホストのパスも残さない
    for (const p of [repo.root, "/host/repo"]) {
      expect(saved).not.toContain(p);
      expect(log).not.toContain(p);
    }
    expect(log).toContain('error: Docker の出力:\ndocker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: <参照先 main>');
    // 開始のログにパスの対応
    expect(log).toContain("info: パスの対応（個人設定の codex.pathMap）:");
  });

  it("デーモンに繋がらない・イメージが無い・分からない失敗・終了コード 0・シグナル・起動できない", async () => {
    expect((await runWith("nodaemon")).run.error).toMatch(/終了コード 125[^\n]*Is the docker daemon running\?\nDocker のデーモンに繋がりません。Docker を起動し、接続先/);
    expect((await runWith("noimage")).run.error).toContain(`イメージ ${DEFAULT_IMAGE} がありません。p3 codex update で作ってください`);
    const unknown = (await runWith("unknown")).run.error!;
    expect(unknown).toContain("終了コード 3）: the last line explains it");
    expect(unknown).toContain("上の Docker の出力を確かめてください");
    expect((await runWith("zero")).run.error).toContain("初期化の前に終わりました（終了コード 0）\nDocker の出力はありませんでした");
    const signal = (await runWith("signal")).run.error!;
    expect(signal).toContain("シグナル SIGKILL で終わりました: killed by the kernel");
    expect(signal).not.toContain("終了コード");
    const spawnFail = (await runWith(["/nonexistent/docker-p3-test"])).run.error!;
    expect(spawnFail).toContain("起動できません（ENOENT）");
    expect(spawnFail).toContain("docker コマンドが見つかりません");
    expect(spawnFail).not.toContain("終了コード");
  });

  it("途中で終わったときも Docker の出力を添える", async () => {
    const { run } = await runWith("midrun");
    expect(run.error).toContain("途中で終わりました（終了コード 137）: container ran out of memory");
  });

  it("チャンクをまたぐ秘密も、ログ・保存した run・配信のどれにも残さない", async () => {
    const { run, saved, log } = await runWith("secret", { chatgpt: true });
    expect(run.status).toBe("failed");
    for (const text of [JSON.stringify(run), saved, log]) {
      expect(text).not.toContain("at-secret-value");
      expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    }
    expect(run.error).toContain("[伏せました]");
  });

  it("出力が多いときは先頭と末尾を残して省略を明示する", async () => {
    const { run, log } = await runWith("flood");
    expect(run.error).toContain(": final line of the flood");
    expect(log).toMatch(/…（\d+ バイトを省略）…/);
    expect(log.length).toBeLessThan(80_000);
  });

  it("うまくいったとき・中止したときは診断を付けない（既存のテストの偽 app-server で確認）", async () => {
    // 成功は test/preflight.test.ts の偽 app-server の各テスト、中止は終了コードを見ない（signal.aborted）
    const r = diagnoseLaunch({ exit: { code: 0 }, stderr: "" }, { image: "i", mappings: [], rules: 0, phase: "run" });
    expect(r.message).toContain("途中で終わりました");
  });
});

describe("パスの対応の説明", () => {
  it("前から順に境界の合う最初の対応。当たらない・同じパス・空を見分ける", () => {
    const map: [string, string][] = [
      ["/workspaces", "/home/u/ws"],
      ["/workspaces/p3", "/never"],
      ["/mnt/assets", "/mnt/assets"],
    ];
    expect(mapPath(map, "/workspaces/p3")).toEqual({ host: "/home/u/ws/p3", rule: map[0] });
    expect(mapPath(map, "/workspacesX/a")).toEqual({ host: "/workspacesX/a" });
    const m = (local: string) => ({ label: "データ", local, ...mapPath(map, local), container: "/data" });
    expect(describeMapping(m("/mnt/assets/p"), 3)).toBe("データ → コンテナ /data（codex.pathMap の対応あり（パスは変わらない））");
    expect(describeMapping(m("/workspaces/p3"), 3)).toBe("データ → コンテナ /data（codex.pathMap の対応あり）");
    expect(describeMapping(m("/srv/x"), 3)).toContain("対応なし（3 件のどれにも当たらない。このマシンのパスのまま渡す）");
    expect(describeMapping({ label: "データ", local: "/srv/x", host: "/srv/x", container: "/data" }, 0)).toBe("データ → コンテナ /data（codex.pathMap の対応なし（このマシンのパスのまま渡す））");
  });
});

describe("中継（launcher.mjs）", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("応答しないものは止めて、中継も子も残さない", async () => {
    const launch = await prepareLaunch([process.execPath, FAKE_RUN, "hang"]);
    const [file, ...args] = launch.command;
    const proc = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise((r) => proc.once("exit", r));
    await new Promise((r) => setTimeout(r, 300));
    const r = await launch.result({ waitMs: 100, stopIfRunning: true });
    expect(r.stopped).toBe(true);
    expect(r.exit).toMatchObject({ signal: "SIGTERM" });
    await exited;
    expect(alive(proc.pid!)).toBe(false);
    // 子（偽の docker run）も残っていない
    const left = spawnSync("pgrep", ["-f", `${FAKE_RUN} hang`], { encoding: "utf8" }).stdout.trim();
    expect(left).toBe("");
    await launch.cleanup();
  });

  it("stdin を閉じると子に伝わって終わる（うまくいったときの閉じ方）", async () => {
    const launch = await prepareLaunch([process.execPath, "-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"]);
    const [file, ...args] = launch.command;
    const proc = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
    await new Promise((r) => setTimeout(r, 300));
    proc.stdin.end();
    const code = await new Promise((r) => proc.once("exit", r));
    expect(code).toBe(0);
    expect((await launch.result({ waitMs: 1000 })).exit).toEqual({ code: 0, signal: null });
    await launch.cleanup();
  });
});

describe("パスの対応の直し方", () => {
  it("対応が当たらなければ足し方を、当たっていたら行き先の直し方を出す（このマシンのパスは出さない）", async () => {
    const { pathMapHowTo } = await import("../src/core/preflight/diagnose.ts");
    const none = pathMapHowTo({ label: "データ", local: "/mnt/x/data", host: "/mnt/x/data", container: "/data" });
    expect(none[0]).toContain("対応を足します");
    expect(none.join("\n")).toContain("docker inspect <この開発コンテナ> の Mounts");
    expect(none.join("\n")).not.toContain("/mnt/x");
    const wrong = pathMapHowTo({ label: "データ", local: "/mnt/x/data", host: "/h/data", rule: ["/mnt/x", "/h"], container: "/data" });
    expect(wrong[0]).toContain("行き先");
    expect(pathMapHowTo()[0]).toContain("対応を足します");
  });
});
