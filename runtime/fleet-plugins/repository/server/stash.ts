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

export type StashAction = "save" | "apply" | "pop" | "drop" | "show";

export function readStashAction(value: unknown): StashAction | null {
  return value === "save" || value === "apply" || value === "pop" || value === "drop" || value === "show" ? value : null;
}

const STASH_SHOW_STATUS_RE = /^[A-Z]\d{0,3}$/;
const MAX_STASH_SHOW_FILES = 500;

/** `--name-status` 한 줄(`M\tpath` 또는 `R100\told\tnew`)을 카드가 그릴 상태·경로로 줄인다. */
export function parseStashShowLine(line: string): { readonly status: string; readonly path: string } | null {
  const fields = line.split("\t");
  if (fields.length < 2) return null;
  const rawStatus = fields[0]!.trim();
  if (!STASH_SHOW_STATUS_RE.test(rawStatus)) return null;
  // 리네임/복사는 스코어 접미를 벗기고, 경로는 마지막 필드(신 경로)를 취한다.
  const status = rawStatus[0]!;
  const path = fields[fields.length - 1]!;
  if (path === "") return null;
  return { status, path };
}

function classifyStashError(stderr: string): "stash_conflict" | "nothing_to_stash" | null {
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
    readonly sha?: unknown;
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
  const sha = body.sha;
  if (action !== "save" && (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha))) {
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
    // stash@{n}은 위치 주소라 동시 stash push/drop에 밀린다 — 행이 쥐고 있던 SHA와 대조해
    // 어긋나면 실행 대신 거절한다(특히 drop은 비가역이라 다른 스태시를 지울 수 있다).
    let resolved: string;
    try {
      resolved = (await runGit(["rev-parse", "--verify", `${name as string}`], { cwd: gitCwd })).stdout.trim();
    } catch (error) {
      if (error instanceof GitExecutorError && error.code === "non_zero_exit") {
        // 그 위치의 스태시가 이미 사라진 경우 — 없는 대상 실행보다 이동 거절이 정확하다.
        ctx.host.http.writeJson(res, 409, { error: "stash_moved" });
        return;
      }
      throw error;
    }
    if (!resolved.toLowerCase().startsWith((sha as string).toLowerCase())) {
      ctx.host.http.writeJson(res, 409, { error: "stash_moved" });
      return;
    }
    if (action === "show") {
      // 카드는 "치워 둔 것"을 보여 준다 — untracked만 담긴 스태시가 부모 diff로는 0개 파일로
      // 보이는 함정이 이 액션의 존재 이유이므로, --include-untracked가 빠지면 안 된다.
      const shown = await runGit([
        ...STASH_HARDENING_ARGS,
        "stash", "show", "--include-untracked", "--name-status", name as string,
      ], { cwd: gitCwd });
      const files = shown.stdout.split("\n")
        .map(parseStashShowLine)
        .filter((entry): entry is { status: string; path: string } => entry !== null);
      ctx.host.http.writeJson(res, 200, {
        files: files.slice(0, MAX_STASH_SHOW_FILES),
        ...(files.length > MAX_STASH_SHOW_FILES ? { truncated: true } : {}),
      });
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
