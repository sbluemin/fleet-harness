import type { Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "./git-executor.js";
import type { RepoEntry, ReposDiscoveryResult } from "./types.js";

// ─── constants ───────────────────────────────────────────────────────────────

export const REPOS_CAP = 200;
// 클라이언트 "Max" 옵션 등 대형 요청의 서버측 상한. 깊을수록 I/O 비용 증가.
export const HARD_CAP_DEPTH = 8;
const DEFAULT_DEPTH = 3;

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveRepoBranch(repoDir: string): Promise<string> {
  try {
    const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
    const branch = result.stdout.trim();
    if (branch === "HEAD") {
      // detached HEAD → short SHA로 대체
      const sha = await runGit(["rev-parse", "--short", "HEAD"], { cwd: repoDir });
      return sha.stdout.trim() || "HEAD";
    }
    return branch || "HEAD";
  } catch {
    return "unknown";
  }
}

export async function scanRepos(
  theaterPath: string,
  realTheaterPath: string,
  dir: string,
  currentDepth: number,
  maxDepth: number,
  repos: RepoEntry[],
  cap = REPOS_CAP,
): Promise<boolean> {
  if (repos.length >= cap) return true;

  // .git 파일 또는 디렉터리 존재 여부 확인 (워크트리·서브모듈은 .git이 파일임)
  const gitPath = path.join(dir, ".git");
  try {
    await fs.stat(gitPath);
    const relPath = path.relative(theaterPath, dir);
    const name = relPath === "" ? path.basename(theaterPath) : path.basename(dir);
    const branch = await resolveRepoBranch(dir);
    repos.push({ relPath, name, branch });
    if (repos.length >= cap) return true;
  } catch {
    // .git 없음 — 이 디렉터리는 저장소가 아님
  }

  if (currentDepth >= maxDepth) return false;

  // 하위 디렉터리 DFS 순회 (node_modules, .git 내부 제외)
  let dirHandle: Dir | null = null;
  try {
    dirHandle = await fs.opendir(dir);
    try {
      let dirent = await dirHandle.read();
      while (dirent !== null) {
        if (repos.length >= cap) return true;
        if (dirent.isDirectory()) {
          const childName = dirent.name;
          // node_modules와 .git 내부는 절대 순회하지 않는다
          if (childName === "node_modules" || childName === ".git") {
            dirent = await dirHandle.read();
            continue;
          }
          const childPath = path.join(dir, childName);
          // 심링크: realpath로 theater 경계 이탈 여부 검증
          let realChildPath: string;
          try {
            realChildPath = await fs.realpath(childPath);
          } catch {
            dirent = await dirHandle.read();
            continue;
          }
          const normalizedReal = realTheaterPath.endsWith(path.sep) ? realTheaterPath : realTheaterPath + path.sep;
          if (realChildPath !== realTheaterPath && !realChildPath.startsWith(normalizedReal)) {
            // theater 밖으로 나가는 심링크 디렉터리 — 스킵
            dirent = await dirHandle.read();
            continue;
          }
          const truncated = await scanRepos(theaterPath, realTheaterPath, childPath, currentDepth + 1, maxDepth, repos, cap);
          if (truncated) return true;
        }
        dirent = await dirHandle.read();
      }
      return false;
    } finally {
      await dirHandle.close();
    }
  } catch {
    // 접근 불가 디렉터리(EACCES 등)는 조용히 건너뜀
    if (dirHandle) {
      try { await dirHandle.close(); } catch { /* ignore */ }
    }
    return false;
  }
}

// ─── handler ─────────────────────────────────────────────────────────────────

export async function handleDiffRepos(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly maxDepth?: unknown }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  // maxDepth: [1, HARD_CAP_DEPTH] clamp, 기본 DEFAULT_DEPTH
  const rawDepth = body.maxDepth;
  const maxDepth = typeof rawDepth === "number" && Number.isFinite(rawDepth) && rawDepth >= 1
    ? Math.min(HARD_CAP_DEPTH, Math.floor(rawDepth))
    : DEFAULT_DEPTH;

  // realpath로 theater 심링크 기반 기준점 확보
  let realTheaterPath: string;
  try {
    realTheaterPath = await fs.realpath(theaterPath);
  } catch {
    ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }

  const repos: RepoEntry[] = [];
  const truncated = await scanRepos(theaterPath, realTheaterPath, theaterPath, 0, maxDepth, repos);

  // 정렬: theater root("") 먼저, 그다음 relPath 사전순
  repos.sort((a, b) => {
    if (a.relPath === "") return -1;
    if (b.relPath === "") return 1;
    return a.relPath.localeCompare(b.relPath);
  });

  const result: ReposDiscoveryResult = { repos, ...(truncated ? { truncated: true } : {}) };
  ctx.host.http.writeJson(res, 200, result);
}
