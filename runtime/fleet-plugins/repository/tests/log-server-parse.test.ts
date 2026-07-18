import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "../server/git-executor.js";
import { annotateHeadReachability, handleRepositoryLog, isCanonicalRepositoryRef, parseLogOutput, parseWorktreePorcelain } from "../server/log.js";

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

describe("parseLogOutput", () => {
  it("%at author time을 정수로 파싱하고 full decorations를 보존한다", () => {
    const output = "\x1e0123456789abcdef\x000123456\x00subject\x00Author\x002 hours ago\x001720000000\x00HEAD -> refs/heads/main, refs/remotes/origin/main, tag: v1.2.3\x00parent-a parent-b";
    expect(parseLogOutput(output)).toEqual([{
      fullHash: "0123456789abcdef",
      shortHash: "0123456",
      subject: "subject",
      authorName: "Author",
      relTime: "2 hours ago",
      authorAt: 1_720_000_000,
      refs: ["HEAD -> refs/heads/main", "refs/remotes/origin/main", "tag: v1.2.3"],
      parents: ["parent-a", "parent-b"],
      onHead: true,
    }]);
  });
});

describe("annotateHeadReachability", () => {
  const base = {
    shortHash: "aaa", subject: "s", authorName: "a", relTime: "now", authorAt: 0,
    refs: [], parents: [], onHead: true,
  };

  it("rev-list에 없는 커밋만 onHead=false로 표시한다", () => {
    const commits = [{ ...base, fullHash: "aaa111" }, { ...base, fullHash: "bbb222" }];
    const annotated = annotateHeadReachability(commits, "aaa111\nccc333\n");
    expect(annotated.map((c) => c.onHead)).toEqual([true, false]);
  });

  it("rev-list가 비면(HEAD 부재 등) 전체를 도달 가능으로 둔다", () => {
    const commits = [{ ...base, fullHash: "aaa111" }];
    expect(annotateHeadReachability(commits, "").map((c) => c.onHead)).toEqual([true]);
  });
});

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

  it("prunable(디렉터리 삭제) 워크트리와 zero-SHA unborn 체크아웃은 제외한다", async () => {
    const output = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-stale",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /repo-orphan",
      "HEAD 0000000000000000000000000000000000000000",
      "branch refs/heads/empty",
      "",
    ].join("\n");

    expect(await parseWorktreePorcelain(output, "/repo")).toEqual([
      { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", isCurrent: true },
    ]);
  });

  it("심링크 current 경로를 realpath로 정규화해 판정한다", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-log-realpath-"));
    try {
      const worktreePath = path.join(tmpDir, "worktree");
      const aliasPath = path.join(tmpDir, "worktree-alias");
      await fs.mkdir(worktreePath);
      await fs.symlink(worktreePath, aliasPath);

      const output = [
        `worktree ${worktreePath}`,
        "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "branch refs/heads/main",
      ].join("\n");

      await expect(parseWorktreePorcelain(output, aliasPath)).resolves.toEqual([
        { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", isCurrent: true },
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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

  it("accepts canonical local refs with underscore and non-ASCII names", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);
    await fs.writeFile(path.join(repoDir, "entry.txt"), "history");
    await runGit(["add", "entry.txt"], { cwd: repoDir });
    await runGit(["commit", "-m", "history"], { cwd: repoDir });
    await runGit(["branch", "_valid"], { cwd: repoDir });
    await runGit(["branch", "기능"], { cwd: repoDir });

    for (const ref of ["refs/heads/_valid", "refs/heads/기능"]) {
      const writes: { status: number; payload: unknown }[] = [];
      await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes, { theaterId: "theater", ref }));
      expect(writes[0]?.status).toBe(200);
    }
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

  it("bare 저장소에서 current 경로 없이 history와 경로 없는 checkout payload를 반환한다", async () => {
    const sourceDir = path.join(tmpDir, "source");
    const bareDir = path.join(tmpDir, "history.git");
    await fs.mkdir(sourceDir);
    await initGitRepo(sourceDir);
    await fs.writeFile(path.join(sourceDir, "entry.txt"), "history");
    await runGit(["add", "entry.txt"], { cwd: sourceDir });
    await runGit(["commit", "-m", "history"], { cwd: sourceDir });
    await runGit(["clone", "--bare", sourceDir, bareDir], { cwd: tmpDir });

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(bareDir, writes));

    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe(200);
    const payload = writes[0]?.payload as { readonly commits: readonly { readonly subject: string }[]; readonly checkouts: readonly { readonly isCurrent: boolean }[] };
    expect(payload.commits).toEqual([expect.objectContaining({ subject: "history" })]);
    expect(payload.checkouts.every((checkout) => !checkout.isCurrent)).toBe(true);
    expect(JSON.stringify(writes[0]?.payload)).not.toContain(bareDir);
    expect(JSON.stringify(writes[0]?.payload)).not.toContain("worktreePath");
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

  it("브랜치 삭제로 고아가 된 detached 워크트리 HEAD 커밋도 history에 포함한다", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);
    await fs.writeFile(path.join(repoDir, "a.txt"), "a");
    await runGit(["add", "a.txt"], { cwd: repoDir });
    await runGit(["commit", "-m", "base"], { cwd: repoDir });
    await runGit(["checkout", "-b", "temp"], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, "b.txt"), "b");
    await runGit(["add", "b.txt"], { cwd: repoDir });
    await runGit(["commit", "-m", "orphaned tip"], { cwd: repoDir });
    const tipSha = (await runGit(["rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    await runGit(["checkout", "-"], { cwd: repoDir });
    await runGit(["worktree", "add", "--detach", path.join(tmpDir, "wt-detached"), tipSha], { cwd: repoDir });
    await runGit(["branch", "-D", "temp"], { cwd: repoDir });

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes));

    expect(writes[0]?.status).toBe(200);
    const payload = writes[0]?.payload as {
      readonly commits: readonly { readonly fullHash: string; readonly onHead: boolean }[];
      readonly checkouts: readonly { readonly sha: string; readonly branch: string | null; readonly isCurrent: boolean }[];
    };
    const tip = payload.commits.find((commit) => commit.fullHash === tipSha);
    expect(tip).toBeDefined();
    expect(tip?.onHead).toBe(false);
    expect(payload.checkouts).toContainEqual(expect.objectContaining({ sha: tipSha, branch: null, isCurrent: false }));
  });

  it("orphan 브랜치 체크아웃에서도 기존 브랜치 history를 유지한다", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);
    await fs.writeFile(path.join(repoDir, "a.txt"), "a");
    await runGit(["add", "a.txt"], { cwd: repoDir });
    await runGit(["commit", "-m", "base"], { cwd: repoDir });
    await runGit(["checkout", "--orphan", "empty"], { cwd: repoDir });

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes));

    expect(writes[0]?.status).toBe(200);
    const payload = writes[0]?.payload as { readonly commits: readonly { readonly subject: string }[] };
    expect(payload.commits).toEqual([expect.objectContaining({ subject: "base" })]);
  });

  it("non-bare no-HEAD 저장소는 기존 graceful empty 결과를 유지한다", async () => {
    const repoDir = path.join(tmpDir, "new-repo");
    await fs.mkdir(repoDir);
    await initGitRepo(repoDir);

    const writes: { status: number; payload: unknown }[] = [];
    await handleRepositoryLog({ method: "POST" } as never, {} as never, makeLogContext(repoDir, writes));

    expect(writes).toEqual([{ status: 200, payload: { commits: [], checkouts: [] } }]);
  });
});
