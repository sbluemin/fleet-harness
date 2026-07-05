import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { LogCommitEntry } from "./types.js";
import { resolveGitCwd } from "./diff.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLogOutput(stdout: string): LogCommitEntry[] {
  if (!stdout.trim()) return [];
  const commits: LogCommitEntry[] = [];

  for (const chunk of stdout.split("\x1e")) {
    const trimmed = chunk.trimStart();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    const firstLine = lines[0] ?? "";
    const fields = firstLine.split("\x00");

    const fullHash = fields[0] ?? "";
    const shortHash = fields[1] ?? "";
    const subject = fields[2] ?? "";
    const authorName = fields[3] ?? "";
    const relTime = fields[4] ?? "";
    const refsRaw = fields[5] ?? "";
    const parentsRaw = fields[6] ?? "";

    if (!fullHash) continue;

    const refs = refsRaw.split(",").map((r) => r.trim()).filter(Boolean);
    const parents = parentsRaw.split(" ").map((p) => p.trim()).filter(Boolean);

    let additions = 0;
    let deletions = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 2) continue;
      const a = parseInt(parts[0] ?? "0", 10);
      const d = parseInt(parts[1] ?? "0", 10);
      if (!isNaN(a)) additions += a;
      if (!isNaN(d)) deletions += d;
    }

    commits.push({ shortHash, fullHash, subject, authorName, relTime, refs, parents, additions, deletions });
  }

  return commits;
}

function isNoHeadError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision") || error.stderr.includes("bad revision");
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleDiffLog(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly subPath?: unknown }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const rawSubPath = typeof body.subPath === "string" ? body.subPath : "";
  const cwdResult = await resolveGitCwd(theaterPath, rawSubPath);
  if (!cwdResult) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }
  const { gitCwd } = cwdResult;

  try {
    const result = await runGit(
      ["log", "-n", "50", "--numstat", "--pretty=format:%x1e%H%x00%h%x00%s%x00%an%x00%ar%x00%D%x00%P"],
      { cwd: gitCwd },
    );
    const commits = parseLogOutput(result.stdout);
    ctx.host.http.writeJson(res, 200, { commits, ...(result.truncated ? { truncated: true } : {}) });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo") {
        ctx.host.http.writeJson(res, 200, { commits: [] });
        return;
      }
      if (error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      // no-HEAD 신규 저장소(HEAD 미존재)는 빈 배열 graceful; 그 외 비정상 종료는 500 — 500 분기보다 먼저 검사한다
      if (isNoHeadError(error)) {
        ctx.host.http.writeJson(res, 200, { commits: [] });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
