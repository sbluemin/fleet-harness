import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { type CliExecutor, defaultCwd, stripAnsi } from "./cli.js";
import { appendChunk, createJob, finishJob, getJobResult } from "./jobs.js";
import { searchRegistry } from "./registry-search.js";
import type { AgentId, Scope } from "./types.js";
import { isPlainObject, validateAgent, validateScope, validateSkill, validateSource } from "./validation.js";

// ─── types ───────────────────────────────────────────────────────────────────

interface LockFileEntry {
  source?: string;
}

type LockFileV1 = Record<string, LockFileEntry>;

interface RawSkillEntry {
  name: string;
  path: string;
  scope: string;
  agents: string[];
}

// ─── constants ───────────────────────────────────────────────────────────────

const ALL_AGENTS: AgentId[] = ["claude-code", "codex", "cursor", "opencode"];
const PREVIEW_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 120_000;

// ─── helpers ─────────────────────────────────────────────────────────────────

async function readSkillSources(cwd: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();

  try {
    const raw = await fs.readFile(path.join(cwd, "skills-lock.json"), "utf-8");
    const parsed = JSON.parse(raw) as LockFileV1;
    if (typeof parsed === "object" && parsed !== null) {
      for (const [name, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.source === "string") sources.set(name, entry.source);
      }
      return sources;
    }
  } catch {
    // 부재/파싱 실패 → 폴백
  }

  try {
    const raw = await fs.readFile(path.join(cwd, ".agents", ".skill-lock.json"), "utf-8");
    const parsed = JSON.parse(raw) as LockFileV1;
    if (typeof parsed === "object" && parsed !== null) {
      for (const [name, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.source === "string") sources.set(name, entry.source);
      }
    }
  } catch {
    // 부재/파싱 실패 → source 생략 (에러 아님)
  }

  return sources;
}

async function runListCommand(args: string[], cwd: string, executor: CliExecutor): Promise<RawSkillEntry[]> {
  const result = await executor(args, { cwd, timeout: CLI_TIMEOUT_MS });
  const text = stripAnsi(result.stdout).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as RawSkillEntry[];
  } catch {
    return [];
  }
}

function buildDisplayPath(scope: Scope, name: string): string {
  return scope === "global" ? `~/.agents/skills/${name}` : `.agents/skills/${name}`;
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

function spawnJobAsync(jobId: string, args: string[], cwd: string, executor: CliExecutor): void {
  setImmediate(() => {
    void executor(args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      onChunk: (chunk) => appendChunk(jobId, chunk),
      onBootstrap: (line) => appendChunk(jobId, line + "\n"),
    })
      .then((result) => finishJob(jobId, result.exitCode))
      .catch(() => finishJob(jobId, 1));
  });
}

// ─── handlers ────────────────────────────────────────────────────────────────

export async function handleList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  executor: CliExecutor,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const theaterId = url.searchParams.get("theaterId") ?? undefined;
  const theaterPath = theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null;

  try {
    if (theaterPath) {
      const [projectRaw, globalRaw, projectSources, globalSources] = await Promise.all([
        runListCommand(["list", "--json"], theaterPath, executor),
        runListCommand(["list", "-g", "--json"], os.homedir(), executor),
        readSkillSources(theaterPath),
        readSkillSources(os.homedir()),
      ]);

      const projectSkills = projectRaw.map((entry) => ({
        name: entry.name,
        scope: "project" as Scope,
        agents: entry.agents,
        source: projectSources.get(entry.name),
        displayPath: buildDisplayPath("project", entry.name),
      }));

      const globalSkills = globalRaw.map((entry) => ({
        name: entry.name,
        scope: "global" as Scope,
        agents: entry.agents,
        source: globalSources.get(entry.name),
        displayPath: buildDisplayPath("global", entry.name),
      }));

      ctx.host.http.writeJson(res, 200, { skills: [...projectSkills, ...globalSkills] });
    } else {
      const [globalRaw, globalSources] = await Promise.all([
        runListCommand(["list", "-g", "--json"], os.homedir(), executor),
        readSkillSources(os.homedir()),
      ]);

      const skills = globalRaw.map((entry) => ({
        name: entry.name,
        scope: "global" as Scope,
        agents: entry.agents,
        source: globalSources.get(entry.name),
        displayPath: buildDisplayPath("global", entry.name),
      }));

      ctx.host.http.writeJson(res, 200, { skills });
    }
  } catch {
    ctx.host.http.writeJson(res, 200, { skills: [] });
  }
}

export async function handleSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
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
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { source, skill, scope, agents, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateSource(source)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!Array.isArray(agents) || agents.length === 0) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  for (const agent of agents) {
    if (!validateAgent(agent)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  }

  const theaterPath = scope === "project" ? (theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null) : null;
  if (scope === "project" && !theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const cwd = scope === "global" ? defaultCwd() : theaterPath;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const jobId = createJob(scope, theaterId ?? "__global__");
  if (!jobId) { ctx.host.http.writeJson(res, 409, { error: "job_in_progress" }); return; }

  const agentArgs = (agents as AgentId[]).flatMap((a) => ["--agent", a]);
  // F4: project 스코프는 플래그 생략(add 기본=project), global만 -g
  const scopeFlag = scope === "global" ? ["-g"] : [];
  const args = ["add", source, "-y", "--skill", skill, ...scopeFlag, ...agentArgs];

  spawnJobAsync(jobId, args, cwd, executor);

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
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { scope, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const theaterPath = scope === "project" ? (theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null) : null;
  if (scope === "project" && !theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const cwd = scope === "global" ? defaultCwd() : theaterPath;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const jobId = createJob(scope, theaterId ?? "__global__");
  if (!jobId) { ctx.host.http.writeJson(res, 409, { error: "job_in_progress" }); return; }

  const scopeFlag = scope === "global" ? "-g" : "-p";
  const args = ["update", "-y", scopeFlag];

  spawnJobAsync(jobId, args, cwd, executor);

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
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { scope, skill, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const theaterPath = scope === "project" ? (theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null) : null;
  if (scope === "project" && !theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const cwd = scope === "global" ? defaultCwd() : theaterPath;
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
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { source, skill } = body;
  if (!validateSource(source)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  try {
    // F3: use stdout는 <SKILL.md>...</SKILL.md> 래퍼 포함 → 태그 사이 본문만 추출
    const result = await executor([`use`, `${source}@${skill}`], { cwd: defaultCwd(), timeout: PREVIEW_TIMEOUT_MS });
    ctx.host.http.writeJson(res, 200, { markdown: extractSkillMarkdown(result.stdout) });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "preview_failed" });
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
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { scope, skill, theaterId: rawTheaterId } = body;
  const theaterId = typeof rawTheaterId === "string" ? rawTheaterId : undefined;

  if (!validateScope(scope)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const theaterPath = scope === "project" ? (theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null) : null;
  if (scope === "project" && !theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  const cwd = scope === "global" ? defaultCwd() : theaterPath;
  if (!cwd) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }

  try {
    // F2: global scope는 -g 플래그 필수
    const listArgs = scope === "global" ? ["list", "-g", "--json"] : ["list", "--json"];
    const rawSkills = await runListCommand(listArgs, cwd, executor);
    const entry = rawSkills.find((e) => e.name === skill && e.scope === scope);
    if (!entry?.path) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }

    const skillRoot = entry.path;
    const skillMdPath = path.join(skillRoot, "SKILL.md");

    const [realAllowedRoot, realRoot, realMd] = await Promise.all([
      // CLI가 보고한 skillRoot 자체도 신뢰하지 않는다 — scope의 정당한 상위 경계
      // (project=theater 루트, global=홈)를 벗어나면 읽지 않는다. `.agents/skills`로
      // 고정하지 않는 이유: claude 단독 설치는 `.claude/skills` 아래에 놓인다.
      fs.realpath(cwd),
      fs.realpath(skillRoot),
      fs.realpath(skillMdPath).catch(() => null),
    ]);

    if (!realMd) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }
    if (realRoot !== realAllowedRoot && !realRoot.startsWith(realAllowedRoot + path.sep)) {
      ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
      return;
    }
    if (realMd !== realRoot && !realMd.startsWith(realRoot + path.sep)) {
      ctx.host.http.writeJson(res, 403, { error: "path_outside_theater" });
      return;
    }

    const markdown = await fs.readFile(realMd, "utf-8");
    ctx.host.http.writeJson(res, 200, { markdown });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "read_failed" });
  }
}

export { ALL_AGENTS };
