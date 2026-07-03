import crypto from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CarrierRuntime,
  type ClaudeSubagentDefinition,
} from "@dotobokuri/fleet-carriers";

import { buildClaudeNativeSubagentPlan } from "./carrier-defaults.js";
import { buildClaudeNativeArgs } from "./builders/claude.js";
import { buildCodexNativeArgs } from "./builders/codex.js";
import { buildPosixShellCommand, escapeTomlBasicString, escapeTomlMultilineString } from "./builders/toml.js";
import { getAgentCliInjectionCapability } from "./capabilities.js";
import { cleanupDeprecatedCodexPluginState, createAgentCliPlugin, ensureCodexPluginRegistered, FLEET_MARKETPLACE_NAME } from "./plugin/index.js";
import type {
  AgentCliInjectionContext,
  AgentCliMcpServerArg,
  AgentCliProfile,
  CodexCommandResult,
  CodexPluginRegistrationCommand,
  FleetHookExec,
} from "./types.js";

export interface InjectAgentCliProfileOptions {
  readonly buildSystemPrompt: (injectTone: boolean) => string;
  readonly carrierRuntime: CarrierRuntime;
  readonly dataDir: string;
  readonly dedicatedMcpSession: DedicatedMcpSession;
  readonly mcpSessionLabel?: string;
  readonly replaceSystemPrompt?: boolean;
  readonly enableMetaphor?: boolean;
  readonly captureSessionHookExec?: FleetHookExec;
  // 턴 시작(UserPromptSubmit)·턴 종료(Stop) 신호 hook. host가 빌드해 주입하며 claude/codex 양쪽에 와이어링된다.
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  // 입력 대기(AskUserQuestion PreToolUse · 입력 대기 Notification) 신호 hook. Claude 전용 와이어링.
  readonly inputWaitingHookExec?: FleetHookExec;
  // 작전명 자동 작명(UserPromptSubmit) hook. host가 빌드해 주입하며 claude/codex 양쪽에 와이어링된다.
  readonly autoNameHookExec?: FleetHookExec;
  readonly codexCommandRunner?: (command: CodexPluginRegistrationCommand) => CodexCommandResult;
  readonly hookExec?: FleetHookExec;
  readonly onCleanup?: (cleanup: () => void) => void;
  readonly pluginRootDir?: string;
  readonly resumeSessionId?: string;
  readonly withMarketplaceLock: AgentCliPluginMarketplaceLock;
}

interface AgentCliPluginMarketplaceLock {
  <T>(target: string, fn: () => T | Promise<T>): T | Promise<T>;
}

interface CodexFleetProfile {
  readonly profileName: string;
  readonly profilePath: string;
}

interface CodexProfileHookExecs {
  readonly captureSessionHookExec?: FleetHookExec;
  readonly turnStartHookExec?: FleetHookExec;
  readonly turnEndHookExec?: FleetHookExec;
  readonly autoNameHookExec?: FleetHookExec;
}

interface DedicatedMcpSession {
  getEndpoint(): Promise<ExecutorEndpoint>;
  issueSessionToken(request: { readonly label: string; readonly cwd: string; readonly signal?: AbortSignal }): readonly ExecutorServerToken[] | Promise<readonly ExecutorServerToken[]>;
  releaseSessionToken(label: string): void;
}

interface ExecutorEndpoint {
  readonly servers: readonly { readonly name: string; readonly url: string }[];
}

interface ExecutorServerToken {
  readonly name: string;
  readonly token: string;
}

type StartupNativeDefinitions =
  | { readonly host: "claude"; readonly definitions: ClaudeSubagentDefinition[] }
  | { readonly host: "none"; readonly definitions: [] };

const CODEX_FLEET_PROFILE_NAME = "fleet";
const CODEX_FLEET_PROFILE_FILE_NAME = `${CODEX_FLEET_PROFILE_NAME}.config.toml`;
const CODEX_LEGACY_FLEET_PROFILE_FILE_NAME_PATTERN = /^fleet-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.config\.toml$/;
const CODEX_FLEET_PROFILE_MARKER = "# Fleet-managed Codex profile";
const CODEX_LEGACY_FLEET_PROFILE_MARKER = "# Fleet-managed Codex session profile";
const SYSTEM_PROMPT_FILE_MODE = 0o600;

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
  const tokenLabel = options.mcpSessionLabel ?? `agent:${profile.id}:${crypto.randomUUID()}`;
  const tokens = await options.dedicatedMcpSession.issueSessionToken({ cwd: profile.cwd, label: tokenLabel });
  const mcpServers = buildAgentCliMcpServerConfigs(endpoint.servers, tokens);
  const doctrine = options.buildSystemPrompt(injectTone);
  const tempCleanups: Array<() => void> = [];
  try {
    const systemPromptFile = profile.id === "claude"
      ? writeSystemPromptFile(profile.id, doctrine, (cleanup) => tempCleanups.push(cleanup))
      : undefined;
    const plugin = await createAgentCliPlugin({
      claudeDefinitions: startupDefinitions.host === "claude" ? startupDefinitions.definitions : [],
      cliId: profile.id,
      codexCommandRunner: options.codexCommandRunner,
      cwd: profile.cwd,
      dataDir: options.dataDir,
      rootDir: options.pluginRootDir,
      captureSessionHookExec: options.captureSessionHookExec,
      turnStartHookExec: options.turnStartHookExec,
      turnEndHookExec: options.turnEndHookExec,
      inputWaitingHookExec: options.inputWaitingHookExec,
      autoNameHookExec: options.autoNameHookExec,
      hookExec: startupDefinitions.host === "claude" ? requireHookExec(options.hookExec) : undefined,
      withMarketplaceLock: options.withMarketplaceLock,
    });
    const codexPluginKeys = plugin.codexRegistrations.map((registration) => `${registration.pluginName}@${registration.marketplaceName}`);
    const codexProfile = profile.id === "codex"
      ? writeCodexFleetProfile(profile.env, doctrine, codexPluginKeys, {
          captureSessionHookExec: options.captureSessionHookExec,
          turnStartHookExec: options.turnStartHookExec,
          turnEndHookExec: options.turnEndHookExec,
          autoNameHookExec: options.autoNameHookExec,
        })
      : undefined;
    const launchWarnings: string[] = [];
    // 과거 fleet-global/fleet-project 렌더가 Codex 설정에 남긴 등록·flat marketplace 잔재를 등록 루프 전에 1회 정리한다.
    if (profile.id === "codex") {
      const cleanupWarning = await cleanupDeprecatedCodexPluginState({
        args: [...(profile.binPrefixArgs ?? [])],
        bin: profile.bin,
        cwd: profile.cwd,
        env: { ...profile.env },
      }, requireCodexCommandRunner(options.codexCommandRunner), options.withMarketplaceLock, {
        homeMarketplaceName: FLEET_MARKETPLACE_NAME,
        homeMarketplaceRoot: path.join(options.pluginRootDir ?? options.dataDir, "marketplace"),
        projectMarketplaceRoot: path.join(profile.cwd, ".fleet"),
      });
      if (cleanupWarning !== undefined) {
        launchWarnings.push(`Deprecated Codex plugin cleanup failed: ${cleanupWarning}`);
      }
    }
    // Codex CLI가 Windows .cmd shim이면 profile.bin은 cmd.exe, binPrefixArgs는 /d /s /c <shim>이다.
    // 등록 명령은 이 prefixArgs를 base args로 실어야 PTY 실행 경로와 동일하게 codex가 호출된다(POSIX에선 빈 배열).
    for (const registration of plugin.codexRegistrations) {
      const registrationWarning = await ensureCodexPluginRegistered(registration, {
        args: [...(profile.binPrefixArgs ?? [])],
        bin: profile.bin,
        cwd: profile.cwd,
        env: { ...profile.env },
      }, requireCodexCommandRunner(options.codexCommandRunner), options.withMarketplaceLock);
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
      replaceSystemPrompt: options.replaceSystemPrompt ?? false,
      resumeSessionId: options.resumeSessionId,
      systemPromptFile,
    };
    const injectedArgs = buildAgentCliArgs(capability.builderId, context);
    return {
      ...profile,
      args: mergeAgentCliArgs(profile, capability.builderId, context, injectedArgs),
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

function buildStartupNativeDefinitions(
  cliId: AgentCliProfile["id"],
  carrierRuntime: CarrierRuntime,
): StartupNativeDefinitions {
  const host = getNativeSubagentHost(cliId);
  if (host === "none") return { host, definitions: [] };
  return { host, definitions: buildClaudeNativeSubagentPlan(carrierRuntime.registry).definitions };
}

function getNativeSubagentHost(cliId: AgentCliProfile["id"]): StartupNativeDefinitions["host"] {
  if (cliId === "claude") return "claude";
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
  pluginKeys: readonly string[],
  hookExecs: CodexProfileHookExecs,
): CodexFleetProfile {
  const codexHome = env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
  mkdirSync(codexHome, { recursive: true });
  pruneLegacyCodexFleetProfiles(codexHome);
  const profileName = CODEX_FLEET_PROFILE_NAME;
  const profilePath = path.join(codexHome, CODEX_FLEET_PROFILE_FILE_NAME);
  writeFileNoFollow(profilePath, [
    CODEX_FLEET_PROFILE_MARKER,
    // doctrine를 멀티라인 TOML 문자열로 직렬화해 실제 줄바꿈을 보존(pretty)한다.
    // 여는 """ 바로 뒤의 줄바꿈은 TOML 파서가 제거하므로 본문은 다음 줄부터 시작한다.
    `developer_instructions = """`,
    escapeTomlMultilineString(doctrine),
    `"""`,
    "",
    "[features]",
    "hooks = true",
    "",
    ...pluginKeys.flatMap((pluginKey) => [
      `[plugins."${escapeTomlBasicString(pluginKey)}"]`,
      "enabled = true",
      "",
    ]),
    ...codexHooksConfig(hookExecs),
  ].join("\n"));
  chmodBestEffort(profilePath, SYSTEM_PROMPT_FILE_MODE);
  return { profileName, profilePath };
}

function codexHooksConfig(hookExecs: CodexProfileHookExecs): string[] {
  // UserPromptSubmit = 세션 캡처 + 턴 시작 + 자동 작명, Stop = 턴 종료. codex hook 이벤트 키는 PascalCase.
  const userPromptSubmitExecs = [hookExecs.captureSessionHookExec, hookExecs.turnStartHookExec, hookExecs.autoNameHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  const stopExecs = [hookExecs.turnEndHookExec]
    .filter((exec): exec is FleetHookExec => exec !== undefined);
  if (userPromptSubmitExecs.length === 0 && stopExecs.length === 0) return [];
  const lines = ["[hooks]"];
  if (userPromptSubmitExecs.length > 0) {
    lines.push(`UserPromptSubmit = ${codexHookHandlersInline(userPromptSubmitExecs)}`);
  }
  if (stopExecs.length > 0) {
    lines.push(`Stop = ${codexHookHandlersInline(stopExecs)}`);
  }
  lines.push("");
  return lines;
}

function codexHookHandlersInline(execs: readonly FleetHookExec[]): string {
  const handlers = execs
    .map((exec) => {
      const command = buildPosixShellCommand([exec.command, ...exec.args]);
      return `{ type = "command", command = "${escapeTomlBasicString(command)}" }`;
    })
    .join(", ");
  return `[{ hooks = [${handlers}] }]`;
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

function pruneLegacyCodexFleetProfiles(codexHome: string): void {
  let entries: string[];
  try {
    entries = readdirSync(codexHome);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!CODEX_LEGACY_FLEET_PROFILE_FILE_NAME_PATTERN.test(entry)) continue;
    const filePath = path.join(codexHome, entry);
    if (!isLegacyFleetCodexProfile(filePath)) continue;
    unlinkBestEffort(filePath);
  }
}

function isLegacyFleetCodexProfile(filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const firstLine = readFirstLine(filePath);
    return firstLine === CODEX_LEGACY_FLEET_PROFILE_MARKER;
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

function requireHookExec(hookExec: FleetHookExec | undefined): FleetHookExec {
  if (hookExec) return hookExec;
  throw new Error("Fleet session hook executable is required for Claude native injection");
}

function requireCodexCommandRunner(
  codexCommandRunner: InjectAgentCliProfileOptions["codexCommandRunner"],
): (command: CodexPluginRegistrationCommand) => CodexCommandResult {
  if (codexCommandRunner) return codexCommandRunner;
  throw new Error("Codex plugin registration requires an injected command runner");
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

function mergeAgentCliArgs(
  profile: AgentCliProfile,
  builderId: "claude-native" | "codex-native",
  context: AgentCliInjectionContext,
  injectedArgs: readonly string[],
): string[] {
  if (builderId !== "codex-native" || context.resumeSessionId === undefined) {
    return [...profile.args, ...injectedArgs];
  }
  const resumeSessionId = context.resumeSessionId;
  const prefixLength = profile.binPrefixArgs?.length ?? 0;
  const codexResumeArgs = ["resume", resumeSessionId];
  const injectedTail = injectedArgs.slice(codexResumeArgs.length);
  return [
    ...profile.args.slice(0, prefixLength),
    ...codexResumeArgs,
    ...profile.args.slice(prefixLength).filter((arg, index, args) => !isCodexResumeArgAt(args, index, resumeSessionId)),
    ...injectedTail,
  ];
}

function isCodexResumeArgAt(args: readonly string[], index: number, resumeSessionId: string): boolean {
  return (args[index] === "resume" && args[index + 1] === resumeSessionId) || (args[index] === resumeSessionId && args[index - 1] === "resume");
}

function createOnceCleanup(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}
