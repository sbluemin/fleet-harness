import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { InvalidRepoError, resolveGitCwd } from "./diff.js";
import { classifyFetchError, NETWORK_HARDENING_ARGS, NoRemoteError, resolveCredentialHelperArgs, resolveDefaultRemote } from "./fetch.js";
import { GitExecutorError, runGit } from "./git-executor.js";
import { classifyWriteError } from "./stage.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 원격 동사는 왕복이 길다 — fetch와 같은 이유로 기본 30s보다 여유를 준다.
const REMOTE_TIMEOUT_MS = 120_000;

export function classifyPushError(stderr: string): "non_fast_forward" | null {
  return /non-fast-forward|fetch first|updates were rejected/i.test(stderr) ? "non_fast_forward" : null;
}

export function classifyPullError(stderr: string): "non_fast_forward" | "dirty_worktree" | null {
  if (/not possible to fast-forward|need to specify how to reconcile|diverg/i.test(stderr)) return "non_fast_forward";
  if (/overwritten by merge|Please commit your changes or stash/i.test(stderr)) return "dirty_worktree";
  return null;
}

interface RemoteContext {
  readonly gitCwd: string;
  readonly branch: string;
}

async function resolveRemoteContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<RemoteContext | null> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return null; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return null; }
  const body = await ctx.host.http.readJsonBody<{ readonly theaterId?: unknown; readonly repoRel?: unknown; readonly subPath?: unknown }>(req);
  if (!isPlainObject(body) || "subPath" in body || typeof body.theaterId !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return null;
  }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return null; }
  let gitCwd: string;
  try { ({ gitCwd } = await resolveGitCwd(theaterPath, body.repoRel)); }
  catch (error) {
    if (error instanceof InvalidRepoError) { ctx.host.http.writeJson(res, 400, { error: error.code }); return null; }
    throw error;
  }
  try {
    const branch = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: gitCwd, allowExitCodes: [1] })).stdout.trim();
    if (!branch) { ctx.host.http.writeJson(res, 422, { error: "detached_head" }); return null; }
    return { gitCwd, branch };
  } catch (error) {
    writeRemoteFailure(res, ctx, error, () => null);
    return null;
  }
}

function writeRemoteFailure(
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  error: unknown,
  classify: (stderr: string) => string | null,
): void {
  if (error instanceof NoRemoteError) { ctx.host.http.writeJson(res, 422, { error: "no_remote" }); return; }
  if (error instanceof GitExecutorError) {
    if (error.code === "timeout") { ctx.host.http.writeJson(res, 422, { error: "timeout" }); return; }
    const specific = classify(error.stderr);
    if (specific) { ctx.host.http.writeJson(res, 409, { error: specific }); return; }
    const network = classifyFetchError(error.stderr);
    if (network) { ctx.host.http.writeJson(res, 422, { error: network }); return; }
    const locked = classifyWriteError(error.stderr);
    if (locked) { ctx.host.http.writeJson(res, 409, { error: locked }); return; }
    if (error.code === "no_git_repo" || error.code === "git_unavailable") {
      ctx.host.http.writeJson(res, 422, { error: error.code });
      return;
    }
    ctx.host.http.writeJson(res, 500, { error: "git_failed" });
    return;
  }
  throw error;
}

/**
 * 동사의 결과를 "몇 커밋"이라는 실질로 돌려주기 위한 보조 계수 — 실패하면 null을 돌려
 * 성공한 동사를 절대 실패로 뒤집지 않는다. range는 서버가 만든 sha 또는 고정 리터럴이라
 * 옵션처럼 보이는 입력이 될 수 없다.
 */
async function countCommits(gitCwd: string, range: string): Promise<number | null> {
  try {
    const raw = (await runGit(["rev-list", "--count", range], { cwd: gitCwd })).stdout.trim();
    const count = Number.parseInt(raw, 10);
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * 보낸 커밋 수의 유일한 정직한 출처는 push 자신이 보고한 원격 ref의 이동이다 — 로컬 추적 ref는
 * 다른 체크아웃이 같은 커밋을 이미 민 경우 낡아 있어, 아무것도 보내지 않은 push를 "N개 보냄"으로
 * 읽게 만든다. `--porcelain`의 `<flag>\t<from>:<to>\t<summary>` 줄에서 `<old>..<new>`만 취하고,
 * 새 브랜치·해석 불가는 0으로 단정하지 않고 null로 물러난다.
 */
type PushOutcome = { readonly kind: "moved"; readonly from: string; readonly to: string } | { readonly kind: "up_to_date" } | null;

function parsePushOutcome(stdout: string, branch: string): PushOutcome {
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const [, refPair, summary] = fields;
    if (!refPair || !summary) continue;
    if (refPair.split(":")[1] !== `refs/heads/${branch}`) continue;
    const trimmed = summary.trim();
    const moved = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/.exec(trimmed);
    if (moved) return { kind: "moved", from: moved[1]!, to: moved[2]! };
    return trimmed === "[up to date]" ? { kind: "up_to_date" } : null;
  }
  return null;
}

async function headSha(gitCwd: string): Promise<string | null> {
  try {
    const sha = (await runGit(["rev-parse", "HEAD"], { cwd: gitCwd })).stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Push — 현재 브랜치를 자기 upstream(없으면 기본 원격에 -u)으로만 민다.
 * 강제 푸시·refspec 재지정은 이 표면에 존재하지 않는다.
 */
export async function handleRepositoryPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  const remoteCtx = await resolveRemoteContext(req, res, ctx);
  if (!remoteCtx) return;
  const { gitCwd, branch } = remoteCtx;
  try {
    const upstreamRemote = (await runGit(["config", "--get", `branch.${branch}.remote`], { cwd: gitCwd, allowExitCodes: [1] })).stdout.trim();
    const remote = upstreamRemote && upstreamRemote !== "." ? upstreamRemote : await resolveDefaultRemote(gitCwd);
    if (!remote) throw new NoRemoteError();
    const credentialArgs = await resolveCredentialHelperArgs(gitCwd);
    const pushed = await runGit([
      ...NETWORK_HARDENING_ARGS,
      ...credentialArgs,
      "push",
      "--porcelain",
      // repo config의 remote.<name>.receivepack이 로컬 transport에서 명령 실행되므로 표준 명령을 강제한다.
      "--receive-pack=git-receive-pack",
      "--no-recurse-submodules",
      ...(upstreamRemote ? [] : ["--set-upstream"]),
      remote,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ], { cwd: gitCwd, timeoutMs: REMOTE_TIMEOUT_MS });
    const outcome = parsePushOutcome(pushed.stdout, branch);
    // `[up to date]`는 이동이 없었다는 확정이므로 0으로 답하고, 새 브랜치·해석 불가만 null로 물러난다.
    const sent = outcome === null ? null
      : outcome.kind === "up_to_date" ? 0
      : await countCommits(gitCwd, `${outcome.from}..${outcome.to}`);
    ctx.host.http.writeJson(res, 200, { ok: true, remote, branch, ...(sent === null ? {} : { sent }) });
  } catch (error) {
    writeRemoteFailure(res, ctx, error, classifyPushError);
  }
}

/**
 * Pull — fast-forward만 허용한다. 서버가 병합·리베이스를 대신 결정하지 않는다:
 * 갈라진 히스토리는 사람이(또는 에이전트가) 터미널에서 푸는 것이 이 패널의 계약이다.
 */
export async function handleRepositoryPull(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  const remoteCtx = await resolveRemoteContext(req, res, ctx);
  if (!remoteCtx) return;
  const { gitCwd, branch } = remoteCtx;
  try {
    const upstreamRemote = (await runGit(["config", "--get", `branch.${branch}.remote`], { cwd: gitCwd, allowExitCodes: [1] })).stdout.trim();
    if (!upstreamRemote || upstreamRemote === ".") { ctx.host.http.writeJson(res, 422, { error: "no_upstream" }); return; }
    const credentialArgs = await resolveCredentialHelperArgs(gitCwd);
    const before = await headSha(gitCwd);
    await runGit([
      ...NETWORK_HARDENING_ARGS,
      ...credentialArgs,
      "pull",
      "--ff-only",
      "--no-rebase",
      "--upload-pack=git-upload-pack",
      "--no-recurse-submodules",
    ], { cwd: gitCwd, timeoutMs: REMOTE_TIMEOUT_MS });
    const received = before === null ? null : await countCommits(gitCwd, `${before}..HEAD`);
    ctx.host.http.writeJson(res, 200, { ok: true, remote: upstreamRemote, branch, ...(received === null ? {} : { received }) });
  } catch (error) {
    writeRemoteFailure(res, ctx, error, classifyPullError);
  }
}
