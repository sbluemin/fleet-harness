import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { handleRepositoryCompare } from "../server/compare.js";
import { handleRepositoryCompareFile } from "../server/compare-file.js";
import { runGit } from "../server/git-executor.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

interface CompareFixture {
  readonly theaterPath: string;
  readonly baseRef: string;
  readonly featureRef: string;
  readonly mergeBaseSha: string;
}

interface ComparePayload {
  readonly files: readonly { readonly path: string; readonly oldPath?: string; readonly status: string }[];
  readonly mergeBase?: string;
}

interface ContentPayload {
  readonly content: string;
}

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

// base 브랜치 커밋 → feature 분기 커밋(신규 파일·수정·리네임) → base 전진 커밋
async function createCompareFixture(tmpDir: string): Promise<CompareFixture> {
  const theaterPath = path.join(tmpDir, "repo");
  await fs.mkdir(theaterPath, { recursive: true });
  await initGitRepo(theaterPath);

  await fs.writeFile(path.join(theaterPath, "shared.txt"), "shared before\n");
  await fs.writeFile(path.join(theaterPath, "rename-old.txt"), "rename\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "base commit"], { cwd: theaterPath });
  const mergeBaseSha = (await runGit(["rev-parse", "HEAD"], { cwd: theaterPath })).stdout.trim();
  const baseBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: theaterPath })).stdout.trim();

  await runGit(["checkout", "-b", "feature"], { cwd: theaterPath });
  await fs.writeFile(path.join(theaterPath, "shared.txt"), "shared feature\n");
  await fs.writeFile(path.join(theaterPath, "feature-only.txt"), "feature only\n");
  await runGit(["mv", "rename-old.txt", "rename-new.txt"], { cwd: theaterPath });
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "feature commit"], { cwd: theaterPath });
  await runGit(["checkout", baseBranch], { cwd: theaterPath });

  // merge-base 시맨틱 검증용 base 전진 커밋 — 결과에 나타나면 안 된다
  await fs.writeFile(path.join(theaterPath, "base-advance.txt"), "base moved on\n");
  await runGit(["add", "."], { cwd: theaterPath });
  await runGit(["commit", "-m", "base advance commit"], { cwd: theaterPath });

  return { theaterPath, baseRef: `refs/heads/${baseBranch}`, featureRef: "refs/heads/feature", mergeBaseSha };
}

function makeContext(theaterPath: string, body: Record<string, unknown>, writes: JsonWrite[]): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: unknown, status: number, payload: unknown) => { writes.push({ status, payload }); },
      },
      security: { isTerminalAuthorized: () => true },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

function readPayload<T>(writes: readonly JsonWrite[]): T {
  expect(writes).toHaveLength(1);
  expect(writes[0]?.status).toBe(200);
  return writes[0]?.payload as T;
}

describe("compare route", () => {
  let tmpDir: string;
  let fixture: CompareFixture;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-compare-"));
    fixture = await createCompareFixture(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merge-base 시맨틱으로 base 전진분을 제외하고 feature 변경만 나열한다", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCompare(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: fixture.baseRef, head: fixture.featureRef }, writes),
    );

    const payload = readPayload<ComparePayload>(writes);
    expect(payload.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "shared.txt", status: "M" }),
      expect.objectContaining({ path: "feature-only.txt", status: "A" }),
      expect.objectContaining({ path: "rename-new.txt", oldPath: "rename-old.txt", status: "R" }),
    ]));
    expect(payload.files.map((file) => file.path)).not.toContain("base-advance.txt");
    expect(payload.mergeBase).toBe(fixture.mergeBaseSha.slice(0, 9));
  });

  it("문법 위반 ref는 400 invalid_ref", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCompare(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: "main", head: fixture.featureRef }, writes),
    );
    expect(writes).toEqual([{ status: 400, payload: { error: "invalid_ref" } }]);
  });

  it("무관 히스토리 ref 쌍(orphan 브랜치)은 400 no_merge_base", async () => {
    await runGit(["checkout", "--orphan", "orphan"], { cwd: fixture.theaterPath });
    await runGit(["rm", "-rq", "--cached", "."], { cwd: fixture.theaterPath });
    await fs.writeFile(path.join(fixture.theaterPath, "orphan.txt"), "unrelated history\n");
    await runGit(["add", "orphan.txt"], { cwd: fixture.theaterPath });
    await runGit(["commit", "-m", "orphan commit"], { cwd: fixture.theaterPath });

    const writes: JsonWrite[] = [];
    await handleRepositoryCompare(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: fixture.baseRef, head: "refs/heads/orphan" }, writes),
    );
    expect(writes).toEqual([{ status: 400, payload: { error: "no_merge_base" } }]);
  });

  it("git 저장소가 아니면 422 no_git_repo", async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-compare-plain-"));
    try {
      const writes: JsonWrite[] = [];
      await handleRepositoryCompare(
        { method: "POST" } as never,
        {} as never,
        makeContext(plainDir, { theaterId: "theater", base: "refs/heads/a", head: "refs/heads/b" }, writes),
      );
      // no_git_repo 판정은 git이 내는 산문을 문자열로 훑어 정한다. 그 문장은 git 버전과 환경에
      // 따라 달라지므로, 어긋났을 때 무엇을 보고 그렇게 판정했는지 실패 메시지에 실어 둔다.
      const observed = await runGit(["diff", "--relative", "--name-status", "--end-of-options", "refs/heads/a...refs/heads/b", "--", "."], { cwd: plainDir })
        .then(() => "resolved")
        .catch((error: { code?: string; exitCode?: number; stderr?: string }) => `${error.code}/exit=${error.exitCode} :: ${String(error.stderr ?? "").split("\n")[0]}`);
      expect(writes, `cwd=${plainDir} git=${observed}`).toEqual([{ status: 422, payload: { error: "no_git_repo" } }]);
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true });
    }
  });
});
