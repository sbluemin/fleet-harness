import fs from "node:fs/promises";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { LogCommitEntry, WorktreeCheckout } from "./types.js";
import { resolveGitCwd } from "./diff.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface ParsedWorktree {
  readonly sha: string;
  readonly branch: string | null;
  readonly worktreePath: string;
}

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

export async function parseWorktreePorcelain(stdout: string, currentWorktreePath: string): Promise<WorktreeCheckout[]> {
  const worktrees: ParsedWorktree[] = [];
  let worktreePath: string | null = null;
  let sha = "";
  let branch: string | null = null;

  const pushCurrent = () => {
    if (!worktreePath || !sha) return;
    worktrees.push({
      sha,
      branch,
      worktreePath,
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

  const normalizedCurrentWorktreePath = await normalizeWorktreePath(currentWorktreePath);
  return Promise.all(worktrees.map(async ({ worktreePath, ...checkout }) => ({
    ...checkout,
    isCurrent: normalizedCurrentWorktreePath !== ""
      && (await normalizeWorktreePath(worktreePath)) === normalizedCurrentWorktreePath,
  })));
}

function isNoHeadError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision") || error.stderr.includes("bad revision");
}

async function normalizeWorktreePath(worktreePath: string): Promise<string> {
  if (!worktreePath) return "";
  try {
    return await fs.realpath(worktreePath);
  } catch {
    return worktreePath;
  }
}

async function readCurrentWorktreePath(gitCwd: string): Promise<string> {
  try {
    return (await runGit(["rev-parse", "--show-toplevel"], { cwd: gitCwd })).stdout.trim();
  } catch (error) {
    if (error instanceof GitExecutorError) return "";
    throw error;
  }
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
    const [result, worktrees, currentWorktreePath] = await Promise.all([
      runGit(
        // --all은 refs/stash·refs/notes까지 그래프에 유입시키므로 브랜치/태그/원격 + 현재 HEAD로 한정한다
        ["log", "--branches", "--tags", "--remotes", "--date-order", "-n", "200", "--decorate=full", "--pretty=format:%x1e%H%x00%h%x00%s%x00%an%x00%ar%x00%at%x00%D%x00%P", "HEAD"],
        { cwd: gitCwd },
      ),
      runGit(["worktree", "list", "--porcelain"], { cwd: gitCwd }),
      readCurrentWorktreePath(gitCwd),
    ]);
    const commits = parseLogOutput(result.stdout);
    const checkouts = await parseWorktreePorcelain(worktrees.stdout, currentWorktreePath);
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
