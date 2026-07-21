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

  it("compare-file이 두 ref 간 파일 hunk를 반환하고 리네임은 양 경로를 보존한다", async () => {
    const fileWrites: JsonWrite[] = [];
    await handleRepositoryCompareFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: fixture.baseRef, head: fixture.featureRef, filePath: "shared.txt" }, fileWrites),
    );
    const content = readPayload<ContentPayload>(fileWrites).content;
    expect(content).toContain("diff --git a/shared.txt b/shared.txt");
    expect(content).toContain("+shared feature");
    expect(content).not.toContain("base moved on");

    const renameWrites: JsonWrite[] = [];
    await handleRepositoryCompareFile(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: fixture.baseRef, head: fixture.featureRef, filePath: "rename-new.txt", oldPath: "rename-old.txt" }, renameWrites),
    );
    const renameContent = readPayload<ContentPayload>(renameWrites).content;
    expect(renameContent).toMatch(/rename from rename-old\.txt/);
    expect(renameContent).toMatch(/rename to rename-new\.txt/);
  });

  it("base===head는 400 invalid_request", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCompare(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: fixture.baseRef, head: fixture.baseRef }, writes),
    );
    expect(writes).toEqual([{ status: 400, payload: { error: "invalid_request" } }]);
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

  it("문법은 유효하나 존재하지 않는 ref는 400 unknown_ref", async () => {
    const writes: JsonWrite[] = [];
    await handleRepositoryCompare(
      { method: "POST" } as never,
      {} as never,
      makeContext(fixture.theaterPath, { theaterId: "theater", base: "refs/heads/does-not-exist", head: fixture.featureRef }, writes),
    );
    expect(writes).toEqual([{ status: 400, payload: { error: "unknown_ref" } }]);
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
      expect(writes).toEqual([{ status: 422, payload: { error: "no_git_repo" } }]);
    } finally {
      await fs.rm(plainDir, { recursive: true, force: true });
    }
  });
});
