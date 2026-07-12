import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import { parseDiffFileList, resolveGitCwd } from "./diff.js";
import type { CommitMeta } from "./types.js";

// ─── constants ────────────────────────────────────────────────────────────────

export const REF_RE = /^[0-9a-f]{7,40}$/i;

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCommitMeta(output: string): CommitMeta | null {
  const fields = output.split("\0");
  if (fields.length < 6) return null;
  const [authorName, authorEmail, rawAuthorAt, subject, rawParents, ...bodyParts] = fields;
  if (authorName === undefined || authorEmail === undefined || rawAuthorAt === undefined || subject === undefined || rawParents === undefined) return null;
  const authorAt = Number.parseInt(rawAuthorAt, 10);
  if (!Number.isFinite(authorAt)) return null;
  return {
    authorName,
    authorEmail,
    authorAt,
    subject,
    body: bodyParts.join("\0").trimEnd(),
    parents: rawParents.split(" ").filter(Boolean).map((full) => ({ full, short: full.slice(0, 9) })),
  };
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleDiffCommit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly subPath?: unknown;
    readonly ref?: unknown;
  }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const ref = body.ref;
  if (typeof ref !== "string" || !REF_RE.test(ref)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_ref" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const rawSubPath = typeof body.subPath === "string" ? body.subPath : "";
  const cwdResult = await resolveGitCwd(theaterPath, rawSubPath);
  if (!cwdResult) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }
  const { gitCwd } = cwdResult;

  try {
    const [metaResult, nameStatusResult, numstatResult] = await Promise.all([
      runGit(["show", "-s", "--format=%an%x00%ae%x00%at%x00%s%x00%P%x00%b", ref], { cwd: gitCwd }),
      runGit(["show", "--first-parent", "--format=", "--relative", "--name-status", "--diff-filter=MADR", ref, "--", "."], { cwd: gitCwd }),
      runGit(["show", "--first-parent", "--format=", "--relative", "--numstat", "--diff-filter=MADR", ref, "--", "."], { cwd: gitCwd }),
    ]);
    const meta = parseCommitMeta(metaResult.stdout);
    if (!meta) { ctx.host.http.writeJson(res, 500, { error: "git_failed" }); return; }
    ctx.host.http.writeJson(res, 200, {
      meta,
      files: parseDiffFileList(nameStatusResult.stdout, numstatResult.stdout),
      ...(metaResult.truncated || nameStatusResult.truncated || numstatResult.truncated ? { truncated: true } : {}),
    });
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
