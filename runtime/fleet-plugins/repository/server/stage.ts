import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_PATHS_PER_REQUEST = 1000;

/**
 * 스테이징 동사가 받는 파일 경로 배열의 어휘 검증 — 저장소 상대 경로만 통과한다.
 * 옵션형 인자는 :(literal) pathspec으로 감싸기 전에 이미 걸러, "--force" 같은 이름의
 * 실제 파일은 pathspec으로 안전하게 처리하되 검증 우회는 없게 한다.
 */
export function readStagePaths(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS_PER_REQUEST) return null;
  const paths: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw === "" || raw.includes("\0")) return null;
    if (path.isAbsolute(raw) || path.posix.isAbsolute(raw)) return null;
    const normalized = path.posix.normalize(raw);
    if (normalized === ".." || normalized.startsWith("../")) return null;
    paths.push(raw);
  }
  return paths;
}

function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map((entry) => `:(literal)${entry}`);
}

export function classifyWriteError(stderr: string): "index_locked" | null {
  return /index\.lock|Unable to create .* File exists/i.test(stderr) ? "index_locked" : null;
}

type WriteHandlerBody = {
  readonly theaterId?: unknown;
  readonly repoRel?: unknown;
  readonly paths?: unknown;
  readonly untrackedPaths?: unknown;
  readonly subPath?: unknown;
};

async function resolveWriteContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<{ readonly gitCwd: string; readonly body: WriteHandlerBody } | null> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return null; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return null; }
  const body = await ctx.host.http.readJsonBody<WriteHandlerBody>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return null;
  }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return null; }
  try {
    const { gitCwd } = await resolveGitCwd(theaterPath, body.repoRel);
    return { gitCwd, body };
  } catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return null; }
    throw error;
  }
}

function writeGitFailure(res: http.ServerResponse, ctx: FleetPluginServerContext, error: unknown): void {
  if (error instanceof GitExecutorError) {
    if (error.code === "no_git_repo" || error.code === "git_unavailable") {
      ctx.host.http.writeJson(res, 422, { error: error.code });
      return;
    }
    if (error.code === "timeout") { ctx.host.http.writeJson(res, 422, { error: "timeout" }); return; }
    const locked = classifyWriteError(error.stderr);
    if (locked) { ctx.host.http.writeJson(res, 409, { error: locked }); return; }
    ctx.host.http.writeJson(res, 500, { error: "git_failed" });
    return;
  }
  throw error;
}

export async function handleRepositoryStage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  const resolved = await resolveWriteContext(req, res, ctx);
  if (!resolved) return;
  const paths = readStagePaths(resolved.body.paths);
  if (!paths) { ctx.host.http.writeJson(res, 400, { error: "invalid_paths" }); return; }
  try {
    await runGit(["add", "--", ...literalPathspecs(paths)], { cwd: resolved.gitCwd });
    ctx.host.http.writeJson(res, 200, { ok: true });
  } catch (error) {
    writeGitFailure(res, ctx, error);
  }
}

export async function handleRepositoryUnstage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  const resolved = await resolveWriteContext(req, res, ctx);
  if (!resolved) return;
  const paths = readStagePaths(resolved.body.paths);
  if (!paths) { ctx.host.http.writeJson(res, 400, { error: "invalid_paths" }); return; }
  try {
    try {
      await runGit(["restore", "--staged", "--", ...literalPathspecs(paths)], { cwd: resolved.gitCwd });
    } catch (error) {
      // unborn HEAD(첫 커밋 전)에는 복원할 원본이 없어 restore가 실패한다 — 인덱스에서 내리는 것으로 동등하다.
      if (!(error instanceof GitExecutorError) || !/could not resolve HEAD|unknown revision|bad revision/i.test(error.stderr)) throw error;
      await runGit(["rm", "-r", "--cached", "-q", "--", ...literalPathspecs(paths)], { cwd: resolved.gitCwd });
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
  } catch (error) {
    writeGitFailure(res, ctx, error);
  }
}

/**
 * Discard는 이 플러그인의 유일한 비가역 동사다 — tracked는 워크트리 복원, untracked는 삭제.
 * 클라이언트의 2단계 무장(1.5s)이 첫 방어선이고, 서버는 경로 검증과 pathspec 격리만 책임진다.
 */
export async function handleRepositoryDiscard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  const resolved = await resolveWriteContext(req, res, ctx);
  if (!resolved) return;
  const hasTracked = resolved.body.paths !== undefined;
  const hasUntracked = resolved.body.untrackedPaths !== undefined;
  if (!hasTracked && !hasUntracked) { ctx.host.http.writeJson(res, 400, { error: "invalid_paths" }); return; }
  const tracked = hasTracked ? readStagePaths(resolved.body.paths) : [];
  const untracked = hasUntracked ? readStagePaths(resolved.body.untrackedPaths) : [];
  if (tracked === null || untracked === null) { ctx.host.http.writeJson(res, 400, { error: "invalid_paths" }); return; }
  try {
    if (tracked.length > 0) {
      await runGit(["restore", "--worktree", "--", ...literalPathspecs(tracked)], { cwd: resolved.gitCwd });
    }
    if (untracked.length > 0) {
      // clean은 저장소 경계 안에서만 지운다 — fs 직접 삭제 대신 git의 경계 판정을 그대로 쓴다.
      await runGit(["clean", "-f", "-d", "--", ...literalPathspecs(untracked)], { cwd: resolved.gitCwd });
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
  } catch (error) {
    writeGitFailure(res, ctx, error);
  }
}
