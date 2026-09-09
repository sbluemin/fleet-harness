import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { REF_RE } from "./commit.js";
import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { isSafeTreeDirPath } from "./tree.js";
import type { BlobResult } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 트리 탭의 파일 미리보기 상한 — 이보다 큰 blob은 앞부분만 보내고 truncated로 표시한다. */
const BLOB_MAX_BYTES = 1_000_000;

/** NUL이 섞인 앞 8KB는 바이너리로 본다 — git의 판정과 같은 휴리스틱. */
export function looksBinary(content: string): boolean {
  return content.slice(0, 8192).includes("\0");
}

/**
 * 커밋 시점의 파일 내용 — 트리 탭에서 바뀌지 않은 파일도 열어 볼 수 있게 한다.
 * `<ref>:<path>` 조회는 커밋 트리 안에서만 해석되므로 파일시스템 탈출이 없다.
 */
export async function handleRepositoryBlob(req: http.IncomingMessage, res: http.ServerResponse, ctx: FleetPluginServerContext): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown; readonly ref?: unknown; readonly filePath?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string" || typeof body.ref !== "string" || typeof body.filePath !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  if (!REF_RE.test(body.ref)) { ctx.host.http.writeJson(res, 400, { error: "invalid_ref" }); return; }
  if (!body.filePath || body.filePath.endsWith("/") || !isSafeTreeDirPath(body.filePath)) { ctx.host.http.writeJson(res, 400, { error: "invalid_file_path" }); return; }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
  try {
    const result = await runGit(["show", "--no-textconv", `${body.ref}:${body.filePath}`], { cwd: gitCwd, maxBuffer: BLOB_MAX_BYTES });
    const payload: BlobResult = looksBinary(result.stdout)
      ? { content: "", binary: true }
      : { content: result.stdout, ...(result.truncated ? { truncated: true } : {}) };
    ctx.host.http.writeJson(res, 200, payload);
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo" || error.code === "git_unavailable") { ctx.host.http.writeJson(res, 422, { error: error.code }); return; }
      if (error.code === "non_zero_exit" && /does not exist|exists on disk, but not in|Not a valid object name|bad object|invalid object name/i.test(error.stderr)) { ctx.host.http.writeJson(res, 404, { error: "file_not_found" }); return; }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
