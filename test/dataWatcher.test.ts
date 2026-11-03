import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DataWatcher, type DataWatcherOptions } from "../src/core/store/dataWatcher.ts";
import { makeRepo, openTestProject, tempDir } from "./helpers.ts";

/**
 * データのフォルダの監視（補助）が壊れても、serve と実行中の Preflight を止めない（dataWatcher.ts）。
 * 監視の失敗は差し替えた watch で確実に起こし、実際の監視は別のプロセスでフォルダを作っては消して確かめる
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const err = (code: string, msg = code) => Object.assign(new Error(msg), { code });

/** 差し替えの監視。作られた分を覚え、外から change / error を起こせる */
function fakeWatch(opts: { throwTimes?: number; throwError?: Error } = {}) {
  const made: (EventEmitter & { closed: boolean; fire: (f: string) => void })[] = [];
  let thrown = 0;
  const watch: NonNullable<DataWatcherOptions["watch"]> = (_dir, _o, listener) => {
    if (thrown < (opts.throwTimes ?? 0)) {
      thrown++;
      throw opts.throwError ?? err("ENOSPC", "inotify の上限");
    }
    const w = Object.assign(new EventEmitter(), {
      closed: false,
      close() {
        w.closed = true;
      },
      fire: (f: string) => listener("rename", f),
    });
    made.push(w);
    return w as unknown as FSWatcher;
  };
  return { watch, made, calls: () => made.length + thrown };
}

const watchers: DataWatcher[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.close();
});

function make(dir: string, onChange: (rel: string) => Promise<void> | void, o: DataWatcherOptions) {
  const logs: string[] = [];
  const w = new DataWatcher(dir, onChange, { debounceMs: 5, retryMs: 10, maxRetryMs: 40, maxFailures: 3, stableMs: 10_000, quietMs: 10_000, log: (m) => logs.push(m), ...o });
  watchers.push(w);
  return { w, logs };
}

describe("データのフォルダの監視の失敗", () => {
  it("入れ子のフォルダが消えた ENOENT（データのフォルダはある）は監視を続け、ログは間引く", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch();
    const changed: string[] = [];
    const { w, logs } = make(dir, (r) => void changed.push(r), { watch: f.watch });
    w.start();
    for (let i = 0; i < 5; i++) f.made[0].emit("error", err("ENOENT", `ENOENT: scandir '${dir}/requests/R/preflight/PF/drafts'`));
    expect(w.state).toBe("watching");
    expect(f.made[0].closed).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(dir);
    expect(logs[0]).toContain("監視は続けます");
    // 続けて変更を通知する
    f.made[0].fire("requests/R/request.md");
    await sleep(30);
    expect(changed).toEqual(["requests/R/request.md"]);
  });

  it("それ以外の監視中のエラーは、閉じて待ってから立て直す。立て直した後も通知する", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch();
    const changed: string[] = [];
    const { w, logs } = make(dir, (r) => void changed.push(r), { watch: f.watch });
    w.start();
    f.made[0].emit("error", err("EIO", "読めません"));
    expect(f.made[0].closed).toBe(true);
    expect(w.state).toBe("retrying");
    expect(logs[0]).toMatch(new RegExp(`\\[watch\\] ${dir}: 監視でエラーが起きました。10 ミリ秒後に立て直します（1/3）: 読めません`));
    await sleep(40);
    expect(f.made).toHaveLength(2);
    expect(w.state).toBe("watching");
    // 閉じた古い監視のエラーは無視する（聞いているので落ちない）
    f.made[0].emit("error", err("EIO"));
    expect(f.made).toHaveLength(2);
    f.made[1].fire("project.yaml");
    await sleep(30);
    expect(changed).toEqual(["project.yaml"]);
  });

  it("データのフォルダ自体が消えた ENOENT も立て直しの対象にする", async () => {
    const dir = join(tempDir("p3-watch-"), "gone");
    const f = fakeWatch();
    const { w } = make(dir, () => {}, { watch: f.watch });
    w.start();
    f.made[0].emit("error", err("ENOENT"));
    expect(w.state).toBe("retrying");
  });

  it("始められないときも待って立て直し、続けて失敗したら（maxFailures を超えたら）やめてログに残す。その後は作らない", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch({ throwTimes: 100 });
    const { w, logs } = make(dir, () => {}, { watch: f.watch });
    w.start();
    await sleep(250);
    expect(f.calls()).toBe(4); // 最初の1回と立て直し3回
    expect(w.state).toBe("stopped");
    expect(logs.slice(0, 3).map((l) => l.match(/(\d+) ミリ秒後/)?.[1])).toEqual(["10", "20", "40"]); // 倍にして上限まで
    expect(logs.at(-1)).toContain("続けて 4 回失敗したので監視をやめます（serve は続きます。外での変更は画面の「再読み込み」で反映してください）");
    await sleep(100);
    expect(f.calls()).toBe(4);
  });

  it("立て直せれば数え直す: 一度失敗して立て直した後、stableMs より長く動いてからの失敗は続けての失敗に数えない", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch({ throwTimes: 1 });
    const { w, logs } = make(dir, () => {}, { watch: f.watch, stableMs: 30, maxFailures: 1 });
    w.start(); // 1回目は始められない
    await sleep(30);
    expect(w.state).toBe("watching");
    await sleep(40); // stableMs より長く動く
    f.made[0].emit("error", err("EIO"));
    expect(w.state).toBe("retrying");
    expect(logs.at(-1)).toContain("（1/1）");
  });

  it("変更の読み込みの失敗はログに残すだけで、未処理の拒否にしない", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch();
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const { w, logs } = make(dir, async () => {
        throw new Error("壊れた request.md");
      }, { watch: f.watch });
      w.start();
      f.made[0].fire("requests/R/request.md");
      await sleep(30);
      expect(logs[0]).toContain("変更の読み込みに失敗しました（requests/R/request.md）。次の変更か画面の「再読み込み」で反映します: 壊れた request.md");
      expect(w.state).toBe("watching");
    } finally {
      process.off("unhandledRejection", onRej);
    }
    expect(rejections).toEqual([]);
  });

  it("close の後は、遅らせた通知・立て直しの予定を全部やめ、監視も閉じる", async () => {
    const dir = tempDir("p3-watch-");
    const f = fakeWatch();
    const changed: string[] = [];
    const { w, logs } = make(dir, (r) => void changed.push(r), { watch: f.watch, debounceMs: 20 });
    w.start();
    f.made[0].fire("a.md"); // 通知を遅らせている間に閉じる
    f.made[0].emit("error", err("EIO")); // 立て直しの予定がある間に閉じる
    w.close();
    expect(w.state).toBe("closed");
    expect(f.made[0].closed).toBe(true);
    await sleep(60);
    expect(changed).toEqual([]);
    expect(f.made).toHaveLength(1);
    w.start(); // close の後は始めない
    expect(f.made).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });
});

describe("Workspace の監視", () => {
  it("watch は1つだけ持ち、close の後は始めない。監視が止まっても API の読み直しは使える", async () => {
    const { dataDir } = await makeRepo();
    const ctx = await openTestProject(dataDir);
    const f = fakeWatch();
    const logs: string[] = [];
    const a = ctx.ws.watch({ watch: f.watch, log: (m) => logs.push(m), maxFailures: 0, retryMs: 5 });
    expect(ctx.ws.watch()).toBe(a);
    expect(f.made).toHaveLength(1);
    f.made[0].emit("error", err("EIO"));
    expect(a?.state).toBe("stopped");
    await expect(ctx.ws.reloadAll()).resolves.toBeDefined();
    ctx.ws.close();
    expect(ctx.ws.watch()).toBeUndefined();
  });
});

describe("実際の監視（別のプロセス）", () => {
  const CHILD = fileURLToPath(new URL("./fixtures/watchChild.ts", import.meta.url));

  it("通常の serve で、Preflight の drafts を含む入れ子のフォルダとファイルを作っては消し続けても落ちず、API が答え、close の後に自分で終わる", async () => {
    const { dataDir } = await makeRepo();
    const port = 4800 + Math.floor(Math.random() * 500);
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, dataDir, String(port)], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
    const waitFor = async (word: string, ms = 15_000) => {
      for (let t = 0; t < ms && !out.includes(word); t += 20) await sleep(20);
      expect(out, errOut).toContain(word);
    };
    try {
      await waitFor("ready");
      const base = join(dataDir, "requests", "261103-abcde", "preflight", "PF-1");
      const end = Date.now() + 3_000;
      let n = 0;
      while (Date.now() < end) {
        const drafts = join(base, "drafts");
        mkdirSync(join(drafts, "sub"), { recursive: true });
        for (let i = 0; i < 10; i++) writeFileSync(join(drafts, `D${i}.md`), "x");
        rmSync(drafts, { recursive: true, force: true });
        if (++n % 20 === 0) await sleep(1); // 子の監視に処理の機会を渡す
      }
      rmSync(join(dataDir, "requests", "261103-abcde"), { recursive: true, force: true });
      const api = `http://127.0.0.1:${port}/api`;
      expect((await fetch(`${api}/requests`)).status, errOut).toBe(200);
      expect((await fetch(`${api}/reload`, { method: "POST" })).status).toBe(200);
      child.stdin.write("close\n");
      // close の後は監視も時計も残らず、自分で終わる（process.exit は呼ばない）
      const code = await Promise.race([exited, sleep(10_000).then(() => "timeout" as const)]);
      expect(code, errOut).toBe(0);
      expect(errOut).not.toMatch(/Unhandled|uncaught|unhandledRejection/i);
      expect(out).toContain("closed");
      expect(out).not.toContain("left ");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});

