import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { LogCommitEntry, WorktreeCheckout } from "./types.js";
import { resolveGitCwd } from "./diff.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLogOutput(stdout: string): LogCommitEntry[] {
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
    const authorAt = Number.parseInt(fields[5] ?? "0", 10);
    const refsRaw = fields[6] ?? "";
    const parentsRaw = fields[7] ?? "";

    if (!fullHash) continue;

    const refs = refsRaw.split(",").map((r) => r.trim()).filter(Boolean);
    const parents = parentsRaw.split(" ").map((p) => p.trim()).filter(Boolean);

    commits.push({
      shortHash,
      fullHash,
      subject,
      authorName,
      relTime,
      authorAt: Number.isFinite(authorAt) ? authorAt : 0,
      refs,
      parents,
    });
  }

  return commits;
}

export function parseWorktreePorcelain(stdout: string, currentWorktreePath: string): WorktreeCheckout[] {
  const checkouts: WorktreeCheckout[] = [];
  let worktreePath: string | null = null;
  let sha = "";
  let branch: string | null = null;

  const pushCurrent = () => {
    if (!worktreePath || !sha) return;
    checkouts.push({
      sha,
      branch,
      worktreePath,
      isCurrent: worktreePath === currentWorktreePath,
    });
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      pushCurrent();
      worktreePath = line.slice(9);
      sha = "";
      branch = null;
    } else if (line.startsWith("HEAD ")) {
      sha = line.slice(5);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice(7);
      branch = ref.startsWith("refs/heads/") ? ref.slice(11) : ref;
    }
  }
  pushCurrent();

  return checkouts;
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
    const [result, worktrees, currentWorktree] = await Promise.all([
      runGit(
        ["log", "--all", "--date-order", "-n", "200", "--decorate=full", "--pretty=format:%x1e%H%x00%h%x00%s%x00%an%x00%ar%x00%at%x00%D%x00%P"],
        { cwd: gitCwd },
      ),
      runGit(["worktree", "list", "--porcelain"], { cwd: gitCwd }),
      runGit(["rev-parse", "--show-toplevel"], { cwd: gitCwd }),
    ]);
    const commits = parseLogOutput(result.stdout);
    const checkouts = parseWorktreePorcelain(worktrees.stdout, currentWorktree.stdout.trim());
    ctx.host.http.writeJson(res, 200, { commits, checkouts, ...(result.truncated ? { truncated: true } : {}) });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo") {
        ctx.host.http.writeJson(res, 200, { commits: [], checkouts: [] });
        return;
      }
      if (error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      // no-HEAD 신규 저장소(HEAD 미존재)는 빈 배열 graceful; 그 외 비정상 종료는 500 — 500 분기보다 먼저 검사한다
      if (isNoHeadError(error)) {
        ctx.host.http.writeJson(res, 200, { commits: [], checkouts: [] });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
