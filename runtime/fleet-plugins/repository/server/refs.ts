import type http from "node:http";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { GitExecutorError, runGit } from "./git-executor.js";
import { resolveGitCwd } from "./diff.js";

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function lines(stdout: string): string[] { return stdout.split("\n").map((line) => line.trim()).filter(Boolean); }
export function parseRefItems(stdout: string, current: string): { label: string; ref: string; current: boolean }[] { return lines(stdout).flatMap((line) => { const [ref, label] = line.split("\0"); return ref && label ? [{ ref, label, current: ref === current }] : []; }); }
async function readStashes(gitCwd: string): Promise<string> {
  try {
    return (await runGit(["stash", "list", "--format=%gd%x00%s"], { cwd: gitCwd })).stdout;
  } catch (error) {
    if (error instanceof GitExecutorError) return "";
    throw error;
  }
}
/** Browser-safe, read-only ref inventory. Never return worktree filesystem paths. */
export async function handleRepositoryRefs(req: http.IncomingMessage, res: http.ServerResponse, ctx: FleetPluginServerContext): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{ theaterId?: unknown; subPath?: unknown }>(req);
  if (!isObject(body) || "subPath" in body || typeof body.theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  const resolved = resolveGitCwd(theaterPath);
  try {
    const [head, local, remote, tags, stashes] = await Promise.all([
      runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: resolved.gitCwd, allowExitCodes: [1] }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/heads"], { cwd: resolved.gitCwd }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/remotes"], { cwd: resolved.gitCwd }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/tags"], { cwd: resolved.gitCwd }),
      readStashes(resolved.gitCwd),
    ]);
    const current = head.stdout.trim();
    ctx.host.http.writeJson(res, 200, {
      branches: parseRefItems(local.stdout, current), remotes: parseRefItems(remote.stdout, current), tags: parseRefItems(tags.stdout, current),
      stashes: lines(stashes).map((line) => { const [name, subject = ""] = line.split("\0"); return { name, subject }; }),
    });
  } catch (error) {
    if (error instanceof GitExecutorError && error.code === "no_git_repo") { ctx.host.http.writeJson(res, 200, { branches: [], remotes: [], tags: [], stashes: [] }); return; }
    if (error instanceof GitExecutorError && error.code === "git_unavailable") { ctx.host.http.writeJson(res, 422, { error: error.code }); return; }
    ctx.host.http.writeJson(res, 500, { error: "git_failed" });
  }
}
