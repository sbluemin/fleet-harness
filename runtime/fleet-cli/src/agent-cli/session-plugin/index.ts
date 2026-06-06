import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDir, removePrivatePath, writePrivateFile, writePrivateJson } from "./fs.js";
import type {
  AgentCliSessionPlugin,
  CodexCommandResult,
  CodexPluginRegistration,
  CodexPluginRegistrationCommand,
  CreateAgentCliSessionPluginOptions,
} from "./types.js";

interface LegacyMarketplaceFile {
  readonly name?: unknown;
  readonly plugins?: unknown;
}

interface LegacyMarketplacePlugin {
  readonly name?: unknown;
  readonly source?: unknown;
}

interface LegacyMarketplacePluginSource {
  readonly path?: unknown;
  readonly source?: unknown;
}

const PLUGIN_NAME = "fleet";
const CODEX_MARKETPLACE_NAME = "fleet";
const CODEX_TOOL_TIMEOUT_SEC = 1_800;
const CLAUDE_AGENT_FILE_STEM_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const PLUGIN_MANAGED_ENTRIES = [
  ".agents",
  ".codex-plugin",
  ".claude-plugin",
  "hooks",
  "skills",
  "agents",
  ".mcp.json",
  "doctrine.md",
  "claude",
  "codex-marketplace",
  "plugins",
] as const;
const HASH_IGNORED_RELATIVE_PATHS = new Set([".fleet-codex-plugin.hash"]);
const CODEX_COMPAT_PLUGIN_PATH = "./plugins/fleet";

export function createAgentCliSessionPlugin(
  options: CreateAgentCliSessionPluginOptions,
): AgentCliSessionPlugin {
  const fleetRoot = options.rootDir ?? path.join(os.homedir(), ".fleet");
  const sessionPluginRoot = path.join(fleetRoot, "plugins");
  const env = buildEnv(options.mcpServers);
  ensurePrivateDir(sessionPluginRoot, sessionPluginRoot);
  renderPluginRoot(sessionPluginRoot, options, env);
  const contentHash = buildContentHash(sessionPluginRoot);
  const cleanup = (): void => {};
  options.onCleanup?.(cleanup);
  return {
    cleanup,
    codexRegistration: options.cliId === "codex"
      ? {
        contentHash,
        hashPath: path.join(sessionPluginRoot, ".fleet-codex-plugin.hash"),
        marketplaceDir: sessionPluginRoot,
        marketplaceName: CODEX_MARKETPLACE_NAME,
        pluginName: PLUGIN_NAME,
        pluginRoot: sessionPluginRoot,
      }
      : undefined,
    env,
    pluginRoot: sessionPluginRoot,
  };
}

export function ensureCodexPluginRegistered(
  registration: CodexPluginRegistration,
  command: CodexPluginRegistrationCommand,
  runCommand: (command: CodexPluginRegistrationCommand) => CodexCommandResult = runCodexCommand,
): string | undefined {
  try {
    ensureCodexPluginRegisteredOrThrow(registration, command, runCommand);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function parseClaudeAgentFileStem(name: string): string {
  if (CLAUDE_AGENT_FILE_STEM_ALLOWLIST.test(name) && path.basename(name) === name) return name;
  throw new Error(`Invalid Claude agent file name: ${name}`);
}

function buildEnv(
  servers: CreateAgentCliSessionPluginOptions["mcpServers"],
): Record<string, string> {
  return Object.fromEntries(
    servers.map((server) => [`FLEET_MCP_${normalizeEnvName(server.name)}_TOKEN`, server.token]),
  );
}

function normalizeEnvName(value: string): string {
  return value.replace(/[^A-Z0-9_]/gi, "_").toUpperCase();
}

function renderPluginRoot(
  pluginRoot: string,
  options: CreateAgentCliSessionPluginOptions,
  env: Readonly<Record<string, string>>,
): void {
  ensurePrivateDir(pluginRoot, pluginRoot);
  prunePluginRoot(pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".agents", "plugins", "marketplace.json"), {
    name: CODEX_MARKETPLACE_NAME,
    plugins: [{
      name: PLUGIN_NAME,
      source: {
        source: "local",
        path: CODEX_COMPAT_PLUGIN_PATH,
      },
    }],
  }, pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), codexManifest(), pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), claudeManifest(), pluginRoot);
  writePrivateFile(path.join(pluginRoot, "hooks", "session-start.mjs"), hookScript(options.doctrine), pluginRoot);
  writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), hookConfig(), pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".mcp.json"), mcpConfig(options.mcpServers, env), pluginRoot);
  writePrivateFile(path.join(pluginRoot, "skills", "fleet-usage", "SKILL.md"), fleetUsageSkill(), pluginRoot);
  renderCodexCompatibilitySymlink(pluginRoot);
  for (const subagent of options.claudeDefinitions) {
    const fileStem = parseClaudeAgentFileStem(subagent.name);
    writePrivateFile(path.join(pluginRoot, "agents", `${fileStem}.md`), claudeAgentFile(subagent), pluginRoot);
  }
}

function prunePluginRoot(pluginRoot: string): void {
  for (const entry of PLUGIN_MANAGED_ENTRIES) {
    removePrivatePath(path.join(pluginRoot, entry), pluginRoot);
  }
}

function renderCodexCompatibilitySymlink(pluginRoot: string): void {
  const compatibilityDir = path.join(pluginRoot, "plugins");
  const compatibilityPath = path.join(compatibilityDir, PLUGIN_NAME);
  ensurePrivateDir(compatibilityDir, pluginRoot);
  symlinkSync("..", compatibilityPath);
  const targetRealpath = statSync(compatibilityPath).isDirectory()
    ? path.resolve(compatibilityDir, readlinkSync(compatibilityPath))
    : undefined;
  if (targetRealpath !== path.resolve(pluginRoot)) {
    throw new Error(`Codex compatibility plugin path escapes root: ${compatibilityPath}`);
  }
}

function buildContentHash(pluginRoot: string): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listRenderableFiles(pluginRoot)) {
    const relativePath = path.relative(pluginRoot, filePath);
    hash.update(relativePath);
    hash.update("\0");
    const stat = lstatSync(filePath);
    hash.update(stat.isSymbolicLink() ? readlinkSync(filePath) : readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hookConfig(): unknown {
  return {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
        }],
      }],
    },
  };
}

function hookScript(doctrine: string): string {
  return [
    `const doctrine = ${JSON.stringify(doctrine)};`,
    "console.log(JSON.stringify({",
    "  hookSpecificOutput: {",
    '    hookEventName: "SessionStart",',
    "    additionalContext: doctrine,",
    "  },",
    "}));",
    "",
  ].join("\n");
}

function codexManifest(): unknown {
  return {
    name: PLUGIN_NAME,
    version: "0.0.0",
    description: "Fleet plugin",
    hooks: "./hooks/hooks.json",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
  };
}

function claudeManifest(): unknown {
  return {
    name: PLUGIN_NAME,
    version: "0.0.0",
    description: "Fleet plugin",
  };
}

function mcpConfig(
  servers: CreateAgentCliSessionPluginOptions["mcpServers"],
  env: Readonly<Record<string, string>>,
): unknown {
  const envEntries = Object.keys(env);
  return {
    mcpServers: Object.fromEntries(
      servers.map((server, index) => [server.name, {
        type: "http",
        url: server.endpointUrl,
        bearer_token_env_var: envEntries[index],
        headers: {
          Authorization: `Bearer \${${envEntries[index]}}`,
        },
        tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
      }]),
    ),
  };
}

function fleetUsageSkill(): string {
  return [
    "---",
    "name: fleet-usage",
    "description: Use Fleet carrier delegation and job lookup tools in this session.",
    "---",
    "",
    "# Fleet Usage",
    "",
    "Use `carrier_dispatch` for delegated carrier work and `carrier_jobs` to inspect accepted jobs.",
    "Keep requests narrow, include the requested carrier and label, and wait for `[carrier:result]` before treating detached work as complete.",
    "",
  ].join("\n");
}

function claudeAgentFile(subagent: CreateAgentCliSessionPluginOptions["claudeDefinitions"][number]): string {
  const frontmatter = [
    "---",
    `name: ${yamlScalar(subagent.name)}`,
    `description: ${yamlScalar(subagent.description)}`,
    ...(subagent.model ? [`model: ${yamlScalar(subagent.model)}`] : []),
    ...(subagent.effort ? [`effort: ${yamlScalar(subagent.effort)}`] : []),
    ...(subagent.color ? [`color: ${yamlScalar(subagent.color)}`] : []),
    "background: true",
    "---",
    "",
  ];
  return [...frontmatter, subagent.prompt, ""].join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function runCodexCommand(command: CodexPluginRegistrationCommand): CodexCommandResult {
  const result = spawnSync(command.bin, command.args, {
    cwd: command.cwd,
    encoding: "utf8",
    env: command.env,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function assertCommandSucceeded(label: string, result: CodexCommandResult): void {
  if (result.status === 0) return;
  const detail = [result.stderr.trim(), result.stdout.trim()].filter((entry) => entry.length > 0).join("\n");
  throw new Error(`${label} failed${detail.length > 0 ? `: ${detail}` : ""}`);
}

function ensureCodexPluginRegisteredOrThrow(
  registration: CodexPluginRegistration,
  command: CodexPluginRegistrationCommand,
  runCommand: (command: CodexPluginRegistrationCommand) => CodexCommandResult,
): void {
  cleanupLegacyAgentsMarketplace(registration, command);
  const marketplaceList = runCommand({ ...command, args: ["plugin", "marketplace", "list"] });
  assertCommandSucceeded("codex plugin marketplace list", marketplaceList);
  const marketplaces = findMarketplaceEntries(marketplaceList, registration.marketplaceName);
  const targetRoot = normalizeMarketplaceRoot(registration.marketplaceDir, command.cwd);
  const hasTargetMarketplace = marketplaces.some((entry) => normalizeMarketplaceRoot(entry.root, command.cwd) === targetRoot);
  const hasStaleMarketplace = marketplaces.some((entry) => normalizeMarketplaceRoot(entry.root, command.cwd) !== targetRoot);
  if (hasStaleMarketplace) {
    runCommand({
      ...command,
      args: ["plugin", "marketplace", "remove", registration.marketplaceName],
    });
  }
  if (!hasTargetMarketplace || hasStaleMarketplace) {
    const addMarketplace = runCommand({
      ...command,
      args: ["plugin", "marketplace", "add", registration.marketplaceDir],
    });
    assertCommandSucceeded("codex plugin marketplace add", addMarketplace);
  }

  const pluginList = runCommand({ ...command, args: ["plugin", "list"] });
  assertCommandSucceeded("codex plugin list", pluginList);
  const installed = commandOutputContains(pluginList, `${registration.pluginName}@${registration.marketplaceName}`)
    || commandOutputContains(pluginList, registration.pluginName);
  const previousHash = readHash(registration.hashPath);
  if (installed && previousHash === registration.contentHash) {
    return;
  }

  const addPlugin = runCommand({
    ...command,
    args: ["plugin", "add", registration.pluginName, "-m", registration.marketplaceName],
  });
  assertCommandSucceeded("codex plugin add", addPlugin);
  writePrivateFile(registration.hashPath, `${registration.contentHash}\n`, path.dirname(registration.hashPath));
}

function cleanupLegacyAgentsMarketplace(
  registration: CodexPluginRegistration,
  command: CodexPluginRegistrationCommand,
): void {
  const homeDir = command.env.HOME ?? os.homedir();
  const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
  if (!existsSync(marketplacePath)) return;
  const stat = lstatSync(marketplacePath);
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  const parsed = readLegacyMarketplaceFile(marketplacePath);
  if (parsed === undefined) return;
  if (!Array.isArray(parsed.plugins)) return;
  if (parsed.plugins.length === 0 && isLegacyFleetOnlyMarketplaceFile(parsed)) {
    removePrivatePath(marketplacePath, path.dirname(marketplacePath));
    return;
  }
  const nextPlugins = parsed.plugins.filter((plugin) => !isLegacyFleetMarketplacePlugin(
    plugin,
    registration,
    homeDir,
  ));
  if (nextPlugins.length === parsed.plugins.length) return;
  if (nextPlugins.length === 0 && isLegacyFleetOnlyMarketplaceFile(parsed)) {
    removePrivatePath(marketplacePath, path.dirname(marketplacePath));
    return;
  }
  writePrivateJson(marketplacePath, { ...parsed, plugins: nextPlugins }, path.dirname(marketplacePath));
}

function readLegacyMarketplaceFile(marketplacePath: string): LegacyMarketplaceFile | undefined {
  try {
    return JSON.parse(readFileSync(marketplacePath, "utf8")) as LegacyMarketplaceFile;
  } catch (_error) {
    return undefined;
  }
}

function isLegacyFleetMarketplacePlugin(
  value: unknown,
  registration: CodexPluginRegistration,
  homeDir: string,
): value is LegacyMarketplacePlugin {
  if (!isRecord(value)) return false;
  const plugin = value as LegacyMarketplacePlugin;
  if (plugin.name !== registration.pluginName) return false;
  if (!isRecord(plugin.source)) return false;
  const source = plugin.source as LegacyMarketplacePluginSource;
  if (source.source !== "local" || typeof source.path !== "string") return false;
  const pluginPath = path.resolve(homeDir, source.path);
  const targetPath = path.resolve(registration.marketplaceDir);
  const legacyFleetPath = path.join(homeDir, ".fleet", "plugins");
  return pluginPath === targetPath || pluginPath === legacyFleetPath;
}

function isLegacyFleetOnlyMarketplaceFile(value: LegacyMarketplaceFile): boolean {
  if (value.name !== CODEX_MARKETPLACE_NAME) return false;
  return Object.keys(value).every((key) => key === "name" || key === "plugins");
}

function findMarketplaceEntries(
  result: CodexCommandResult,
  marketplaceName: string,
): Array<{ readonly name: string; readonly root: string }> {
  const entries: Array<{ readonly name: string; readonly root: string }> = [];
  for (const line of commandOutput(result).split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (match?.[1] === marketplaceName) {
      entries.push({ name: match[1], root: match[2].trim() });
    }
  }
  return entries;
}

function normalizeMarketplaceRoot(rootPath: string, cwd: string): string {
  const resolved = path.resolve(cwd, rootPath);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
    throw error;
  }
}

function commandOutputContains(result: CodexCommandResult, value: string): boolean {
  return commandOutput(result).includes(value);
}

function commandOutput(result: CodexCommandResult): string {
  return [result.stdout, result.stderr].filter((entry) => entry.length > 0).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readHash(hashPath: string): string | undefined {
  if (!existsSync(hashPath)) return undefined;
  return readFileSync(hashPath, "utf8").trim();
}

function listRenderableFiles(rootPath: string): string[] {
  const files: string[] = [];
  collectRenderableFiles(rootPath, rootPath, files);
  return files.sort();
}

function collectRenderableFiles(rootPath: string, currentPath: string, files: string[]): void {
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const relativePath = path.relative(rootPath, entryPath);
    if (HASH_IGNORED_RELATIVE_PATHS.has(relativePath)) continue;
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      files.push(entryPath);
      continue;
    }
    if (stat.isDirectory()) {
      collectRenderableFiles(rootPath, entryPath, files);
      continue;
    }
    if (stat.isFile()) {
      files.push(entryPath);
    }
  }
}
