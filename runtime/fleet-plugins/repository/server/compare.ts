import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { GitExecutorError, runGit } from "./git-executor.js";
import { InvalidRepoError, parseDiffFileList, resolveGitCwd } from "./diff.js";
import { REF_RE } from "./commit.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FULL_REF_PREFIXES = ["refs/heads/", "refs/remotes/", "refs/tags/"] as const;

// git check-ref-format이 금지하는 특수문자: `\`·`~`·`^`·`:`·`?`·`*`·`[`
const FORBIDDEN_REF_CHARS = /[\\~^:?*\[]/;

// 공백·제어문자(0x00–0x20, 0x7F) 검사 — 정규식 리터럴에 제어 바이트를 넣지 않기 위해 코드포인트로 판정
function hasWhitespaceOrControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined || code <= 0x20 || code === 0x7f) return true;
  }
  return /\s/.test(value);
}

/**
 * Compare 대상 ref 검증. 허용: 리터럴 "HEAD", hex SHA, `refs/heads|remotes|tags/…` 풀 refname.
 * bare shortname(main 등)은 거부한다 — 클라이언트가 풀 refname을 보낸다.
 * 이 문법상 `-` 선행이 불가능해 옵션 주입이 차단된다.
 */
export function isSafeCompareRef(value: string): boolean {
  if (value === "HEAD") return true;
  if (REF_RE.test(value)) return true;
  if (!FULL_REF_PREFIXES.some((prefix) => value.startsWith(prefix))) return false;
  if (hasWhitespaceOrControlChar(value) || FORBIDDEN_REF_CHARS.test(value)) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.endsWith("/") || value.endsWith(".")) return false;
  for (const component of value.split("/")) {
    if (component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  return true;
}

export function isUnknownRevisionError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("unknown revision") || error.stderr.includes("bad revision");
}

// 무관 히스토리 ref 쌍의 triple-dot diff는 exit 128 + stderr "no merge base"로 실패한다
export function isNoMergeBaseError(error: unknown): boolean {
  if (!(error instanceof GitExecutorError)) return false;
  if (error.code !== "non_zero_exit") return false;
  return error.stderr.includes("no merge base");
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleRepositoryCompare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly subPath?: unknown;
    readonly base?: unknown;
    readonly head?: unknown;
  }>(req);
  if (!isPlainObject(body) || "subPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterId = body.theaterId;
  if (typeof theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const { base, head } = body;
  if (typeof base !== "string" || typeof head !== "string" || !isSafeCompareRef(base) || !isSafeCompareRef(head)) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_ref" });
    return;
  }
  if (base === head) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }

  const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  let cwdResult: { gitCwd: string };
  try { cwdResult = await resolveGitCwd(theaterPath, body.repoRel); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
  const { gitCwd } = cwdResult;

  const range = `${base}...${head}`;
  try {
    const [mergeBaseResult, nameStatusResult, numstatResult] = await Promise.all([
      // 비교 컨텍스트 표기용 — 실패하면 응답에서 생략한다
      runGit(["merge-base", "--end-of-options", base, head], { cwd: gitCwd }).catch(() => null),
      runGit(["diff", "--relative", "--name-status", "--diff-filter=MADRT", "-M", "--end-of-options", range, "--", "."], { cwd: gitCwd }),
      runGit(["diff", "--relative", "--numstat", "--diff-filter=MADRT", "-M", "--end-of-options", range, "--", "."], { cwd: gitCwd }),
    ]);
    const mergeBase = mergeBaseResult?.stdout.trim().slice(0, 9);
    ctx.host.http.writeJson(res, 200, {
      files: parseDiffFileList(nameStatusResult.stdout, numstatResult.stdout),
      ...(mergeBase ? { mergeBase } : {}),
      ...(nameStatusResult.truncated || numstatResult.truncated ? { truncated: true } : {}),
    });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      if (error.code === "no_git_repo" || error.code === "git_unavailable") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      if (isNoMergeBaseError(error)) {
        ctx.host.http.writeJson(res, 400, { error: "no_merge_base" });
        return;
      }
      if (isUnknownRevisionError(error)) {
        ctx.host.http.writeJson(res, 400, { error: "unknown_ref" });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
