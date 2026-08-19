import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import type { DiffFileEntry, StatusResult } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type NumstatMap = ReadonlyMap<string, { readonly additions: number; readonly deletions: number }>;

function parseNumstat(stdout: string): NumstatMap {
  const map = new Map<string, { readonly additions: number; readonly deletions: number }>();
  // -z numstat: `adds\tdels\t경로` — 리네임은 경로 필드가 NUL로 갈라져 `adds\tdels\t` + `old` + `new`로 온다.
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    let filePath = parts[2]!;
    if (filePath === "" && index + 2 < records.length) {
      filePath = records[index + 2]!;
      index += 2;
    }
    if (!filePath) continue;
    map.set(filePath, {
      additions: Number.parseInt(parts[0] ?? "0", 10) || 0,
      deletions: Number.parseInt(parts[1] ?? "0", 10) || 0,
    });
  }
  return map;
}

const STATUS_CHARS = new Set(["M", "A", "D", "R", "T"]);

function toEntry(statusChar: string, filePath: string, oldPath: string | undefined, nums: NumstatMap): DiffFileEntry | null {
  if (!STATUS_CHARS.has(statusChar)) return null;
  const stat = nums.get(filePath) ?? { additions: 0, deletions: 0 };
  return {
    path: filePath,
    ...(oldPath ? { oldPath } : {}),
    status: statusChar as DiffFileEntry["status"],
    ...stat,
  };
}

export interface ParsedStatus {
  readonly staged: DiffFileEntry[];
  readonly unstaged: DiffFileEntry[];
}

/**
 * `git status --porcelain=v2 -z`를 스테이지 축으로 가른다.
 * 한 파일이 양쪽에 다 있을 수 있다(스테이지 후 재수정) — Fork와 같은 문법으로 두 목록에 모두 싣는다.
 */
export function parseStatusV2(stdout: string, stagedNums: NumstatMap, unstagedNums: NumstatMap): ParsedStatus {
  const staged: DiffFileEntry[] = [];
  const unstaged: DiffFileEntry[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const kind = record.charAt(0);
    if (kind === "1" || kind === "2") {
      // `1 XY sub mH mI mW hH hI path` / `2 XY sub mH mI mW hH hI Xscore path` + NUL + origPath
      // 경로는 고정 필드 수 뒤의 나머지 전부다 — 공백 포함 경로가 다시 이어 붙는다.
      const fields = record.split(" ");
      const xy = fields[1] ?? "..";
      const filePath = fields.slice(kind === "1" ? 8 : 9).join(" ");
      if (!filePath) continue;
      let oldPath: string | undefined;
      if (kind === "2" && index + 1 < records.length) {
        oldPath = records[index + 1] || undefined;
        index += 1;
      }
      const stagedChar = xy.charAt(0);
      const unstagedChar = xy.charAt(1);
      if (stagedChar !== ".") {
        const entry = toEntry(stagedChar, filePath, oldPath, stagedNums);
        if (entry) staged.push(entry);
      }
      if (unstagedChar !== ".") {
        const entry = toEntry(unstagedChar === "R" ? "R" : unstagedChar, filePath, undefined, unstagedNums);
        if (entry) unstaged.push(entry);
      }
    } else if (kind === "?") {
      const filePath = record.slice(2);
      if (filePath) unstaged.push({ path: filePath, status: "U", additions: 0, deletions: 0 });
    } else if (kind === "u") {
      // 병합 충돌 항목 — 스테이징 UI가 절반만 집어삼키지 않도록 unstaged에 U로 표면화한다.
      const filePath = record.split(" ").slice(10).join(" ");
      if (filePath) unstaged.push({ path: filePath, status: "U", additions: 0, deletions: 0 });
    }
  }
  return { staged, unstaged };
}

export async function handleRepositoryStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }

  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }

  try {
    const [statusResult, stagedNumsResult, unstagedNumsResult] = await Promise.all([
      runGit(["status", "--porcelain=v2", "--untracked-files=all", "-z"], { cwd: gitCwd }),
      // 스테이지 열의 +/− — unborn HEAD에서는 비교 대상이 없어 실패하므로 빈 목록으로 강등한다.
      runGit(["diff", "--cached", "--numstat", "-z", "--", "."], { cwd: gitCwd }).catch(() => ({ stdout: "", truncated: false })),
      runGit(["diff", "--numstat", "-z", "--", "."], { cwd: gitCwd }).catch(() => ({ stdout: "", truncated: false })),
    ]);
    const parsed = parseStatusV2(statusResult.stdout, parseNumstat(stagedNumsResult.stdout), parseNumstat(unstagedNumsResult.stdout));
    const payload: StatusResult = { staged: parsed.staged, unstaged: parsed.unstaged, truncated: statusResult.truncated };
    ctx.host.http.writeJson(res, 200, payload);
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
