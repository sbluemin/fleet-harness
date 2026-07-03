import type { Dir } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { runGit } from "./git-executor.js";
import type { RepoEntry, ReposDiscoveryResult } from "./types.js";

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * scanRepos 내부 전용 확장 타입 — handleDiffRepos에서 resolveWorktreeParents로 처리 후
 * 외부로는 노출되지 않는다. 테스트에서만 직접 사용 가능.
 */
export interface RawRepoEntry extends RepoEntry {
  /** 워크트리 부모의 realpath-resolved 절대경로. resolveWorktreeParents에서 worktreeOf로 변환됨 */
  readonly _wtParentAbs?: string;
}

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

/**
 * .git 파일 내용에서 gitdir 포인터를 파싱해 링크드 워크트리 여부와 부모 절대경로를 반환.
 * 서브모듈(.git 파일이지만 /modules/ 경로)은 null 반환 → 독립 저장소로 유지.
 * 워크트리이면 { isWorktree: true, parentAbs } 반환.
 */
async function detectWorktreeParent(
  dir: string,
  gitFileContent: string,
): Promise<{ isWorktree: true; parentAbs: string } | null> {
  const match = gitFileContent.trim().match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;

  const rawPointer = match[1]!.trim();
  // 상대경로이면 워크트리 디렉터리 기준으로 resolve.
  // Windows에서 git은 gitdir 포인터를 슬래시(/)로 기록할 수 있으므로 OS 구분자로 정규화한다.
  const resolvedGitdir = path.normalize(
    path.isAbsolute(rawPointer) ? rawPointer : path.resolve(dir, rawPointer),
  );

  // 서브모듈(.git/modules/ 패턴): 워크트리로 분류하지 않음
  if (resolvedGitdir.includes(`${path.sep}modules${path.sep}`)) {
    return null;
  }

  // 링크드 워크트리(.git/worktrees/ 패턴): 부모 저장소 도출
  const worktreesSegment = `${path.sep}.git${path.sep}worktrees${path.sep}`;
  const wtIdx = resolvedGitdir.indexOf(worktreesSegment);
  if (wtIdx === -1) {
    // 알 수 없는 .git 파일 패턴 — 워크트리로 분류하지 않음
    return null;
  }

  const parentAbsRaw = resolvedGitdir.slice(0, wtIdx);

  // realpath로 정규화 (심링크 경로 vs 실제 경로 불일치 방지)
  let parentAbs: string;
  try {
    parentAbs = await fs.realpath(parentAbsRaw);
  } catch {
    parentAbs = path.normalize(parentAbsRaw);
  }

  return { isWorktree: true, parentAbs };
}

export async function scanRepos(
  theaterPath: string,
  realTheaterPath: string,
  dir: string,
  currentDepth: number,
  maxDepth: number,
  repos: RawRepoEntry[],
  cap = REPOS_CAP,
): Promise<boolean> {
  if (repos.length >= cap) return true;

  // .git 파일 또는 디렉터리 존재 여부 확인
  const gitPath = path.join(dir, ".git");
  try {
    const gitStat = await fs.stat(gitPath);
    const relPath = path.relative(theaterPath, dir);
    const name = relPath === "" ? path.basename(theaterPath) : path.basename(dir);
    const branch = await resolveRepoBranch(dir);

    if (gitStat.isFile()) {
      // .git이 파일 → 워크트리 또는 서브모듈
      const content = await fs.readFile(gitPath, "utf8");
      const worktreeResult = await detectWorktreeParent(dir, content);
      if (worktreeResult) {
        // 링크드 워크트리: _wtParentAbs 임시 저장
        repos.push({ relPath, name, branch, isWorktree: true, _wtParentAbs: worktreeResult.parentAbs });
      } else {
        // 서브모듈 또는 알 수 없는 .git 파일 → 독립 저장소
        repos.push({ relPath, name, branch });
      }
    } else {
      // .git이 디렉터리 → 일반 저장소
      repos.push({ relPath, name, branch });
    }

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

/**
 * scanRepos 결과에서 워크트리의 worktreeOf를 해결한다.
 * realTheaterPath 기준으로 각 저장소 절대경로 맵을 구축하고,
 * _wtParentAbs가 맵에 존재하면 해당 relPath를 worktreeOf로 설정한다.
 * 부모가 theater 밖이거나 스캔에 없으면 worktreeOf 없이 isWorktree만 남긴다.
 */
export function resolveWorktreeParents(
  raw: readonly RawRepoEntry[],
  realTheaterPath: string,
): RepoEntry[] {
  // realTheaterPath 기준 절대경로 → relPath 맵 구축
  const absToRelPath = new Map<string, string>();
  for (const entry of raw) {
    const absDir = path.normalize(
      entry.relPath === ""
        ? realTheaterPath
        : path.join(realTheaterPath, entry.relPath),
    );
    absToRelPath.set(absDir, entry.relPath);
  }

  return raw.map((entry): RepoEntry => {
    // _wtParentAbs 제거 후 DTO 변환
    const { _wtParentAbs, ...rest } = entry;
    if (_wtParentAbs && entry.isWorktree) {
      const normalizedParent = path.normalize(_wtParentAbs);
      const parentRelPath = absToRelPath.get(normalizedParent);
      if (parentRelPath !== undefined) {
        // 부모가 동일 theater 내에 존재 → worktreeOf 설정
        return { ...rest, worktreeOf: parentRelPath };
      }
    }
    return rest;
  });
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

  const raw: RawRepoEntry[] = [];
  const truncated = await scanRepos(theaterPath, realTheaterPath, theaterPath, 0, maxDepth, raw);

  // 워크트리 부모 해결 (realTheaterPath 기준)
  const resolved = resolveWorktreeParents(raw, realTheaterPath);

  // 정렬: theater root("") 먼저, 그다음 relPath 사전순
  resolved.sort((a, b) => {
    if (a.relPath === "") return -1;
    if (b.relPath === "") return 1;
    return a.relPath.localeCompare(b.relPath);
  });

  const result: ReposDiscoveryResult = { repos: resolved, ...(truncated ? { truncated: true } : {}) };
  ctx.host.http.writeJson(res, 200, result);
}
