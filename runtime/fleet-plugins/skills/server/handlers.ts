import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { type CliExecutor, defaultCwd, stripAnsi } from "./cli.js";
import { appendChunk, createJob, finishJob, getJobResult } from "./jobs.js";
import { readSkillDescription } from "./frontmatter.js";
import { buildSkillDisplayPath, inspectSkillPackage, readSkillPackageFile } from "./package-files.js";
import { ProjectPathError, resolveProjectCwd } from "./project-path.js";
import { searchRegistry } from "./registry-search.js";
import type { AgentId, Scope, SkillListItem } from "./skill-types.js";
import { isPlainObject, validateAgent, validateScope, validateSkill, validateSource } from "./validation.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface LockFileEntry {
  source?: string;
}

/** v1은 이름을 최상위 키로 두고, v3는 `skills` 아래로 한 겹 넣는다. */
type LockFile = Record<string, LockFileEntry | unknown> & { skills?: Record<string, LockFileEntry> };

interface LockLookup {
  readonly sources: Map<string, string>;
  /** lock을 실제로 읽어냈는가 — 읽지 못했다면 출처의 부재는 "모름"이지 "로컬"이 아니다. */
  readonly lockRead: boolean;
}

interface RawSkillEntry {
  name: string;
  path: string;
  scope: string;
  agents: string[];
}

interface JobOutputRedactionPaths {
  readonly cwd: string;
  readonly homeDir: string;
  readonly pluginDataDir: string;
}

// ─── constants ───────────────────────────────────────────────────────────────

const ALL_AGENTS: AgentId[] = ["claude-code", "codex", "cursor", "opencode"];
const PREVIEW_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 120_000;
const USERINFO_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@[^\s]+/gi;
const TOKEN_URL_PARAM_RE = /([?&](?:access_?token|token|api_?key|apikey|auth(?:orization)?|password|secret|credential)=)[^&#\s]*/gi;
const installedSkillsByTheater = new Map<string, readonly SkillListItem[]>();

// ─── helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  // 배열도 typeof "object"다 — 그 한 글자를 빠뜨리면 `skills: []`가 "읽어낸 빈 lock"으로
  // 통과하고, 모든 스킬이 다시 관리 밖(=로컬)으로 단언된다.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSourceEntry(table: Record<string, unknown>): boolean {
  return Object.values(table).some((entry) => isRecord(entry) && typeof entry["source"] === "string");
}

/**
 * 이 JSON을 lock으로 인정할 수 있는가.
 *
 * 스키마가 두 벌이다: v1은 이름이 최상위 키였고, v3부터는 `skills` 아래로 한 겹 들어간다.
 * v1 모양만 읽으면 v3 파일에서 아무것도 못 건져 **모든 스킬이 출처 없음으로 보인다** —
 * 실측에서 18개 전부 source:null이던 원인이 provenance의 부재가 아니라 이 불일치였다.
 * 모르는 모양은 "빈 lock"이 아니라 "읽지 못함"으로 떨어뜨린다(다음 스키마 변경 대비).
 *
 * 두 벌의 판정 기준이 다른 것은 의도다: v3는 `skills` 키로 표를 스스로 선언하므로 그 표가
 * 레코드이기만 하면 비어 있어도 "읽어낸 빈 lock"이다. v1은 선언이 없어 내용으로 추론할
 * 수밖에 없으므로, 우리가 실제로 소비하는 것(문자열 `source`를 든 항목)이 하나라도 있어야
 * lock으로 인정한다.
 */
function isLockShape(parsed: unknown): parsed is LockFile {
  if (!isRecord(parsed)) return false;
  if ("skills" in parsed) return isRecord(parsed["skills"]);
  return hasSourceEntry(parsed);
}

function collectLockSources(lock: LockFile, sources: Map<string, string>): void {
  const table = isRecord(lock.skills) ? lock.skills : (lock as Record<string, unknown>);
  for (const [name, entry] of Object.entries(table)) {
    if (isRecord(entry) && typeof entry["source"] === "string") {
      sources.set(name, entry["source"]);
    }
  }
}

/**
 * lock을 읽었는지와 그 안에 무엇이 있었는지를 함께 돌려준다.
 *
 * 두 가지는 다른 사실이다: **읽었는데 그 스킬이 없다**(관리 밖 = 손으로 놓인 파일)와
 * **읽지 못했다**(부재·손상·모르는 스키마). 앞의 것만 "local"이라고 말할 수 있다.
 * 이 구분을 잃으면, 내일 lock 스키마가 한 번 더 바뀌는 순간 레지스트리에서 설치한
 * 스킬까지 전부 "직접 작성"이라고 자신 있게 거짓말하게 된다.
 */
async function readSkillSources(cwd: string): Promise<LockLookup> {
  const sources = new Map<string, string>();

  for (const candidate of [
    path.join(cwd, "skills-lock.json"),
    path.join(cwd, ".agents", ".skill-lock.json"),
  ]) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, "utf-8");
    } catch {
      continue; // 부재 → 다음 후보
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      // 파싱된 lock은 항목이 하나도 없어도 "읽은" 것이다 — 빈 lock은 모름이 아니라 비어 있음이다.
      if (isLockShape(parsed)) {
        collectLockSources(parsed, sources);
        return { sources, lockRead: true };
      }
    } catch {
      // 손상/모르는 스키마 → 읽지 못한 것으로 남긴다
    }
  }

  return { sources, lockRead: false };
}

async function runListCommand(args: string[], cwd: string, executor: CliExecutor): Promise<RawSkillEntry[]> {
  const result = await executor(args, { cwd, timeout: CLI_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error("list_failed");
  const text = stripAnsi(result.stdout).trim();
  if (!text) throw new Error("list_failed");
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error("list_failed");
  return parsed as RawSkillEntry[];
}

async function resolveProjectScopeCwd(
  ctx: FleetPluginServerContext,
  theaterId: string | undefined,
): Promise<string | null> {
  if (!theaterId) return null;
  const theaterRoot = ctx.host.paths.resolveTheaterPath(theaterId);
  return theaterRoot ? resolveProjectCwd(theaterRoot) : null;
}

function writeProjectPathError(
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  error: unknown,
): void {
  if (!(error instanceof ProjectPathError)) throw error;
  const status = error.code === "path_outside_theater" ? 403 : error.code === "not_found" ? 404 : 400;
  ctx.host.http.writeJson(res, status, { error: error.code });
}

export function extractSkillMarkdown(raw: string): string {
  const text = stripAnsi(raw);
  const openTag = "<SKILL.md>";
  const closeTag = "</SKILL.md>";
  const start = text.indexOf(openTag);
  const end = text.indexOf(closeTag);
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start + openTag.length, end).trim();
  }
  return text.trim();
}

export function redactJobOutput(chunk: string, paths: JobOutputRedactionPaths): string {
  let redacted = chunk
    .replace(USERINFO_URL_RE, "[redacted credential URL]")
    .replace(TOKEN_URL_PARAM_RE, "$1[redacted]");
  const sensitivePaths = [...new Set([paths.cwd, paths.homeDir, paths.pluginDataDir])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const sensitivePath of sensitivePaths) {
    redacted = redacted.replaceAll(sensitivePath, "[redacted path]");
  }
  return redacted;
}

function getJobOutputRedactionPaths(ctx: FleetPluginServerContext, cwd: string): JobOutputRedactionPaths {
  return {
    cwd,
    homeDir: os.homedir(),
    pluginDataDir: ctx.host.paths.pluginDataDir("skills"),
  };
}

function spawnJobAsync(
  jobId: string,
  args: string[],
  cwd: string,
  redactionPaths: JobOutputRedactionPaths,
  executor: CliExecutor,
): void {
  setImmediate(() => {
    void executor(args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      onChunk: (chunk) => appendChunk(jobId, redactJobOutput(chunk, redactionPaths)),
      onBootstrap: (line) => appendChunk(jobId, redactJobOutput(line + "\n", redactionPaths)),
    })
      .then((result) => finishJob(jobId, result.exitCode))
      .catch(() => finishJob(jobId, 1));
  });
}

// ─── handlers ────────────────────────────────────────────────────────────────

/**
 * CLI가 보고한 entry.path는 DTO로 나가지 않지만, 여기서 버리지도 않는다 — 카드가 이름 말고
 * 아무것도 말하지 못하던 이유가 그 경로를 버린 것이었다. 경로는 서버 안에 남아 SKILL.md
 * frontmatter의 description 한 줄이 되고, 절대 경로 자체는 응답에 실리지 않는다.
 */
async function toListItems(
  raw: readonly RawSkillEntry[],
  scope: Scope,
  lock: LockLookup,
  allowedRoot: string,
): Promise<SkillListItem[]> {
  return Promise.all(raw.map(async (entry) => {
    const [description, displayPath] = entry.path
      ? await Promise.all([
          readSkillDescription(entry.path, allowedRoot),
          buildSkillDisplayPath(entry.path, allowedRoot, scope),
        ])
      : [undefined, undefined];
    const source = lock.sources.get(entry.name);
    // lock을 읽었는데 이 스킬이 없을 때만 "관리 밖"이라고 단언할 수 있다.
    const unmanaged = !source && lock.lockRead;
    return {
      name: entry.name,
      scope,
      agents: entry.agents,
      ...(source ? { source } : {}),
      ...(unmanaged ? { unmanaged: true } : {}),
      ...(description ? { description } : {}),
      displayPath: displayPath ?? (scope === "global" ? `~/${entry.name}` : entry.name),
    };
  }));
}

async function listInstalledSkills(projectCwd: string | null, executor: CliExecutor): Promise<SkillListItem[]> {
  const homeDir = os.homedir();
  if (projectCwd) {
    const [projectRaw, globalRaw, projectSources, globalSources] = await Promise.all([
      runListCommand(["list", "--json"], projectCwd, executor),
      runListCommand(["list", "-g", "--json"], homeDir, executor),
      readSkillSources(projectCwd),
      readSkillSources(homeDir),
    ]);
    const [projectItems, globalItems] = await Promise.all([
      toListItems(projectRaw, "project", projectSources, projectCwd),
      toListItems(globalRaw, "global", globalSources, homeDir),
    ]);
    return [...projectItems, ...globalItems];
  }
  const [globalRaw, globalSources] = await Promise.all([
    runListCommand(["list", "-g", "--json"], homeDir, executor),
    readSkillSources(homeDir),
  ]);
  return toListItems(globalRaw, "global", globalSources, homeDir);
}

export async function handleList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.searchParams.has("relPath")) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  const theaterId = url.searchParams.get("theaterId") ?? undefined;
  let projectCwd: string | null = null;

  if (theaterId) {
    try {
      projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
    } catch (error) {
      writeProjectPathError(res, ctx, error);
      return;
    }
    if (!projectCwd) {
      ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
      return;
    }
  }

  try {
    const skills = await listInstalledSkills(projectCwd, executor);
    if (theaterId) installedSkillsByTheater.set(theaterId, skills);
    ctx.host.http.writeJson(res, 200, { skills });
  } catch {
    if (theaterId) installedSkillsByTheater.delete(theaterId);
    ctx.host.http.writeJson(res, 502, { error: "list_failed" });
  }
}

export async function handlePaletteSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly query?: unknown;
    readonly limit?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.query !== "string"
    || body.query.trim() === ""
    || !Number.isInteger(body.limit)
    || (body.limit as number) < 1
    || (body.limit as number) > 8
    || "relPath" in body
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  let projectCwd: string | null;
  try {
    projectCwd = await resolveProjectScopeCwd(ctx, body.theaterId);
  } catch (error) {
    writeProjectPathError(res, ctx, error);
    return;
  }
  if (!projectCwd) {
    ctx.host.http.writeJson(res, 404, { error: "theater_not_found" });
    return;
  }
  let installedSkills = installedSkillsByTheater.get(body.theaterId);
  if (!installedSkills) {
    try {
      installedSkills = await listInstalledSkills(projectCwd, executor);
      installedSkillsByTheater.set(body.theaterId, installedSkills);
    } catch {
      ctx.host.http.writeJson(res, 502, { error: "list_failed" });
      return;
    }
  }
  const tokens = body.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const skills = installedSkills
    .filter((skill) => {
      const haystack = `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase();
      return tokens.every((token) => haystack.includes(token));
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope))
    .slice(0, body.limit as number)
    .map(({ name, scope }) => ({ name, scope }));
  ctx.host.http.writeJson(res, 200, { skills });
}

export async function handleSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.searchParams.has("relPath")) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "10", 10);
  const limit = isNaN(rawLimit) ? 10 : rawLimit;

  if (q.length < 2) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  try {
    const skills = await searchRegistry(q, limit);
    ctx.host.http.writeJson(res, 200, { skills });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "registry_unreachable" });
  }
}

export async function handleInstall(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { source, skill, scope, agents, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateSource(source)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!Array.isArray(agents) || agents.length === 0) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  for (const agent of agents) {
    if (!validateAgent(agent)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  }

  let projectCwd: string | null = null;
  if (scope === "project") {
    try {
      projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
    } catch (error) {
      writeProjectPathError(res, ctx, error);
      return;
    }
  }
  const cwd = scope === "global" ? defaultCwd() : projectCwd;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const jobId = createJob(scope, theaterId ?? "__global__");
  if (!jobId) { ctx.host.http.writeJson(res, 409, { error: "job_in_progress" }); return; }

  const agentArgs = (agents as AgentId[]).flatMap((a) => ["--agent", a]);
  // F4: project 스코프는 플래그 생략(add 기본=project), global만 -g
  const scopeFlag = scope === "global" ? ["-g"] : [];
  const args = ["add", source, "-y", "--skill", skill, ...scopeFlag, ...agentArgs];

  spawnJobAsync(jobId, args, cwd, getJobOutputRedactionPaths(ctx, cwd), executor);

  ctx.host.http.writeJson(res, 202, { jobId });
}

export async function handleUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { scope, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  let projectCwd: string | null = null;
  if (scope === "project") {
    try {
      projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
    } catch (error) {
      writeProjectPathError(res, ctx, error);
      return;
    }
  }
  const cwd = scope === "global" ? defaultCwd() : projectCwd;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const jobId = createJob(scope, theaterId ?? "__global__");
  if (!jobId) { ctx.host.http.writeJson(res, 409, { error: "job_in_progress" }); return; }

  const scopeFlag = scope === "global" ? "-g" : "-p";
  const args = ["update", "-y", scopeFlag];

  spawnJobAsync(jobId, args, cwd, getJobOutputRedactionPaths(ctx, cwd), executor);

  ctx.host.http.writeJson(res, 202, { jobId });
}

export async function handleGetJob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.searchParams.has("relPath")) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  const jobId = url.searchParams.get("jobId");
  const rawCursor = parseInt(url.searchParams.get("cursor") ?? "0", 10);
  const cursor = isNaN(rawCursor) || rawCursor < 0 ? 0 : rawCursor;

  if (!jobId) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const result = getJobResult(jobId, cursor);
  if (!result) { ctx.host.http.writeJson(res, 404, { error: "job_not_found" }); return; }

  ctx.host.http.writeJson(res, 200, result);
}

export async function handleRemove(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { scope, skill, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  let projectCwd: string | null = null;
  if (scope === "project") {
    try {
      projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
    } catch (error) {
      writeProjectPathError(res, ctx, error);
      return;
    }
  }
  const cwd = scope === "global" ? defaultCwd() : projectCwd;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    // `-a "*"`는 CLI가 리터럴 agent 이름으로 검증해 거부한다(help의 '*'는 셸 표기).
    // agent 플래그를 생략하면 비-TTY에서 모든 설치 표면(universal+심링크)이 제거된다 — 실측 확정.
    const result = await executor(["remove", "-s", skill, "-y"], { cwd, timeout: CLI_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      // CLI stdout에는 홈/작업 디렉터리 절대경로가 섞일 수 있어 브라우저로 내보내지 않는다(Token Boundary).
      ctx.host.http.writeJson(res, 502, { error: "remove_failed" });
      return;
    }
    ctx.host.http.writeJson(res, 200, { ok: true });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "remove_failed" });
  }
}

export async function handlePreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { source, skill, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;
  if (!validateSource(source)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  let cwd = defaultCwd();
  if (theaterId) {
    try {
      const projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
      if (!projectCwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
      cwd = projectCwd;
    } catch (error) {
      writeProjectPathError(res, ctx, error);
      return;
    }
  }

  try {
    // F3: use stdout는 <SKILL.md>...</SKILL.md> 래퍼 포함 → 태그 사이 본문만 추출
    const result = await executor([`use`, `${source}@${skill}`], { cwd, timeout: PREVIEW_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      ctx.host.http.writeJson(res, 502, { error: "preview_failed" });
      return;
    }
    ctx.host.http.writeJson(res, 200, { markdown: extractSkillMarkdown(result.stdout) });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "preview_failed" });
  }
}

interface InstalledSkillLocation {
  readonly cwd: string;
  readonly skillRoot: string;
}

async function resolveInstalledSkillLocation(
  scope: Scope,
  skill: string,
  theaterId: string | undefined,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<InstalledSkillLocation | null> {
  let projectCwd: string | null = null;
  if (scope === "project") projectCwd = await resolveProjectScopeCwd(ctx, theaterId);
  const cwd = scope === "global" ? defaultCwd() : projectCwd;
  if (!cwd) return null;
  const listArgs = scope === "global" ? ["list", "-g", "--json"] : ["list", "--json"];
  const rawSkills = await runListCommand(listArgs, cwd, executor);
  const entry = rawSkills.find((candidate) => candidate.name === skill && candidate.scope === scope);
  return entry?.path ? { cwd, skillRoot: entry.path } : null;
}

function writePackageReadError(res: http.ServerResponse, ctx: FleetPluginServerContext, error: unknown): void {
  const code = error instanceof Error ? error.message : "read_failed";
  if (code === "path_outside_scope" || code === "path_outside_skill") {
    ctx.host.http.writeJson(res, 403, { error: "path_outside_skill" });
    return;
  }
  if (code === "invalid_file_path") {
    ctx.host.http.writeJson(res, 400, { error: code });
    return;
  }
  if (code === "file_not_found") {
    ctx.host.http.writeJson(res, 404, { error: code });
    return;
  }
  if (code === "file_too_large" || code === "unsupported_file" || code === "symlink_not_allowed") {
    ctx.host.http.writeJson(res, 422, { error: code });
    return;
  }
  ctx.host.http.writeJson(res, 502, { error: "read_failed" });
}

export async function handleInstalledPackage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  const { scope, skill, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;
  if (!validateScope(scope) || !validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  try {
    const location = await resolveInstalledSkillLocation(scope, skill, theaterId, ctx, executor);
    if (!location) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }
    const [manifest, displayPath] = await Promise.all([
      inspectSkillPackage(location.skillRoot, location.cwd),
      buildSkillDisplayPath(location.skillRoot, location.cwd, scope),
    ]);
    if (!displayPath) { ctx.host.http.writeJson(res, 403, { error: "path_outside_skill" }); return; }
    ctx.host.http.writeJson(res, 200, { manifest, displayPath });
  } catch (error) {
    if (error instanceof ProjectPathError) { writeProjectPathError(res, ctx, error); return; }
    writePackageReadError(res, ctx, error);
  }
}

export async function handleInstalledFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body) || "relPath" in body) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  const { scope, skill, file, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;
  const relativeFile = file === undefined ? "SKILL.md" : file;
  if (!validateScope(scope) || !validateSkill(skill) || typeof relativeFile !== "string") {
    ctx.host.http.writeJson(res, 400, { error: "invalid_argument" });
    return;
  }

  try {
    const location = await resolveInstalledSkillLocation(scope, skill, theaterId, ctx, executor);
    if (!location) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }
    const result = await readSkillPackageFile(location.skillRoot, location.cwd, relativeFile);
    ctx.host.http.writeJson(res, 200, result);
  } catch (error) {
    if (error instanceof ProjectPathError) { writeProjectPathError(res, ctx, error); return; }
    writePackageReadError(res, ctx, error);
  }
}

export { ALL_AGENTS };
