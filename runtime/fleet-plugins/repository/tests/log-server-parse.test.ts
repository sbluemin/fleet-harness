import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "../server/git-executor.js";
import { annotateHeadReachability, handleRepositoryLog, isCanonicalRepositoryRef, parseLogOutput, parseWorktreePorcelain } from "../server/log.js";

const logSource = await fs.readFile(new URL("../server/log.ts", import.meta.url), "utf8");

// ─── helpers ─────────────────────────────────────────────────────────────────

async function initGitRepo(dir: string): Promise<void> {
  await runGit(["init"], { cwd: dir });
  await runGit(["config", "user.email", "test@test.com"], { cwd: dir });
  await runGit(["config", "user.name", "Test"], { cwd: dir });
}

function makeLogContext(theaterPath: string, writes: { status: number; payload: unknown }[], body: unknown = { theaterId: "theater" }): FleetPluginServerContext {
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

const HASH_A = "0123456789abcdef0123456789abcdef01234567";
const HASH_B = "89abcdef0123456789abcdef0123456789abcdef";

describe("parseWorktreePorcelain", () => {
  it("current checkout과 linked worktree branch를 경로 없이 DTO로 반환한다", async () => {
    const output = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-topic",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/topic",
      "",
      "worktree /repo-detached",
      "HEAD cccccccccccccccccccccccccccccccccccccccc",
      "detached",
      "",
    ].join("\n");

    expect(await parseWorktreePorcelain(output, "/repo")).toEqual([
      { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", isCurrent: true },
      { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "topic", isCurrent: false },
      { sha: "cccccccccccccccccccccccccccccccccccccccc", branch: null, isCurrent: false },
    ]);
  });
});

describe("handleRepositoryLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-log-server-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // 페이지 크기는 포맷으로 묶을 수 없다 — %s·%D·%b는 사용자가 쓰는 텍스트라 바이트 상한이 없다.
  // 그래서 stdout이 잘렸을 때 레코드 수로 "더 없음"을 판정하면 남은 이력이 조용히 사라진다.
  // 아래는 제목 하나만으로 버퍼를 넘겨 그 경로를 재현한다(본문 없이도 도달한다는 뜻이기도 하다).
  it("keeps pagination open when the log buffer truncates mid-page", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);
    // 메시지는 파일로 넘긴다 — 이 크기를 인자로 주면 git 실행 전에 OS의 argv 상한에서 먼저 죽는다.
    const messagePath = path.join(tmpDir, "message.txt");
    for (let index = 0; index < 3; index += 1) {
      await fs.writeFile(messagePath, `${"S".repeat(3 * 1024 * 1024)} ${index}\n`);
      await fs.writeFile(path.join(repoDir, "entry.txt"), `history ${index}`);
      await runGit(["add", "entry.txt"], { cwd: repoDir });
      await runGit(["commit", "-F", messagePath], { cwd: repoDir });
    }

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes, { theaterId: "theater", limit: 200 }));

    const payload = writes[0]?.payload as { readonly commits: readonly unknown[]; readonly hasMore: boolean; readonly truncated?: boolean };
    expect(writes[0]?.status).toBe(200);
    // 버퍼가 실제로 잘렸고, 요청한 200개보다 적게 파싱됐다.
    expect(payload.truncated).toBe(true);
    expect(payload.commits.length).toBeLessThan(200);
    // 그럼에도 남은 이력에 도달할 길이 열려 있어야 한다.
    expect(payload.hasMore).toBe(true);
    // 다음 페이지의 skip이 전진할 수 있도록 최소 한 건은 돌려준다.
    expect(payload.commits.length).toBeGreaterThan(0);
  });

  it("rejects invalid dot-dot and empty ref components as invalid_ref", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);

    expect(isCanonicalRepositoryRef("refs/heads/a..b")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/a//b")).toBe(false);
    // gitrevisions 선택자·금지 문자는 rev-parse 도달 전에 이름 수준에서 거부되어야 한다
    expect(isCanonicalRepositoryRef("refs/heads/main@{1}")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/main^")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/main~2")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/ma:in")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/m*n")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/wild?card")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/.hidden")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/topic.lock")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/trailing/")).toBe(false);
    expect(isCanonicalRepositoryRef("refs/heads/has space")).toBe(false);
    // 정상 브랜치 이름은 계속 허용된다
    expect(isCanonicalRepositoryRef("refs/heads/feature-x")).toBe(true);
    expect(isCanonicalRepositoryRef("refs/heads/_valid")).toBe(true);
    expect(isCanonicalRepositoryRef("refs/heads/기능")).toBe(true);
    for (const ref of ["refs/heads/a..b", "refs/heads/a//b", "refs/heads/main@{1}", "refs/heads/main^", "refs/heads/main~2"]) {
      const writes: { status: number; payload: unknown }[] = [];
      await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes, { theaterId: "theater", ref }));
      expect(writes).toEqual([{ status: 400, payload: { error: "invalid_ref" } }]);
    }
  });

  it("non-bare 응답은 checkout 경로를 payload에 포함하지 않는다", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);
    await fs.writeFile(path.join(repoDir, "entry.txt"), "history");
    await runGit(["add", "entry.txt"], { cwd: repoDir });
    await runGit(["commit", "-m", "history"], { cwd: repoDir });

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes));

    expect(writes[0]?.status).toBe(200);
    expect(JSON.stringify(writes[0]?.payload)).not.toContain(repoDir);
    expect(JSON.stringify(writes[0]?.payload)).not.toContain("worktreePath");
    expect(writes[0]?.payload).toMatchObject({
      checkouts: [expect.objectContaining({ branch: expect.any(String), isCurrent: true })],
    });
  });
});
