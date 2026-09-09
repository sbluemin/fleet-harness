import type http from "node:http";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { GitExecutorError, runGit } from "./git-executor.js";
import { InvalidRepoError, resolveGitCwd } from "./diff.js";

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function lines(stdout: string): string[] { return stdout.split("\n").map((line) => line.trim()).filter(Boolean); }
export interface RefItem { readonly label: string; readonly ref: string; readonly current: boolean; readonly upstream?: string; readonly ahead?: number; readonly behind?: number; readonly gone?: true }
/** `%(upstream:track,nobracket)` → "ahead 2, behind 1" | "gone" | "" — 숫자를 못 읽으면 필드를 아예 비운다(0으로 단정하지 않는다). */
export function parseUpstreamTrack(track: string): { ahead: number; behind: number } | { gone: true } | null {
  const trimmed = track.trim();
  if (!trimmed) return null;
  if (trimmed === "gone") return { gone: true };
  const ahead = /\bahead (\d+)/.exec(trimmed);
  const behind = /\bbehind (\d+)/.exec(trimmed);
  if (!ahead && !behind) return null;
  return { ahead: ahead ? Number.parseInt(ahead[1]!, 10) : 0, behind: behind ? Number.parseInt(behind[1]!, 10) : 0 };
}
export function parseRefItems(stdout: string, current: string): RefItem[] {
  return lines(stdout).flatMap((line) => {
    const [ref, label, upstream, track] = line.split("\0");
    if (!ref || !label) return [];
    const item: RefItem = { ref, label, current: ref === current };
    if (!upstream) return [item];
    const parsed = parseUpstreamTrack(track ?? "");
    return [{ ...item, upstream, ...(parsed ?? {}) }];
  });
}
/** `git remote -v` → 원격 이름별 fetch 호스트. 브라우저에는 호스트만 건네고 URL·경로·자격 증명은 내보내지 않는다. */
export function parseRemoteHosts(stdout: string): { name: string; host: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const line of lines(stdout)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    if (!match || seen.has(match[1]!)) continue;
    seen.set(match[1]!, remoteHostOf(match[2]!));
  }
  return [...seen].map(([name, host]) => ({ name, host }));
}
export function remoteHostOf(url: string): string | null {
  const scp = /^(?:[^@\/]+@)?([A-Za-z0-9.-]+):(?!\/\/)/.exec(url);
  if (scp) return scp[1]!.toLowerCase();
  try { const parsed = new URL(url); return parsed.hostname ? parsed.hostname.toLowerCase() : null; } catch { return null; }
}
export function resolveDefaultBase(input: { originHead: string; branches: readonly { ref: string }[]; remotes: readonly { ref: string }[] }): string | null {
  const originHead = input.originHead.trim();
  const match = /^refs\/remotes\/origin\/(.+)$/.exec(originHead);
  if (match) {
    const localRef = `refs/heads/${match[1]}`;
    if (input.branches.some((item) => item.ref === localRef)) return localRef;
    if (input.remotes.some((item) => item.ref === originHead)) return originHead;
  }
  if (input.branches.some((item) => item.ref === "refs/heads/main")) return "refs/heads/main";
  if (input.branches.some((item) => item.ref === "refs/heads/master")) return "refs/heads/master";
  return null;
}
async function readStashes(gitCwd: string): Promise<string> {
  try {
    return (await runGit(["stash", "list", "--format=%gd%x00%H%x00%s"], { cwd: gitCwd })).stdout;
  } catch (error) {
    if (error instanceof GitExecutorError) return "";
    throw error;
  }
}
/** Browser-safe, read-only ref inventory. Never return worktree filesystem paths. */
export async function handleRepositoryRefs(req: http.IncomingMessage, res: http.ServerResponse, ctx: FleetPluginServerContext): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{ theaterId?: unknown; repoRel?: unknown; subPath?: unknown }>(req);
  if (!isObject(body) || "subPath" in body || typeof body.theaterId !== "string") { ctx.host.http.writeJson(res, 400, { error: "invalid_request" }); return; }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  let resolved: { gitCwd: string };
  try { resolved = await resolveGitCwd(theaterPath, body.repoRel); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return; }
    throw error;
  }
  try {
    const [head, originHead, local, remote, tags, stashes, remoteList] = await Promise.all([
      runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd: resolved.gitCwd, allowExitCodes: [1] }),
      runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: resolved.gitCwd, allowExitCodes: [1] }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)", "refs/heads"], { cwd: resolved.gitCwd }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/remotes"], { cwd: resolved.gitCwd }),
      runGit(["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/tags"], { cwd: resolved.gitCwd }),
      readStashes(resolved.gitCwd),
      runGit(["remote", "-v"], { cwd: resolved.gitCwd, allowExitCodes: [1] }).then((result) => result.stdout).catch(() => ""),
    ]);
    const current = head.stdout.trim();
    const branches = parseRefItems(local.stdout, current);
    const remotes = parseRefItems(remote.stdout, current);
    const defaultBase = resolveDefaultBase({ originHead: originHead.stdout, branches, remotes });
    ctx.host.http.writeJson(res, 200, {
      branches, remotes, tags: parseRefItems(tags.stdout, current),
      stashes: lines(stashes).flatMap((line) => {
        const [name, sha, subject = ""] = line.split("\0");
        return name && sha ? [{ name, sha, subject }] : [];
      }),
      remoteHosts: parseRemoteHosts(remoteList),
      ...(defaultBase ? { defaultBase } : {}),
    });
  } catch (error) {
    if (error instanceof GitExecutorError && error.code === "no_git_repo") { ctx.host.http.writeJson(res, 200, { branches: [], remotes: [], tags: [], stashes: [], remoteHosts: [] }); return; }
    if (error instanceof GitExecutorError && error.code === "git_unavailable") { ctx.host.http.writeJson(res, 422, { error: error.code }); return; }
    ctx.host.http.writeJson(res, 500, { error: "git_failed" });
  }
}
