import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import { type CliExecutor, createDefaultExecutor, defaultCwd, stripAnsi } from "./cli.js";
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

const _defaultExecutor = createDefaultExecutor();

// ─── helpers ─────────────────────────────────────────────────────────────────

async function readSkillSources(cwd: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();

  // 1순위: skills-lock.json (v1)
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

  // 폴백: .agents/.skill-lock.json
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

async function runListCommand(cwd: string, exec: CliExecutor): Promise<RawSkillEntry[]> {
  const result = await exec(["list", "--json"], { cwd, timeout: CLI_TIMEOUT_MS });
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

function spawnJobAsync(
  jobId: string,
  args: string[],
  cwd: string,
  exec: CliExecutor,
): void {
  setImmediate(() => {
    void exec(args, {
      cwd,
      timeout: CLI_TIMEOUT_MS,
      onChunk: (chunk) => appendChunk(jobId, chunk),
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
  exec: CliExecutor = _defaultExecutor,
): Promise<void> {
  if (req.method !== "GET") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const theaterId = url.searchParams.get("theaterId") ?? undefined;
  const theaterPath = theaterId ? ctx.host.paths.resolveTheaterPath(theaterId) : null;

  const listCwd = theaterPath ?? defaultCwd();

  try {
    const [rawSkills, projectSources, globalSources] = await Promise.all([
      runListCommand(listCwd, exec),
      theaterPath ? readSkillSources(theaterPath) : Promise.resolve(new Map<string, string>()),
      readSkillSources(os.homedir()),
    ]);

    const skills = rawSkills.map((entry) => {
      const scope: Scope = entry.scope === "global" ? "global" : "project";
      const sourceMap = scope === "global" ? globalSources : projectSources;
      return {
        name: entry.name,
        scope,
        agents: entry.agents,
        source: sourceMap.get(entry.name),
        displayPath: buildDisplayPath(scope, entry.name),
      };
    });

    ctx.host.http.writeJson(res, 200, { skills });
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
  exec: CliExecutor = _defaultExecutor,
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
  const scopeFlag = scope === "global" ? ["-g"] : ["-p"];
  const args = ["add", source, "-y", "--skill", skill, ...scopeFlag, ...agentArgs];

  spawnJobAsync(jobId, args, cwd, exec);

  ctx.host.http.writeJson(res, 202, { jobId });
}

export async function handleUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  exec: CliExecutor = _defaultExecutor,
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

  spawnJobAsync(jobId, args, cwd, exec);

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
  exec: CliExecutor = _defaultExecutor,
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
    const result = await exec(["remove", "-s", skill, "-a", "*", "-y"], { cwd, timeout: CLI_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      const detail = stripAnsi(result.stdout).trim().slice(0, 500);
      ctx.host.http.writeJson(res, 502, { error: "remove_failed", detail });
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
  exec: CliExecutor = _defaultExecutor,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }

  const body = await ctx.host.http.readJsonBody<Record<string, unknown>>(req);
  if (!isPlainObject(body)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  const { source, skill } = body;
  if (!validateSource(source)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }
  if (!validateSkill(skill)) { ctx.host.http.writeJson(res, 400, { error: "invalid_argument" }); return; }

  try {
    const result = await exec([`use`, `${source}@${skill}`], { cwd: defaultCwd(), timeout: PREVIEW_TIMEOUT_MS });
    ctx.host.http.writeJson(res, 200, { markdown: stripAnsi(result.stdout) });
  } catch {
    ctx.host.http.writeJson(res, 502, { error: "preview_failed" });
  }
}

export async function handleInstalledFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
  exec: CliExecutor = _defaultExecutor,
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
    const rawSkills = await runListCommand(cwd, exec);
    const entry = rawSkills.find((e) => e.name === skill && e.scope === scope);
    if (!entry?.path) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }

    const skillRoot = entry.path;
    const skillMdPath = path.join(skillRoot, "SKILL.md");

    const [realRoot, realMd] = await Promise.all([
      fs.realpath(skillRoot),
      fs.realpath(skillMdPath).catch(() => null),
    ]);

    if (!realMd) { ctx.host.http.writeJson(res, 404, { error: "skill_not_found" }); return; }
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
