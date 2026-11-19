import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonRecord, writeJsonRecord } from "../packages/tasks/src/core/store/jsonRecord.ts";
import { confirmRetrospectiveTarget, judgeRisk, loadRetrospective } from "../packages/tasks/src/features/retro/core/retrospective.ts";
import { archiveRequest } from "../packages/tasks/src/core/requestOps.ts";
import { NotFoundError } from "../packages/tasks/src/core/store/collection.ts";
import { makeProject, newRequest, openTestProject, tempDir } from "./helpers.ts";

/**
 * JSON の記録のファイルの共通の読み書き（core/store/jsonRecord.ts）: 読むときの扱いを記録ごとに渡せること（無い・読めない・空・JSON として
 * 読めない・形）、置き換えで整形して書くこと。振り返りは要望のロックの中で要望があることを確かめ、アーカイブした後の場所に書き戻さないこと
 * （記録ごとの値・エラー・書き込みの有無は各機能のテスト: metricsManual・retrospective・qualityImprovement・milestoneReviewStore）
 */

const policy = {
  missing: () => "無い",
  invalidJson: (m: string) => `JSON でない: ${m.length > 0}`,
  shape: (raw: unknown) => `形: ${JSON.stringify(raw)}`,
};

describe("読む・書く", () => {
  it("無い・空・JSON として読めない・形を、渡した扱いで読む。無い以外の読めない理由は、扱いが無ければ投げる", async () => {
    const dir = tempDir("p3-json-");
    const file = join(dir, "x.json");
    expect(await readJsonRecord(file, policy)).toBe("無い");
    writeFileSync(file, "");
    expect(await readJsonRecord(file, policy)).toBe("JSON でない: true");
    expect(await readJsonRecord(file, { ...policy, blank: () => "空" })).toBe("空");
    writeFileSync(file, "{ 壊れた");
    expect(await readJsonRecord(file, policy)).toBe("JSON でない: true");
    writeFileSync(file, '{"a":1}');
    expect(await readJsonRecord(file, policy)).toBe('形: {"a":1}');
    // フォルダを読む（EISDIR）: 扱いがあればその値、無ければ投げる
    const folder = join(dir, "folder");
    mkdirSync(folder);
    expect(await readJsonRecord(folder, { ...policy, readFailed: (e) => `読めない: ${e.code}` })).toBe("読めない: EISDIR");
    await expect(readJsonRecord(folder, policy)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("整形した JSON と末尾の改行で、置き換えで書く", async () => {
    const file = join(tempDir("p3-json-"), "x.json");
    await writeJsonRecord(file, { a: [1, 2] });
    expect(await readFile(file, "utf8")).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  });
});

describe("振り返りの記録とアーカイブ", () => {
  it("読み込んだ後に要望がアーカイブされても、確定・リスクの確認はロックの中で気づいて NotFound にし、元の場所に書き戻さない", async () => {
    const p = await makeProject();
    const req = await newRequest(p.ctx, { title: "請求", status: "active", body: "- 案" });
    // アーカイブの前に読み込んだ別のプロセス
    const stale = await openTestProject(p.dataDir);
    await archiveRequest(p.ctx, req.id);
    const old = join(p.dataDir, "requests", req.id);
    expect(existsSync(old)).toBe(false);
    await expect(confirmRetrospectiveTarget(stale, req.id, { run: "PF-x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(judgeRisk(stale, req.id, { risk: 1, state: "occurred", evidence: [] })).rejects.toBeInstanceOf(NotFoundError);
    expect(existsSync(old)).toBe(false);
  });

  it("JSON として読めない記録は retro_unreadable、無い以外の読めない理由はそのまま投げる", async () => {
    const p = await makeProject();
    const req = await newRequest(p.ctx, { title: "請求" });
    const file = join(p.dataDir, "requests", req.id, "retrospective.json");
    writeFileSync(file, "{ 壊れた");
    await expect(loadRetrospective(p.ctx, req.id)).rejects.toMatchObject({ code: "retro_unreadable" });
    rmSync(file);
    mkdirSync(file);
    await expect(loadRetrospective(p.ctx, req.id)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
