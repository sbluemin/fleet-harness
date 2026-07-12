import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { REF_RE } from "./commit.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLiteralFilePath(gitCwd: string, rawPath: string): string | null {
  const relativePath = path.normalize(rawPath);
  const resolved = path.resolve(gitCwd, relativePath);
  if (relativePath === ".." || relativePath.startsWith(".." + path.sep) || !resolved.startsWith(gitCwd + path.sep)) return null;
  return relativePath;
}

function literalPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`;
}

export async function handleDiffCommitFile(req: http.IncomingMessage, res: http.ServerResponse, ctx: FleetPluginServerContext): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly subPath?: unknown; readonly ref?: unknown; readonly filePath?: unknown; readonly oldPath?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string" || typeof body.ref !== "string" || typeof body.filePath !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  if (!REF_RE.test(body.ref)) { ctx.host.http.writeJson(res, 400, { error: "invalid_ref" }); return; }
  if (!body.filePath || body.filePath.startsWith("-")) { ctx.host.http.writeJson(res, 400, { error: "invalid_file_path" }); return; }
  if (body.oldPath !== undefined && (typeof body.oldPath !== "string" || !body.oldPath || body.oldPath.startsWith("-"))) { ctx.host.http.writeJson(res, 400, { error: "invalid_file_path" }); return; }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  const cwdResult = await resolveGitCwd(theaterPath, typeof body.subPath === "string" ? body.subPath : "");
  if (!cwdResult) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }
  const relativePath = resolveLiteralFilePath(cwdResult.gitCwd, body.filePath);
  const oldPath = typeof body.oldPath === "string" ? resolveLiteralFilePath(cwdResult.gitCwd, body.oldPath) : undefined;
  if (!relativePath || (body.oldPath !== undefined && !oldPath)) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }
  try {
    const result = await runGit(oldPath
      ? ["show", "--first-parent", body.ref, "-M", "--format=", "--unified=3", "--", literalPathspec(oldPath), literalPathspec(relativePath)]
      : ["show", "--first-parent", body.ref, "--format=", "--unified=3", "--", literalPathspec(relativePath)], { cwd: cwdResult.gitCwd });
    ctx.host.http.writeJson(res, 200, { content: result.stdout, ...(result.truncated ? { truncated: true } : {}) });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo" || error.code === "git_unavailable") { ctx.host.http.writeJson(res, 422, { error: error.code }); return; }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" }); return;
    }
    throw error;
  }
}
