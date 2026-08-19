import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { REF_RE } from "./commit.js";
import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import type { TreeEntry, TreeResult } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 커밋 시점 트리 탐색은 폴더 단위 lazy 조회다 — `-r` 전체 재귀는 대형 저장소에서
 * 페이로드가 통제되지 않으므로 열어 본 폴더의 한 층만 읽는다.
 */
export function parseTreeEntries(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const entryPath = record.slice(tab + 1);
    const kind = meta[1];
    if (!entryPath || (kind !== "tree" && kind !== "blob")) continue;
    const trimmed = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
    entries.push({ path: entryPath, name: trimmed.slice(trimmed.lastIndexOf("/") + 1), kind });
  }
  return entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "tree" ? -1 : 1);
}

/** dirPath는 저장소 내부의 상대 디렉터리 경로만 허용한다 — 절대 경로·상위 탈출·옵션형 인자를 전부 거른다. */
export function isSafeTreeDirPath(dirPath: string): boolean {
  if (dirPath === "") return true;
  if (path.posix.isAbsolute(dirPath) || path.isAbsolute(dirPath)) return false;
  if (dirPath.includes("\0") || dirPath.startsWith("-") || dirPath.startsWith(":")) return false;
  const normalized = path.posix.normalize(dirPath);
  return normalized !== ".." && !normalized.startsWith("../");
}

export async function handleRepositoryTree(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly ref?: unknown;
    readonly dirPath?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const ref = body.ref;
  if (typeof ref !== "string" || !REF_RE.test(ref)) { ctx.host.http.writeJson(res, 400, { error: "invalid_ref" }); return; }
  const dirPath = body.dirPath === undefined ? "" : body.dirPath;
  if (typeof dirPath !== "string" || !isSafeTreeDirPath(dirPath)) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }

  try {
    // `<dir>/`는 그 폴더 안의 한 층을 나열한다. ls-tree의 경로 인자는 커밋 트리 안에서만
    // 해석되므로 파일시스템 탈출이 없고, 위의 어휘 검증이 옵션형 인자 주입을 막는다.
    const args = ["ls-tree", "-z", "--full-tree", ref, "--", dirPath === "" ? "." : `${dirPath}/`];
    const result = await runGit(args, { cwd: gitCwd });
    const payload: TreeResult = { entries: parseTreeEntries(result.stdout), truncated: result.truncated };
    ctx.host.http.writeJson(res, 200, payload);
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo" || error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      if (error.code === "non_zero_exit" && /not a tree object|Not a valid object name|bad object/i.test(error.stderr)) {
        ctx.host.http.writeJson(res, 404, { error: "ref_not_found" });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
