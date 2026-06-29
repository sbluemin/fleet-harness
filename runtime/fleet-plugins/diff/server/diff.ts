import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import type { DiffFileEntry, DiffMode } from "./types.js";

// SHA(7-40 hex) 또는 브랜치/태그명(영숫자로 시작, 최대 251자). 선두 `-` 옵션류를 완전 차단한다.
const REF_SAFE_RE = /^(?:[a-f0-9]{7,40}|[A-Za-z0-9][A-Za-z0-9/_.~^-]{0,250})$/;

export function isSafeGitRef(ref: string): boolean {
  return REF_SAFE_RE.test(ref);
}

function buildDiffArgs(mode: DiffMode, ref?: string): string[] {
  if (mode === "staged") return ["diff", "--cached"];
  if (mode === "commit" && ref) return ["diff", `${ref}^`, ref];
  return ["diff"];
}

function parseDiffFileList(nameStatusOutput: string, numstatOutput: string): DiffFileEntry[] {
  const numstatMap = new Map<string, { readonly additions: number; readonly deletions: number }>();
  for (const line of numstatOutput.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [adds, dels, filePath] = parts;
    if (!filePath) continue;
    numstatMap.set(filePath, {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleDiffChanged(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly mode?: unknown; readonly ref?: unknown }>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const mode = body.mode;
  if (mode !== "workdir" && mode !== "staged" && mode !== "commit") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_mode" });
    return;
  }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawRef = typeof body.ref === "string" ? body.ref : undefined;
  if (rawRef !== undefined && !isSafeGitRef(rawRef)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_ref" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    const diffArgs = buildDiffArgs(mode, rawRef);
    const nameStatusArgs = [...diffArgs, "--name-status", "--diff-filter=MADR"];
    const numstatArgs = [...diffArgs, "--numstat", "--diff-filter=MADR"];
    const [nameStatusResult, numstatResult] = await Promise.all([
      runGit(nameStatusArgs, { cwd: theaterPath }),
      runGit(numstatArgs, { cwd: theaterPath }),
    ]);
    const files = parseDiffFileList(nameStatusResult.stdout, numstatResult.stdout);

    if (mode === "workdir") {
      try {
        const untrackedFiles = await fetchUntrackedFiles(theaterPath);
        files.push(...untrackedFiles);
      } catch {
        // untracked 열거 실패 시 조용히 생략 — 기본 diff는 이미 반환됨
      }
    }

    ctx.host.http.writeJson(res, 200, { files, truncated: nameStatusResult.truncated || numstatResult.truncated });
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

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly filePath?: unknown; readonly mode?: unknown; readonly ref?: unknown }>(req);
  if (!isPlainObject(body) || typeof body.filePath !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const mode = body.mode;
  if (mode !== "workdir" && mode !== "staged" && mode !== "commit" && mode !== "untracked") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_mode" });
    return;
  }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const rawFilePath = body.filePath;
  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const resolvedPath = path.resolve(theaterPath, rawFilePath);
  if (!resolvedPath.startsWith(theaterPath + path.sep) && resolvedPath !== theaterPath) {
    ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
    return;
  }

  const relativePath = path.normalize(rawFilePath);
  if (relativePath.startsWith("..")) { ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" }); return; }

  const rawRef = typeof body.ref === "string" ? body.ref : undefined;
  if (rawRef !== undefined && !isSafeGitRef(rawRef)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_ref" });
    return;
  }

  try {
    // untracked 파일은 git에 추적되지 않으므로 --no-index로 /dev/null과 비교.
    // --no-index는 차이가 있으면 항상 exit code 1을 반환 → allowExitCodes 사용.
    // relativePath는 이미 경로 포함 검증 완료; /dev/null은 고정 리터럴.
    if (mode === "untracked") {
      // 심링크 escaping 차단: realpath로 심링크를 추적한 실제 경로를 얻어 theater 경계를 재검증.
      // 렉시컬 검사(위의 startsWith/normalize)는 심링크를 따라가지 않으므로 방어 심층으로 유지.
      let realTheater: string;
      let realFile: string;
      try {
        [realTheater, realFile] = await Promise.all([
          fs.realpath(theaterPath),
          fs.realpath(resolvedPath),
        ]);
      } catch {
        ctx.host.http.writeJson(res, 404, { error: "file_not_found" });
        return;
      }
      if (realFile !== realTheater && !realFile.startsWith(realTheater + path.sep)) {
        ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
        return;
      }

      const result = await runGit(
        ["diff", "--no-index", "--unified=3", "--", "/dev/null", relativePath],
        { cwd: theaterPath, allowExitCodes: [1] },
      );
      ctx.host.http.writeJson(res, 200, { content: result.stdout, truncated: result.truncated });
      return;
    }

    const diffArgs = [...buildDiffArgs(mode, rawRef), "--unified=3", "--", relativePath];
    const result = await runGit(diffArgs, { cwd: theaterPath });
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
