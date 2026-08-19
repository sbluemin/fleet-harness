import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { classifyWriteError } from "./stage.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 100_000;

// fetch.ts와 같은 결로 훅 실행을 차단한다 — 브라우저 클릭이 repo-local 훅 코드를
// zero-click 실행하는 경로를 만들지 않는다. 서명은 프롬프트를 띄울 수 있어 함께 끈다.
const COMMIT_HARDENING_ARGS = [
  "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c", "commit.gpgSign=false",
] as const;

/** 스테이지에 커밋할 내용이 있는가 — unborn HEAD에서는 인덱스 항목 유무로 대신 판정한다. */
async function hasStagedChanges(gitCwd: string): Promise<boolean> {
  try {
    return (await runGit(["diff", "--cached", "--name-only", "--", "."], { cwd: gitCwd })).stdout.trim() !== "";
  } catch (error) {
    if (error instanceof GitExecutorError && /unknown revision|bad revision|ambiguous argument/i.test(error.stderr)) {
      return (await runGit(["ls-files", "--cached"], { cwd: gitCwd })).stdout.trim() !== "";
    }
    throw error;
  }
}

export function classifyCommitError(stderr: string): "identity_missing" | "nothing_to_commit" | null {
  if (/Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(stderr)) return "identity_missing";
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(stderr)) return "nothing_to_commit";
  return null;
}

export async function handleRepositoryCommitCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly subject?: unknown;
    readonly message?: unknown;
    readonly amend?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = body.message === undefined ? "" : body.message;
  const amend = body.amend === true;
  if (
    subject === ""
    || subject.length > MAX_SUBJECT_LENGTH
    || typeof message !== "string"
    || message.length > MAX_BODY_LENGTH
    || subject.includes("\0")
    || message.includes("\0")
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_message" });
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
    if (!amend && !(await hasStagedChanges(gitCwd))) {
      // "nothing to commit"는 stdout+exit 1로 끝나 stderr 분류에 안 걸린다 — 커밋 전에 스테이지 유무를 직접 묻는다.
      ctx.host.http.writeJson(res, 422, { error: "nothing_to_commit" });
      return;
    }
    const trimmedMessage = message.trim();
    const result = await runGit([
      ...COMMIT_HARDENING_ARGS,
      "commit",
      "--no-verify",
      ...(amend ? ["--amend"] : []),
      "-m", subject,
      ...(trimmedMessage ? ["-m", trimmedMessage] : []),
    ], { cwd: gitCwd });
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: gitCwd })).stdout.trim();
    ctx.host.http.writeJson(res, 200, { ok: true, sha, summary: result.stdout.split("\n")[0] ?? "" });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      const classified = classifyCommitError(error.stderr) ?? classifyCommitError(error.message);
      if (classified) { ctx.host.http.writeJson(res, 422, { error: classified }); return; }
      const locked = classifyWriteError(error.stderr);
      if (locked) { ctx.host.http.writeJson(res, 409, { error: locked }); return; }
      if (error.code === "no_git_repo" || error.code === "git_unavailable" || error.code === "timeout") {
        ctx.host.http.writeJson(res, 422, { error: error.code });
        return;
      }
      ctx.host.http.writeJson(res, 500, { error: "git_failed" });
      return;
    }
    throw error;
  }
}
