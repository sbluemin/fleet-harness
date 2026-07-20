import type { Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "./git-executor.js";
import { parseWorktreePorcelainEntries } from "./log.js";
import { isPathContained } from "./path-containment.js";
import type { RepoCandidate, ReposResult } from "./types.js";

export const REPOS_CAP = 200;
export const HARD_CAP_DEPTH = 8;
export const NESTED_BRANCH_CAP = 64;
const DEFAULT_DEPTH = 3;

export interface ScannedRepo {
  readonly relPath: string;
  readonly name: string;
  readonly repoDir: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveRepoBranch(repoDir: string): Promise<string> {
  try {
    // porcelain v2 branch headers expose symbolic branch and detached OID in one process.
    const result = await runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=no"], { cwd: repoDir });
    const branch = result.stdout.split("\n").find((line) => line.startsWith("# branch.head "))?.slice(14).trim() ?? "";
    const oid = result.stdout.split("\n").find((line) => line.startsWith("# branch.oid "))?.slice(13).trim() ?? "";
    return branch === "(detached)" ? oid.slice(0, 7) : branch;
  } catch {
    return "";
  }
}

/** Sentinel-reviewed bounded scanner, retained without Git process fan-out. */
export async function scanRepos(
  theaterPath: string,
  realTheaterPath: string,
  dir: string,
  currentDepth: number,
  maxDepth: number,
  repos: ScannedRepo[],
  cap = REPOS_CAP,
): Promise<boolean> {
  if (repos.length >= cap) return true;

  try {
    await fs.stat(path.join(dir, ".git"));
    const relPath = path.relative(realTheaterPath, dir);
    repos.push({ relPath, name: relPath === "" ? path.basename(realTheaterPath) : path.basename(dir), repoDir: dir });
    if (repos.length >= cap) return true;
  } catch {
    // Not a repository candidate.
  }

  if (currentDepth >= maxDepth) return false;

  let dirHandle: Dir | null = null;
  try {
    dirHandle = await fs.opendir(dir);
    let dirent = await dirHandle.read();
    while (dirent !== null) {
      if (repos.length >= cap) return true;
      if (dirent.isDirectory() && dirent.name !== "node_modules" && dirent.name !== ".git") {
        const childPath = path.join(dir, dirent.name);
        let realChildPath: string;
        try { realChildPath = await fs.realpath(childPath); }
        catch { dirent = await dirHandle.read(); continue; }
        if (isPathContained(realTheaterPath, realChildPath)) {
          const truncated = await scanRepos(realTheaterPath, realTheaterPath, realChildPath, currentDepth + 1, maxDepth, repos, cap);
          if (truncated) return true;
        }
      }
      dirent = await dirHandle.read();
    }
    return false;
  } catch {
    return false;
  } finally {
    if (dirHandle) {
      try { await dirHandle.close(); } catch { /* ignore */ }
    }
  }
}

export async function resolveNestedRepoCandidates(
  candidates: readonly ScannedRepo[],
  availableSlots: number,
  resolver: (repoDir: string) => Promise<string> = resolveRepoBranch,
): Promise<RepoCandidate[]> {
  const resolved: RepoCandidate[] = [];
  const selected = candidates.slice(0, Math.max(0, availableSlots));
  for (const [index, candidate] of selected.entries()) {
    resolved.push({
      relPath: candidate.relPath,
      name: candidate.name,
      branch: index < NESTED_BRANCH_CAP ? await resolver(candidate.repoDir) : "",
      kind: "nested",
    });
  }
  return resolved;
}

export async function handleRepositoryRepos(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly maxDepth?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let realTheaterPath: string;
  try { realTheaterPath = await fs.realpath(theaterPath); }
  catch { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const maxDepth = typeof body.maxDepth === "number" && Number.isFinite(body.maxDepth)
    ? Math.max(1, Math.min(HARD_CAP_DEPTH, Math.floor(body.maxDepth)))
    : DEFAULT_DEPTH;
  const repos: RepoCandidate[] = [];
  const seen = new Set<string>();
  let truncated = false;

  let rootIsRepo = false;
  try { await fs.stat(path.join(theaterPath, ".git")); rootIsRepo = true; }
  catch { /* Theater root is not required to be a repository. */ }

  if (rootIsRepo) {
    repos.push({ relPath: "", name: path.basename(theaterPath), branch: await resolveRepoBranch(theaterPath), kind: "root" });
    seen.add("");

    try {
      const result = await runGit(["worktree", "list", "--porcelain"], { cwd: theaterPath });
      for (const worktree of parseWorktreePorcelainEntries(result.stdout)) {
        let realWorktree: string;
        try { realWorktree = await fs.realpath(worktree.worktreePath); }
        catch { continue; }
        if (!isPathContained(realTheaterPath, realWorktree)) continue;
        const relPath = path.relative(realTheaterPath, realWorktree);
        if (seen.has(relPath)) continue;
        if (repos.length >= REPOS_CAP) { truncated = true; break; }
        repos.push({
          relPath,
          name: path.basename(realWorktree),
          branch: worktree.branch ?? worktree.sha.slice(0, 7),
          kind: "worktree",
        });
        seen.add(relPath);
      }
    } catch {
      // Root repository remains useful even when worktree enumeration fails.
    }
  }

  const scanned: ScannedRepo[] = [];
  const scanCap = Math.max(0, REPOS_CAP - repos.length);
  truncated = (await scanRepos(realTheaterPath, realTheaterPath, realTheaterPath, 0, maxDepth, scanned, scanCap)) || truncated;
  const unseenNested = scanned.filter((candidate) => !seen.has(candidate.relPath));
  const remainingSlots = Math.max(0, REPOS_CAP - repos.length);
  if (unseenNested.length > remainingSlots) truncated = true;
  const nestedCandidates = await resolveNestedRepoCandidates(unseenNested, remainingSlots);
  for (const candidate of nestedCandidates) {
    if (repos.length >= REPOS_CAP) { truncated = true; break; }
    repos.push(candidate);
    seen.add(candidate.relPath);
  }

  const result: ReposResult = { repos, ...(truncated ? { truncated: true } : {}) };
  ctx.host.http.writeJson(res, 200, result);
}
