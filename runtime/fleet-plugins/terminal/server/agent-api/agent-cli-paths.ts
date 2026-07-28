import fs from "node:fs";
import path from "node:path";

import { resolvePathBinary, type AgentCliLaunchResolver, type ResolvedBinary } from "@dotobokuri/core-agent";
import type { FleetPluginStorageHost } from "@fleet-console/sdk/plugin";

export const AGENT_CLI_PATHS_STORAGE_KEY = "agent-cli-paths";
export const AGENT_CLI_COMMANDS = ["claude", "codex", "opencode", "cursor-agent"] as const;

export type AgentCliPathError =
  | "path_not_absolute"
  | "path_not_found"
  | "path_not_executable"
  | "path_not_file"
  | "probe_failed";

export interface AgentCliPathsData {
  readonly version: 1;
  readonly paths: Readonly<Record<string, string>>;
}

export interface AgentCliBinaryResolution {
  readonly resolved: ResolvedBinary | undefined;
  readonly source: "env" | "user" | "path" | null;
  readonly error: Exclude<AgentCliPathError, "probe_failed"> | null;
  readonly launchPath: string | undefined;
  readonly searchedPathEntries: readonly string[];
}

const OVERRIDE_ENV_BY_COMMAND: Readonly<Record<string, string>> = {
  claude: "CLAUDE_BIN",
  codex: "CODEX_BIN",
  "cursor-agent": "CURSOR_AGENT_BIN",
};

// 같은 서버 프로세스의 이 모듈 인스턴스에서 `agent-cli-paths` read+write만 직렬화한다.
// host/plugin 번들 경계를 넘는 상태 조율은 하지 않는다 — 그 경계는 doctrine상 모듈 singleton으로 묶지 않는다.
let agentCliPathsWriteTail: Promise<void> = Promise.resolve();

export function createAgentCliPathStore(storage: FleetPluginStorageHost, pluginId: string) {
  return {
    read: async (): Promise<AgentCliPathsData> => normalizeAgentCliPaths(
      await storage.readJson(pluginId, AGENT_CLI_PATHS_STORAGE_KEY),
    ),
    writePath: (cliCommand: string, executablePath: string | null): Promise<AgentCliPathsData> => serializeAgentCliPathsWrite(async () => {
      const current = normalizeAgentCliPaths(await storage.readJson(pluginId, AGENT_CLI_PATHS_STORAGE_KEY));
      const paths = { ...current.paths };
      const normalized = executablePath ?? "";
      if (normalized.length === 0) delete paths[cliCommand];
      else paths[cliCommand] = normalized;
      const next = { version: 1, paths } as const;
      await storage.writeJson(pluginId, AGENT_CLI_PATHS_STORAGE_KEY, next);
      return next;
    }),
  };
}

function serializeAgentCliPathsWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = agentCliPathsWriteTail.then(write);
  agentCliPathsWriteTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function normalizeAgentCliPaths(value: unknown): AgentCliPathsData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.paths)) {
    return { version: 1, paths: {} };
  }
  const paths: Record<string, string> = {};
  for (const command of AGENT_CLI_COMMANDS) {
    const candidate = value.paths[command];
    if (typeof candidate === "string" && candidate.length > 0) paths[command] = candidate;
  }
  return { version: 1, paths };
}

// 감지와 런치가 공유하는 되돌리기 어려운 우선순위 계약이다:
// env override → 사용자 지정 경로 → PATH 탐색. 설정된 상위 소스가 실패해도 하위 소스로 폴백하지 않는다.
export function resolveAgentCliBinary(options: {
  readonly cliCommand: string;
  readonly env: NodeJS.ProcessEnv;
  readonly userPaths: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}): AgentCliBinaryResolution {
  const platform = options.platform ?? process.platform;
  const envName = OVERRIDE_ENV_BY_COMMAND[options.cliCommand];
  const envOverride = envName ? options.env[envName]?.trim() : undefined;
  if (envOverride) {
    const searchedPathEntries = path.isAbsolute(envOverride) ? [] : readPathEntries(options.env, platform);
    const resolved = resolvePathBinary(envOverride, options.env, { platform });
    if (!resolved) {
      return { resolved: undefined, source: "env", error: "path_not_found", launchPath: envOverride, searchedPathEntries };
    }
    const error = validateResolvedFile(resolved, platform);
    return { resolved: error ? undefined : resolved, source: "env", error, launchPath: envOverride, searchedPathEntries };
  }

  const userPath = options.userPaths[options.cliCommand];
  if (userPath) {
    const checked = resolveConfiguredPath(userPath, options.env, platform);
    return { ...checked, source: "user", launchPath: userPath, searchedPathEntries: [] };
  }

  const searchedPathEntries = readPathEntries(options.env, platform);
  const resolved = resolvePathBinary(options.cliCommand, options.env, { platform });
  if (!resolved) return { resolved: undefined, source: null, error: null, launchPath: undefined, searchedPathEntries };
  const error = validateResolvedFile(resolved, platform);
  return {
    resolved: error ? undefined : resolved,
    source: error ? null : "path",
    error,
    launchPath: undefined,
    searchedPathEntries,
  };
}

export function validateUserAgentCliPath(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AgentCliBinaryResolution {
  const checked = resolveConfiguredPath(executablePath, env, platform);
  return { ...checked, source: "user", launchPath: executablePath, searchedPathEntries: [] };
}

export function agentCliCommandForId(cliId: string | undefined): string | null {
  if (cliId === "claude" || cliId === "claude-kimi") return "claude";
  if (cliId === "codex") return "codex";
  if (cliId === "opencode-go") return "opencode";
  if (cliId === "cursor") return "cursor-agent";
  return null;
}

export function applyAgentCliPathEnvOverlay(
  env: NodeJS.ProcessEnv,
  cliId: string | undefined,
  userPaths: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const cliCommand = agentCliCommandForId(cliId);
  if (!cliCommand) return env;
  const envName = OVERRIDE_ENV_BY_COMMAND[cliCommand];
  const userPath = userPaths[cliCommand];
  if (!envName || !userPath || (env[envName]?.trim().length ?? 0) > 0) return env;
  return { ...env, [envName]: userPath };
}

export function createCarrierAgentCliLaunchResolver(
  readAgentCliPaths: () => Promise<Readonly<Record<string, string>>>,
  baseEnv: NodeJS.ProcessEnv = process.env,
): AgentCliLaunchResolver {
  return async (cliId, context) => {
    const userPaths = await readAgentCliPaths();
    const cliCommand = agentCliCommandForId(cliId);
    if (!cliCommand) throw new Error("agent_cli_unavailable");
    const effectiveEnv = { ...baseEnv, ...context.env };
    const resolution = resolveAgentCliBinary({ cliCommand, env: effectiveEnv, userPaths });
    if (!resolution.resolved) throw new Error("agent_cli_unavailable");

    // Carrier auth env는 core-agent가 따로 병합한다. 여기서는 사용자 경로 때문에 새로 생긴
    // override만 돌려 기존 env 우선순위를 보존하고, OpenCode/Cursor는 cliPath로 직접 넘긴다.
    const overlaidEnv = applyAgentCliPathEnvOverlay(effectiveEnv, cliId, userPaths);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(overlaidEnv)) {
      if (value !== undefined && effectiveEnv[name] !== value) env[name] = value;
    }
    return {
      cliPath: resolution.launchPath,
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  };
}

function resolveConfiguredPath(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Pick<AgentCliBinaryResolution, "resolved" | "error"> {
  if (executablePath.includes("\0") || executablePath.startsWith("~") || !path.isAbsolute(executablePath)) {
    return { resolved: undefined, error: "path_not_absolute" };
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(executablePath);
  } catch {
    return { resolved: undefined, error: "path_not_found" };
  }
  if (!stats.isFile()) return { resolved: undefined, error: "path_not_file" };
  if (platform !== "win32") {
    try {
      fs.accessSync(executablePath, fs.constants.X_OK);
    } catch {
      return { resolved: undefined, error: "path_not_executable" };
    }
  }
  const resolved = resolvePathBinary(executablePath, env, { platform });
  return resolved
    ? { resolved, error: null }
    : { resolved: undefined, error: "path_not_executable" };
}

function validateResolvedFile(resolved: ResolvedBinary, platform: NodeJS.Platform): Exclude<AgentCliPathError, "probe_failed"> | null {
  // Windows shim은 실행 bin이 cmd.exe이므로 일반 파일 검사는 call 대상 `.cmd`/`.bat`에 적용한다.
  const resolvedPath = platform === "win32" && resolved.prefixArgs[3] === "call"
    ? resolved.prefixArgs[4]?.trim() ?? resolved.bin
    : resolved.bin;
  try {
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) return "path_not_file";
    if (platform !== "win32") fs.accessSync(resolvedPath, fs.constants.X_OK);
    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "EACCES") return "path_not_executable";
    return "path_not_found";
  }
}

function readPathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  const value = platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
  const separator = platform === "win32" ? ";" : path.delimiter;
  return value.split(separator).filter((entry) => entry.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
