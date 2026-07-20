import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import { isPathContained } from "./path-containment.js";
import type { DiffFileEntry, DiffFileMode } from "./types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function literalPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`;
}

// git numstat 리네임 압축 표기 `{old => new}` 에서 new 경로를 추출
function normalizeNumstatPath(p: string): string {
  const match = /^(.*?)\{[^}]* => ([^}]*)\}(.*)$/.exec(p);
  if (match) return (match[1] ?? "") + (match[2] ?? "") + (match[3] ?? "");
  // Limitation: a literal filename containing ` => ` is indistinguishable from Git's non-NUL rename notation and gets zero stats.
  const plainRename = /^.+ => (.+)$/.exec(p);
  return plainRename?.[1] ?? p;
}

export function parseDiffFileList(nameStatusOutput: string, numstatOutput: string): DiffFileEntry[] {
  const numstatMap = new Map<string, { readonly additions: number; readonly deletions: number }>();
  for (const line of numstatOutput.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels] = parts;
    const filePath = parts.length > 3 ? parts[parts.length - 1] : parts[2];
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
    if (statusChar !== "M" && statusChar !== "A" && statusChar !== "D" && statusChar !== "R" && statusChar !== "T") continue;
    const oldPath = statusChar === "R" ? pathParts[0] : undefined;
    const filePath = statusChar === "R" ? (pathParts[1] ?? pathParts[0] ?? "") : (pathParts[0] ?? "");
    if (!filePath) continue;
    const nums = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({ path: filePath, ...(oldPath ? { oldPath } : {}), status: statusChar as "M" | "A" | "D" | "R" | "T", ...nums });
  }
  return files;
}

// untracked 파일은 추가 줄 수를 계산하지 않는다.
// 파일별 git spawn(프로세스 폭주 위험)과 심링크를 통한 외부 파일 크기 노출을 동시에 방지.
async function fetchUntrackedFiles(cwd: string): Promise<DiffFileEntry[]> {
  const result = await runGit(["ls-files", "--others", "--exclude-standard", "--", "."], { cwd });
  return result.stdout.split("\n").filter((p) => p.trim()).map((p): DiffFileEntry => ({
    path: p,
    status: "U",
    additions: 0,
    deletions: 0,
  }));
}

async function ensureGitRepository(cwd: string): Promise<void> {
  await runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
}

// no-HEAD repo(초기 커밋 없는 신규 저장소) 감지: git stderr에 "unknown revision" 또는 "bad revision" 포함
function isNoHeadError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision") || error.stderr.includes("bad revision");
}

export class InvalidRepoError extends Error {
  readonly code = "invalid_repo";
}

export async function resolveGitCwd(theaterPath: string, repoRel: unknown = ""): Promise<{ gitCwd: string }> {
  if (repoRel === undefined || repoRel === "") return { gitCwd: theaterPath };
  if (typeof repoRel !== "string" || path.isAbsolute(repoRel)) throw new InvalidRepoError("Repository path must be relative");

  const normalized = path.normalize(repoRel);
  if (normalized.startsWith("-") || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new InvalidRepoError("Repository path is invalid");
  }

  const resolved = path.resolve(theaterPath, normalized);
  if (!isPathContained(theaterPath, resolved)) throw new InvalidRepoError("Repository path escapes Theater");

  let realTheater: string;
  let realRepo: string;
  try {
    [realTheater, realRepo] = await Promise.all([fs.realpath(theaterPath), fs.realpath(resolved)]);
  } catch {
    throw new InvalidRepoError("Repository path does not exist");
  }
  if (!isPathContained(realTheater, realRepo)) {
    throw new InvalidRepoError("Repository path escapes Theater");
  }
  try {
    await fs.stat(path.join(realRepo, ".git"));
  } catch {
    throw new InvalidRepoError("Repository marker does not exist");
  }
  return { gitCwd: realRepo };
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleRepositoryChanged(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown }>(req);
  // subPath는 저장소 내부 스코핑이라 계속 금지한다. repoRel은 검증된 저장소 루트 선택만 담당한다.
  if (!isPlainObject(body) || "subPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let cwdResult: { gitCwd: string };
  try { cwdResult = await resolveGitCwd(theaterPath, body.repoRel); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
  const { gitCwd } = cwdResult;

  try {
    await ensureGitRepository(gitCwd);
    let files: DiffFileEntry[];
    let truncated = false;

    // git diff HEAD 통합 목록 시도 (staged+unstaged 합산)
    try {
      const [nameStatusResult, numstatResult] = await Promise.all([
        runGit(["diff", "HEAD", "--relative", "--name-status", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
        runGit(["diff", "HEAD", "--relative", "--numstat", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
      ]);
      files = parseDiffFileList(nameStatusResult.stdout, numstatResult.stdout);
      truncated = nameStatusResult.truncated || numstatResult.truncated;
    } catch (err) {
      if (!isNoHeadError(err)) throw err;
      // no-HEAD 신규 저장소: staged 목록으로 graceful fallback
      const [nsResult, nsNumstat] = await Promise.all([
        runGit(["diff", "--cached", "--relative", "--name-status", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
        runGit(["diff", "--cached", "--relative", "--numstat", "--diff-filter=MADRT", "--", "."], { cwd: gitCwd }),
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

export async function handleRepositoryFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly filePath?: unknown;
    readonly mode?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.filePath !== "string") {
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

  let cwdResult: { gitCwd: string };
  try { cwdResult = await resolveGitCwd(theaterPath, body.repoRel); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
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

      // --no-index는 차이가 있으면 항상 exit code 1을 반환 → allowExitCodes 사용.
      // --no-index는 경로를 pathspec이 아닌 파일시스템 경로로 취급하므로 magic이 해석되지 않는다
      // (위의 lexical + realpath containment로 이미 방어). 여기에 :(literal)을 붙이면
      // git이 ":(literal)<path>"라는 없는 파일을 찾아 실패하므로 원본 경로를 그대로 전달한다.
      const result = await runGit(
        ["diff", "--no-index", "--relative", "--unified=3", "--", "/dev/null", relativePath],
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
    let result;
    try {
      result = await runGit(["diff", "HEAD", "--relative", "--unified=3", "--", literalPathspec(relativePath)], { cwd: gitCwd });
    } catch (err) {
      if (!isNoHeadError(err)) throw err;
      // no-HEAD 신규 저장소: staged hunk를 --cached로 조회 (changed 목록의 fallback과 동일)
      result = await runGit(["diff", "--cached", "--relative", "--unified=3", "--", literalPathspec(relativePath)], { cwd: gitCwd });
    }
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
