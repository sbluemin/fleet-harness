import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { DiffFileEntry, DiffFileMode } from "./types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// git numstat 리네임 압축 표기 `{old => new}` 에서 new 경로를 추출
function normalizeNumstatPath(p: string): string {
  const match = /^(.*?)\{[^}]* => ([^}]*)\}(.*)$/.exec(p);
  if (!match) return p;
  return (match[1] ?? "") + (match[2] ?? "") + (match[3] ?? "");
}

function parseDiffFileList(nameStatusOutput: string, numstatOutput: string): DiffFileEntry[] {
  const numstatMap = new Map<string, { readonly additions: number; readonly deletions: number }>();
  for (const line of numstatOutput.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels, filePath] = parts;
    if (!filePath) continue;
    numstatMap.set(normalizeNumstatPath(filePath), {
      additions: parseInt(adds ?? "0", 10) || 0,
      deletions: parseInt(dels ?? "0", 10) || 0,
    });
  }

  const files: DiffFileEntry[] = [];
  for (const line of nameStatusOutput.split("\n")) {
    if (!line.trim()) continue;
    const [rawStatus, ...pathParts] = line.split("\t");
    if (!rawStatus || pathParts.length === 0) continue;
    const statusChar = rawStatus.charAt(0).toUpperCase();
    if (statusChar !== "M" && statusChar !== "A" && statusChar !== "D" && statusChar !== "R") continue;
    const filePath = statusChar === "R" ? (pathParts[1] ?? pathParts[0] ?? "") : (pathParts[0] ?? "");
    if (!filePath) continue;
    const nums = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, status: statusChar as "M" | "A" | "D" | "R", ...nums });
  }
  return files;
}

// untracked 파일은 추가 줄 수를 계산하지 않는다.
// 파일별 git spawn(프로세스 폭주 위험)과 심링크를 통한 외부 파일 크기 노출을 동시에 방지.
async function fetchUntrackedFiles(cwd: string): Promise<DiffFileEntry[]> {
  const result = await runGit(["ls-files", "--others", "--exclude-standard"], { cwd });
  return result.stdout.split("\n").filter((p) => p.trim()).map((p): DiffFileEntry => ({
    path: p,
    status: "U",
    additions: 0,
    deletions: 0,
  }));
}

// no-HEAD repo(초기 커밋 없는 신규 저장소) 감지: git stderr에 "unknown revision" 또는 "bad revision" 포함
function isNoHeadError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision") || error.stderr.includes("bad revision");
}

// subPath 포함·realpath 이중 containment 검증 후 gitCwd 반환.
// 검증 실패 시 null 반환 — 호출자가 적절한 HTTP 오류를 반환한다.
async function resolveGitCwd(
  theaterPath: string,
  rawSubPath: string,
): Promise<{ gitCwd: string } | null> {
  if (rawSubPath === "") return { gitCwd: theaterPath };

  const resolvedSub = path.resolve(theaterPath, rawSubPath);
  // 렉시컬 containment: theaterPath 밖 이탈 거부
  if (!resolvedSub.startsWith(theaterPath + path.sep) && resolvedSub !== theaterPath) return null;
  if (path.normalize(rawSubPath).startsWith("..")) return null;

  // realpath containment: 심링크 이탈 거부
  let realTheater: string;
  let realSub: string;
  try {
    [realTheater, realSub] = await Promise.all([
      fs.realpath(theaterPath),
      fs.realpath(resolvedSub),
    ]);
  } catch {
    return null;
  }
  const norm = realTheater.endsWith(path.sep) ? realTheater : realTheater + path.sep;
  if (realSub !== realTheater && !realSub.startsWith(norm)) return null;

  return { gitCwd: resolvedSub };
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleDiffChanged(
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
    let files: DiffFileEntry[];
    let truncated = false;

    // git diff HEAD 통합 목록 시도 (staged+unstaged 합산)
    try {
      const [nameStatusResult, numstatResult] = await Promise.all([
        runGit(["diff", "HEAD", "--name-status", "--diff-filter=MADR"], { cwd: gitCwd }),
        runGit(["diff", "HEAD", "--numstat", "--diff-filter=MADR"], { cwd: gitCwd }),
      ]);
      files = parseDiffFileList(nameStatusResult.stdout, numstatResult.stdout);
      truncated = nameStatusResult.truncated || numstatResult.truncated;
    } catch (err) {
      if (!isNoHeadError(err)) throw err;
      // no-HEAD 신규 저장소: staged 목록으로 graceful fallback
      const [nsResult, nsNumstat] = await Promise.all([
        runGit(["diff", "--cached", "--name-status", "--diff-filter=MADR"], { cwd: gitCwd }),
        runGit(["diff", "--cached", "--numstat", "--diff-filter=MADR"], { cwd: gitCwd }),
      ]);
      files = parseDiffFileList(nsResult.stdout, nsNumstat.stdout);
      truncated = nsResult.truncated || nsNumstat.truncated;
    }

    try {
      const untrackedFiles = await fetchUntrackedFiles(gitCwd);
      files.push(...untrackedFiles);
    } catch {
      // untracked 열거 실패 시 조용히 생략 — 기본 diff는 이미 반환됨
    }

    ctx.host.http.writeJson(res, 200, { files, truncated });
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

export async function handleDiffFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly filePath?: unknown;
    readonly mode?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (!isPlainObject(body) || typeof body.filePath !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const mode = body.mode as DiffFileMode;
  if (mode !== "unified" && mode !== "untracked") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_mode" });
    return;
  }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const rawSubPath = typeof body.subPath === "string" ? body.subPath : "";
  const cwdResult = await resolveGitCwd(theaterPath, rawSubPath);
  if (!cwdResult) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }
  const { gitCwd } = cwdResult;

  // filePath를 gitCwd 기준으로 containment 검증 (이중 containment의 두 번째 단계)
  const rawFilePath = body.filePath;
  const resolvedFilePath = path.resolve(gitCwd, rawFilePath);
  if (!resolvedFilePath.startsWith(gitCwd + path.sep) && resolvedFilePath !== gitCwd) {
    ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
    return;
  }
  const relativePath = path.normalize(rawFilePath);
  if (relativePath.startsWith("..")) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }

  try {
    if (mode === "untracked") {
      // 심링크 escaping 차단: realpath로 gitCwd 경계 재검증
      let realGitCwd: string;
      let realFile: string;
      try {
        [realGitCwd, realFile] = await Promise.all([
          fs.realpath(gitCwd),
          fs.realpath(resolvedFilePath),
        ]);
      } catch {
        ctx.host.http.writeJson(res, 404, { error: "file_not_found" });
        return;
      }
      if (realFile !== realGitCwd && !realFile.startsWith(realGitCwd + path.sep)) {
        ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
        return;
      }

      // --no-index는 차이가 있으면 항상 exit code 1을 반환 → allowExitCodes 사용
      const result = await runGit(
        ["diff", "--no-index", "--unified=3", "--", "/dev/null", relativePath],
        { cwd: gitCwd, allowExitCodes: [1] },
      );
      ctx.host.http.writeJson(res, 200, { content: result.stdout, truncated: result.truncated });
      return;
    }

    // unified 모드: git diff HEAD -- <path>
    // 심링크 escaping 차단: 존재하는 파일에 한해 realpath containment 재검증
    try {
      const [realGitCwd, realFile] = await Promise.all([
        fs.realpath(gitCwd),
        fs.realpath(resolvedFilePath),
      ]);
      if (realFile !== realGitCwd && !realFile.startsWith(realGitCwd + path.sep)) {
        ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
        return;
      }
    } catch {
      // 파일이 삭제된 경우(D 상태) realpath가 실패해도 git이 안전하게 처리
    }
    const result = await runGit(["diff", "HEAD", "--unified=3", "--", relativePath], { cwd: gitCwd });
    ctx.host.http.writeJson(res, 200, { content: result.stdout, truncated: result.truncated });
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
