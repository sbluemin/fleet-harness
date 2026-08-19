import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { isPathContained } from "./path-containment.js";
import type { WorkstateResult } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(candidate: string): Promise<boolean> {
  try { await fs.stat(candidate); return true; }
  catch { return false; }
}

export function parseAheadBehind(stdout: string): { readonly ahead: number; readonly behind: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim());
  if (!match) return null;
  // rev-list --left-right --count @{upstream}...HEAD → 왼쪽이 upstream 전용(behind), 오른쪽이 HEAD 전용(ahead)
  return { behind: Number.parseInt(match[1]!, 10), ahead: Number.parseInt(match[2]!, 10) };
}

/**
 * 쓰기 동사가 서기 전에 먼저 서는 울타리 — 이 컨텍스트에서 지금 쓰기가 안전한지를 한 번에 보고한다.
 * index.lock은 다른 프로세스(에이전트 CLI 포함)가 인덱스를 쥐고 있다는 신호이고,
 * merge/rebase/cherry-pick 마커는 반쯤 끝난 히스토리 수술의 신호다.
 */
export async function handleRepositoryWorkstate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }

  try {
    const [gitDirResult, headResult, headShaResult] = await Promise.all([
      runGit(["rev-parse", "--absolute-git-dir"], { cwd: gitCwd }),
      runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: gitCwd, allowExitCodes: [1] }),
      runGit(["rev-parse", "--quiet", "--verify", "HEAD"], { cwd: gitCwd, allowExitCodes: [1] }),
    ]);
    const gitDir = path.resolve(gitCwd, gitDirResult.stdout.trim());
    const headBranch = headResult.stdout.trim() || null;
    const headSha = headShaResult.stdout.trim() || null;

    const [indexLock, merge, rebaseMerge, rebaseApply, cherryPick] = await Promise.all([
      fileExists(path.join(gitDir, "index.lock")),
      fileExists(path.join(gitDir, "MERGE_HEAD")),
      fileExists(path.join(gitDir, "rebase-merge")),
      fileExists(path.join(gitDir, "rebase-apply")),
      fileExists(path.join(gitDir, "CHERRY_PICK_HEAD")),
    ]);
    const inProgress = merge ? "merge" : rebaseMerge || rebaseApply ? "rebase" : cherryPick ? "cherry-pick" : null;

    let upstream: string | null = null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (headBranch) {
      const upstreamResult = await runGit(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { cwd: gitCwd, allowExitCodes: [128] },
      );
      upstream = upstreamResult.stdout.trim() || null;
      if (upstream) {
        const counts = parseAheadBehind((await runGit(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd: gitCwd })).stdout);
        ahead = counts?.ahead ?? null;
        behind = counts?.behind ?? null;
      }
    }

    // 이 워크트리에 주둔한 Operation — 브라우저에 경로는 내보내지 않고 정체(제목)만 알린다.
    // 실행 중 여부는 durable 스토어가 모른다: "여기 배치되어 있다"는 사실만 말한다.
    let realGitCwd = gitCwd;
    try { realGitCwd = await fs.realpath(gitCwd); } catch { /* 존재는 resolveGitCwd가 이미 보장 */ }
    const stationedOperations: { readonly id: string; readonly title: string }[] = [];
    for (const operation of ctx.host.operations.list()) {
      const rawCwd = (operation.payload as { readonly cwd?: unknown } | null)?.cwd;
      // cwd 없는 Operation은 터미널 플러그인이 Theater 루트에서 기동한다 — 루트 컨텍스트의 주둔으로 집계한다.
      const cwd = typeof rawCwd === "string" ? rawCwd : theaterPath;
      let realCwd: string;
      try { realCwd = await fs.realpath(cwd); } catch { continue; }
      if (isPathContained(realGitCwd, realCwd)) stationedOperations.push({ id: operation.id, title: operation.title });
    }

    const payload: WorkstateResult = { indexLock, inProgress, headBranch, headSha, upstream, ahead, behind, stationedOperations };
    ctx.host.http.writeJson(res, 200, payload);
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo" || error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
