import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { classifyWriteError } from "./stage.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STASH_NAME_RE = /^stash@\{\d{1,4}\}$/;
const MAX_STASH_MESSAGE_LENGTH = 500;
const STASH_HARDENING_ARGS = [
  "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
] as const;

export type StashAction = "save" | "apply" | "pop" | "drop";

export function readStashAction(value: unknown): StashAction | null {
  return value === "save" || value === "apply" || value === "pop" || value === "drop" ? value : null;
}

export function classifyStashError(stderr: string): "stash_conflict" | "nothing_to_stash" | null {
  if (/conflict|could not restore untracked files|overwritten by merge/i.test(stderr)) return "stash_conflict";
  if (/No local changes to save/i.test(stderr)) return "nothing_to_stash";
  return null;
}

export async function handleRepositoryStash(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly repoRel?: unknown;
    readonly action?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
    readonly subPath?: unknown;
  }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const action = readStashAction(body.action);
  if (!action) { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const name = body.name;
  if (action !== "save" && (typeof name !== "string" || !STASH_NAME_RE.test(name))) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_stash" });
    return;
  }
  const message = body.message === undefined ? "" : body.message;
  if (typeof message !== "string" || message.length > MAX_STASH_MESSAGE_LENGTH || message.includes("\0") || message.trimStart().startsWith("-")) {
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
    if (action === "save") {
      // -u: Fork처럼 untracked까지 담는다 — 스테이징 뷰가 보여 주는 전부가 스태시 한 장으로 이동한다.
      const trimmed = message.trim();
      const result = await runGit([
        ...STASH_HARDENING_ARGS,
        "stash", "push", "-u",
        ...(trimmed ? ["-m", trimmed] : []),
      ], { cwd: gitCwd });
      if (/No local changes to save/i.test(result.stdout)) {
        ctx.host.http.writeJson(res, 422, { error: "nothing_to_stash" });
        return;
      }
      ctx.host.http.writeJson(res, 200, { ok: true });
      return;
    }
    await runGit([...STASH_HARDENING_ARGS, "stash", action, name as string], { cwd: gitCwd });
    ctx.host.http.writeJson(res, 200, { ok: true });
  } catch (error) {
    if (error instanceof GitExecutorError) {
      const classified = classifyStashError(error.stderr);
      if (classified) { ctx.host.http.writeJson(res, 409, { error: classified }); return; }
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
