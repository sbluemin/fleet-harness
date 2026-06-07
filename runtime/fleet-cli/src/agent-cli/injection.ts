import crypto from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExecutorSessionManager } from "@dotobokuri/core-mcp-server";
import {
  buildClaudeSubagentDefinitions,
  getCarrierConfig,
  getEnabledCarrierSubagentIds,
  getRegisteredOrder,
  readCarrierAgentModeSnapshot,
  resolveAgentCliType,
  type CarrierConfig,
  type CarrierModelDefaults,
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
} from "@dotobokuri/fleet-carriers";

import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { escapeTomlBasicString, escapeTomlMultilineString } from "./builders/toml.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import { CODEX_FLEET_PLUGIN_KEY, createAgentCliPlugin, ensureCodexPluginRegistered } from "./plugin/index.js";
import type { CodexCommandResult, CodexPluginRegistrationCommand, FleetHookExec } from "./plugin/types.js";
import type { AgentCliInjectionContext, AgentCliMcpServerArg, AgentCliProfile } from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean) => string;
  readonly carrierRuntime: CarrierRuntime;
  readonly dedicatedMcpSession: ExecutorSessionManager;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly codexCommandRunner?: (command: CodexPluginRegistrationCommand) => CodexCommandResult;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly pluginAssetsDir?: string;
  readonly pluginEntry?: FleetHookCommandEntry;
  readonly pluginRootDir?: string;
}

export interface FleetHookCommandEntry {
  readonly entryPath: string;
  readonly execPath: string;
  readonly tsxLoaderPath?: string;
}

interface CodexFleetProfile {
  readonly profileName: string;
  readonly profilePath: string;
}

type StartupNativeDefinitions =
  | { readonly host: "claude"; readonly definitions: ClaudeSubagentDefinition[] }
  | { readonly host: "none"; readonly definitions: [] };

const CODEX_FLEET_PROFILE_FILE_NAME_PATTERN = /^fleet-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.config\.toml$/;
const CODEX_FLEET_PROFILE_MARKER = "# Fleet-managed Codex session profile";
const CODEX_STALE_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SYSTEM_PROMPT_FILE_MODE = 0o600;
const JAVASCRIPT_ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const TYPESCRIPT_ENTRY_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

export async function injectAgentCliProfile(
  profile: AgentCliProfile,
  options: InjectAgentCliProfileOptions,
): Promise<AgentCliProfile> {
  const capability = getAgentCliInjectionCapability(profile.id);
  if (!capability.enabled) {
    return profile;
  }

  const injectTone = options.enableMetaphor ?? false;
  const endpoint = await options.dedicatedMcpSession.getEndpoint();
  const startupDefinitions = buildStartupNativeDefinitions(profile.id, options.carrierRuntime);
  const tokenLabel = `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = options.dedicatedMcpSession.issueSessionToken({ cwd: profile.cwd, label: tokenLabel });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  const doctrine = options.buildSystemPrompt(injectTone);
  const tempCleanups: Array<() => void> = [];
  try {
    const systemPromptFile = profile.id === "claude" || profile.id === "claude-kimi"
      ? writeSystemPromptFile(profile.id, doctrine, (cleanup) => tempCleanups.push(cleanup))
      : undefined;
    const codexProfile = profile.id === "codex"
      ? writeCodexFleetProfile(profile.env, doctrine, (cleanup) => tempCleanups.push(cleanup))
      : undefined;
    const plugin = createAgentCliPlugin({
      claudeDefinitions: startupDefinitions.host === "claude" ? startupDefinitions.definitions : [],
      cliId: profile.id,
      cwd: profile.cwd,
      rootDir: options.pluginRootDir,
      assetsDir: options.pluginAssetsDir,
      hookExec: startupDefinitions.host === "claude"
        ? buildFleetHookCommand(options.pluginEntry)
        : undefined,
    });
    const launchWarnings: string[] = [];
    // Codex CLI가 Windows .cmd shim이면 profile.bin은 cmd.exe, binPrefixArgs는 /d /s /c <shim>이다.
    // 등록 명령은 이 prefixArgs를 base args로 실어야 PTY 실행 경로와 동일하게 codex가 호출된다(POSIX에선 빈 배열).
    for (const registration of plugin.codexRegistrations) {
      const registrationWarning = ensureCodexPluginRegistered(registration, {
        args: [...(profile.binPrefixArgs ?? [])],
        bin: profile.bin,
        cwd: profile.cwd,
        env: { ...profile.env },
      }, options.codexCommandRunner);
      if (registrationWarning !== undefined) {
        launchWarnings.push(`Fleet Codex plugin registration failed for ${registration.pluginName}: ${registrationWarning}`);
      }
    }
    const cleanup = createOnceCleanup(() => {
      plugin.cleanup();
      for (const tempCleanup of tempCleanups) {
        tempCleanup();
      }
      options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    });
    options.onCleanup?.(cleanup);
    const context: AgentCliInjectionContext = {
      cliId: profile.id,
      mcpServers,
      pluginRoot: plugin.pluginRoot,
      pluginRoots: plugin.pluginRoots,
      codexProfileName: codexProfile?.profileName,
      replaceSystemPrompt: options.replaceSystemPrompt ?? true,
      systemPromptFile,
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    return {
      ...profile,
      args: [...profile.args, ...injectedArgs],
      cleanup,
      launchWarnings: [...(profile.launchWarnings ?? []), ...launchWarnings],
    };
  } catch (error) {
    for (const tempCleanup of tempCleanups) {
      tempCleanup();
    }
    options.dedicatedMcpSession.releaseSessionToken(tokenLabel);
    throw error;
  }
}

export function buildFleetHookCommand(entry: FleetHookCommandEntry | undefined): FleetHookExec {
  if (entry === undefined) {
    throw new Error("Fleet session hook command requires the current Fleet entry path");
  }
  const extension = path.extname(entry.entryPath);
  if (JAVASCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    // exec form: 셸 인용이 없으므로 공백 포함 경로(예: C:\Program Files\nodejs\node.exe)도 그대로 안전하다.
    return {
      command: entry.execPath,
      args: [entry.entryPath, "hook", "subagents-context"],
    };
  }
  if (TYPESCRIPT_ENTRY_EXTENSIONS.has(extension)) {
    if (!entry.tsxLoaderPath) {
      throw new Error("Fleet session hook command for TypeScript entries requires a tsx loader path");
    }
    // node --import는 Windows에서 절대경로(C:\...)를 c: URL scheme으로 오인하므로 file:// URL로 변환한다.
    return {
      command: entry.execPath,
      args: ["--import", pathToFileURL(entry.tsxLoaderPath).href, entry.entryPath, "hook", "subagents-context"],
    };
  }
  throw new Error(`Unsupported Fleet session hook entry extension: ${extension}`);
}

function buildStartupNativeDefinitions(
  cliId: AgentCliProfile["id"],
  carrierRuntime: CarrierRuntime,
): StartupNativeDefinitions {
  const host = getNativeSubagentHost(cliId);
  if (host === "none") return { host, definitions: [] };
  const carrierIds = getRegisteredOrder(carrierRuntime.registry);
  const carrierConfigs = carrierIds
    .map((carrierId) => getCarrierConfig(carrierRuntime.registry, carrierId))
    .filter((config): config is NonNullable<typeof config> => config !== undefined);
  const defaultsByCarrier = Object.fromEntries(
    carrierConfigs.map((config) => [config.id, buildCarrierModelDefaults(config)]),
  );
  const enabledCarrierIds = getEnabledCarrierSubagentIds(
    readCarrierAgentModeSnapshot(defaultsByCarrier),
    carrierIds,
  );
  if (enabledCarrierIds.length === 0) return { host, definitions: [] } as StartupNativeDefinitions;
  if (host === "claude") {
    return { host, definitions: buildClaudeSubagentDefinitions({ carrierConfigs, enabledCarrierIds }) };
  }
  return { host, definitions: [] };
}

function getNativeSubagentHost(cliId: AgentCliProfile["id"]): StartupNativeDefinitions["host"] {
  if (cliId === "claude" || cliId === "claude-kimi") return "claude";
  return "none";
}

function buildAgentCliMcpServerConfigs(
  endpoints: readonly { readonly name: string; readonly url: string }[],
  tokens: readonly { readonly name: string; readonly token: string }[],
): AgentCliMcpServerArg[] {
  return endpoints.map((endpoint) => {
    const token = tokens.find((entry) => entry.name === endpoint.name)?.token;
    if (!token) {
      throw new Error(`Dedicated MCP token missing for ${endpoint.name}`);
    }
    return {
      name: endpoint.name,
      endpointUrl: endpoint.url,
      bearerToken: token,
    };
  });
}

function buildCarrierModelDefaults(config: CarrierConfig): CarrierModelDefaults {
  const cliType = resolveAgentCliType(config.id, config.defaultCliType);
  const cliDefaults = resolvePersonaCliDefaults(config, cliType);
  return {
    cliType,
    ...(config.defaultAgentMode ? { defaultAgentMode: config.defaultAgentMode } : {}),
    ...(cliDefaults.defaultEffort ? { defaultEffort: cliDefaults.defaultEffort } : {}),
    ...(cliDefaults.defaultModel ? { defaultModel: cliDefaults.defaultModel } : {}),
  };
}

function writeSystemPromptFile(
  cliId: string,
  systemPrompt: string,
  onCleanup: (cleanup: () => void) => void,
): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `fleet-${cliId}-`));
  onCleanup(() => rmBestEffort(tempDir));
  const filePath = path.join(tempDir, "system-prompt.md");
  writeFileSync(filePath, systemPrompt, { encoding: "utf8", flag: "wx", mode: SYSTEM_PROMPT_FILE_MODE });
  chmodBestEffort(filePath, SYSTEM_PROMPT_FILE_MODE);
  return filePath;
}

function writeCodexFleetProfile(
  env: Readonly<Record<string, string>>,
  doctrine: string,
  onCleanup: (cleanup: () => void) => void,
): CodexFleetProfile {
  const codexHome = env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
  mkdirSync(codexHome, { recursive: true });
  pruneStaleCodexFleetProfiles(codexHome);
  const profileName = `fleet-${crypto.randomUUID()}`;
  const profilePath = path.join(codexHome, `${profileName}.config.toml`);
  onCleanup(() => rmBestEffort(profilePath));
  writeFileNoFollow(profilePath, [
    CODEX_FLEET_PROFILE_MARKER,
    // doctrine를 멀티라인 TOML 문자열로 직렬화해 실제 줄바꿈을 보존(pretty)한다.
    // 여는 """ 바로 뒤의 줄바꿈은 TOML 파서가 제거하므로 본문은 다음 줄부터 시작한다.
    `developer_instructions = """`,
    escapeTomlMultilineString(doctrine),
    `"""`,
    "",
    `[plugins."${escapeTomlBasicString(CODEX_FLEET_PLUGIN_KEY)}"]`,
    "enabled = true",
    "",
  ].join("\n"));
  chmodBestEffort(profilePath, SYSTEM_PROMPT_FILE_MODE);
  return { profileName, profilePath };
}

function writeFileNoFollow(filePath: string, content: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(filePath, flags, SYSTEM_PROMPT_FILE_MODE);
  try {
    writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}

function pruneStaleCodexFleetProfiles(codexHome: string): void {
  let entries: string[];
  try {
    entries = readdirSync(codexHome);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!CODEX_FLEET_PROFILE_FILE_NAME_PATTERN.test(entry)) continue;
    const filePath = path.join(codexHome, entry);
    if (!isStaleFleetCodexProfile(filePath, now)) continue;
    unlinkBestEffort(filePath);
  }
}

function isStaleFleetCodexProfile(filePath: string, now: number): boolean {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (now - stat.mtimeMs <= CODEX_STALE_PROFILE_MAX_AGE_MS) return false;
    return readFirstLine(filePath) === CODEX_FLEET_PROFILE_MARKER;
  } catch {
    return false;
  }
}

function readFirstLine(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  return content.split(/\r?\n/, 1)[0] ?? "";
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch {
    // POSIX 권한을 지원하지 않는 파일시스템에서는 best-effort로 둔다.
  }
}

function rmBestEffort(targetPath: string): void {
  try {
    rmSync(targetPath, { force: true, recursive: true });
  } catch {
    // 세션 정리는 파일이 이미 사라진 경우에도 전체 shutdown을 막지 않는다.
  }
}

function unlinkBestEffort(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch {
    // stale profile 정리는 검증 뒤 파일이 바뀌거나 사라져도 세션 시작을 막지 않는다.
  }
}

function resolvePersonaCliDefaults(
  config: CarrierConfig,
  cliType: ReturnType<typeof resolveAgentCliType>,
): { readonly defaultEffort?: string; readonly defaultModel?: string } {
  if (cliType === "claude") {
    return config.subagent?.byHost?.claude ?? {
      ...(config.defaultEffort ? { defaultEffort: config.defaultEffort } : {}),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    };
  }
  return {};
}

function buildAgentCliArgs(
  builderId: "claude-native" | "codex-native",
  context: AgentCliInjectionContext,
): string[] {
  switch (builderId) {
    case "claude-native":
      return buildClaudeNativeArgs(context);
    case "codex-native":
      return buildCodexNativeArgs(context);
  }
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
