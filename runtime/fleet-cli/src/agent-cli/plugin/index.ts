import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { neutralizeCodexFleetPluginConfig } from "./codex-config.js";
import { ensurePrivateDir, removePrivatePath, writePrivateFile, writePrivateJson } from "./fs.js";
import type {
  AgentCliPlugin,
  CodexCommandResult,
  CodexPluginRegistration,
  CodexPluginRegistrationCommand,
  CreateAgentCliPluginOptions,
} from "./types.js";

interface PluginBundle {
  readonly description: string;
  readonly directoryName: string;
  readonly displayName: string;
  readonly hashFileName: string;
  readonly includeClaudeAgents: boolean;
  readonly name: string;
}

export const CODEX_FLEET_PLUGIN_KEY = "fleet@fleet-harness";
export const FLEET_MARKETPLACE_NAME = "fleet-harness";

const CLAUDE_AGENT_FILE_STEM_ALLOWLIST = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MARKETPLACE_DIR_NAME = "marketplace";
const PLUGIN_BUNDLES_DIR_NAME = "plugins";
const PLUGIN_BUNDLES: readonly PluginBundle[] = [{
  description: "Fleet carrier delegation and wiki evidence plugin",
  directoryName: "fleet",
  displayName: "Fleet",
  hashFileName: ".fleet-codex-plugin.hash",
  includeClaudeAgents: true,
  name: "fleet",
}] as const;
const PLUGIN_MANAGED_ENTRIES = [
  ".codex-plugin",
  ".claude-plugin",
  "hooks",
  "skills",
  "agents",
  "claude",
  "codex-marketplace",
  "plugins",
] as const;
const MARKETPLACE_MANAGED_ENTRIES = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  "hooks",
  "skills",
  "agents",
  "claude",
  "codex-marketplace",
  "plugins",
] as const;
const HASH_IGNORED_RELATIVE_PATHS = new Set(PLUGIN_BUNDLES.map((bundle) => bundle.hashFileName));

export function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): AgentCliPlugin {
  const fleetRoot = options.rootDir ?? path.join(os.homedir(), ".fleet");
  const marketplaceRoot = path.join(fleetRoot, MARKETPLACE_DIR_NAME);
  validateClaudeAgentFileStems(options.claudeDefinitions);
  ensurePrivateDir(marketplaceRoot, marketplaceRoot);
  renderMarketplaceRoot(marketplaceRoot);
  const pluginRoots = PLUGIN_BUNDLES.map((bundle) => {
    const pluginRoot = path.join(marketplaceRoot, PLUGIN_BUNDLES_DIR_NAME, bundle.directoryName);
    renderPluginRoot(pluginRoot, bundle, options);
    return pluginRoot;
  });
  const contentHash = buildContentHash(marketplaceRoot);
  const cleanup = (): void => {};
  options.onCleanup?.(cleanup);
  return {
    cleanup,
    codexRegistrations: options.cliId === "codex"
      ? PLUGIN_BUNDLES.map((bundle, index) => ({
        contentHash,
        hashPath: path.join(marketplaceRoot, bundle.hashFileName),
        marketplaceDir: marketplaceRoot,
        marketplaceName: FLEET_MARKETPLACE_NAME,
        pluginName: bundle.name,
        pluginRoot: pluginRoots[index]!,
      }))
      : [],
    pluginRoot: pluginRoots[0]!,
    pluginRoots,
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

function validateClaudeAgentFileStems(
  subagents: CreateAgentCliPluginOptions["claudeDefinitions"],
): void {
  for (const subagent of subagents) {
    parseClaudeAgentFileStem(subagent.name);
  }
}

function renderPluginRoot(
  pluginRoot: string,
  bundle: PluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  ensurePrivateDir(pluginRoot, pluginRoot);
  prunePluginRoot(pluginRoot);
  ensurePrivateDir(path.join(pluginRoot, "agents"), pluginRoot);
  ensurePrivateDir(path.join(pluginRoot, "skills"), pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), codexManifest(bundle), pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), claudeManifest(bundle), pluginRoot);
  for (const skillRelativePath of listAssetSkillFilePaths(options, bundle)) {
    writePrivateFile(
      path.join(pluginRoot, "skills", skillRelativePath),
      readRequiredAsset(options, path.join("plugins", bundle.directoryName, "skills", skillRelativePath)),
      pluginRoot,
    );
  }
  if (bundle.includeClaudeAgents) {
    for (const subagent of options.claudeDefinitions) {
      const fileStem = parseClaudeAgentFileStem(subagent.name);
      writePrivateFile(path.join(pluginRoot, "agents", `${fileStem}.md`), claudeAgentFile(subagent), pluginRoot);
    }
  }
  if (options.cliId === "claude" || options.cliId === "claude-kimi") {
    writePrivateJson(path.join(pluginRoot, "hooks", "hooks.json"), claudeHooks(options), pluginRoot);
  }
}

function readRequiredAsset(options: CreateAgentCliPluginOptions, relativePath: string): string {
  const assetPath = path.join(requiredAssetsDir(options), relativePath);
  try {
    return readFileSync(assetPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Fleet plugin asset ${relativePath}: ${message}`);
  }
}

function listAssetSkillFilePaths(options: CreateAgentCliPluginOptions, bundle: PluginBundle): string[] {
  const skillsRelativePath = path.join("plugins", bundle.directoryName, "skills");
  const skillsRoot = path.join(requiredAssetsDir(options), skillsRelativePath);
  try {
    return listAssetFiles(skillsRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Fleet plugin skills directory ${skillsRelativePath}: ${message}`);
  }
}

function listAssetFiles(rootPath: string): string[] {
  const files: string[] = [];
  collectAssetFiles(rootPath, rootPath, files);
  return files.sort();
}

function collectAssetFiles(rootPath: string, currentPath: string, files: string[]): void {
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Fleet plugin asset symlink is unsupported: ${path.relative(rootPath, entryPath)}`);
    }
    if (stat.isDirectory()) {
      collectAssetFiles(rootPath, entryPath, files);
      continue;
    }
    if (stat.isFile()) {
      files.push(path.relative(rootPath, entryPath));
    }
  }
}

function requiredAssetsDir(options: CreateAgentCliPluginOptions): string {
  if (!options.assetsDir) {
    throw new Error("Fleet plugin assets directory is required");
  }
  return options.assetsDir;
}

function renderMarketplaceRoot(marketplaceRoot: string): void {
  ensurePrivateDir(marketplaceRoot, marketplaceRoot);
  pruneMarketplaceRoot(marketplaceRoot);
  writePrivateJson(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), codexMarketplace(), marketplaceRoot);
  writePrivateJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), claudeMarketplace(), marketplaceRoot);
}

function prunePluginRoot(pluginRoot: string): void {
  for (const entry of PLUGIN_MANAGED_ENTRIES) {
    removePrivatePath(path.join(pluginRoot, entry), pluginRoot);
  }
}

function pruneMarketplaceRoot(marketplaceRoot: string): void {
  for (const entry of MARKETPLACE_MANAGED_ENTRIES) {
    removePrivatePath(path.join(marketplaceRoot, entry), marketplaceRoot);
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

function codexMarketplace(): unknown {
  return {
    name: FLEET_MARKETPLACE_NAME,
    plugins: PLUGIN_BUNDLES.map((bundle) => ({
      name: bundle.name,
      displayName: bundle.displayName,
      source: {
        source: "local",
        path: marketplacePluginPath(bundle),
      },
      description: bundle.description,
    })),
  };
}

function claudeMarketplace(): unknown {
  return {
    name: FLEET_MARKETPLACE_NAME,
    description: "Fleet plugin marketplace",
    owner: {
      name: "Fleet",
    },
    plugins: PLUGIN_BUNDLES.map((bundle) => ({
      name: bundle.name,
      description: bundle.description,
      author: {
        name: "Fleet",
      },
      category: "development",
      source: marketplacePluginPath(bundle),
    })),
  };
}

function marketplacePluginPath(bundle: PluginBundle): string {
  return `./${PLUGIN_BUNDLES_DIR_NAME}/${bundle.directoryName}`;
}

function codexManifest(bundle: PluginBundle): unknown {
  return {
    name: bundle.name,
    version: "0.0.0",
    description: bundle.description,
    skills: "./skills/",
  };
}

function claudeManifest(bundle: PluginBundle): unknown {
  return {
    name: bundle.name,
    version: "0.0.0",
    description: bundle.description,
  };
}

function claudeHooks(options: CreateAgentCliPluginOptions): unknown {
  const hookExec = options.hookExec;
  if (!hookExec) {
    throw new Error("Fleet Claude session hook command is required");
  }
  return {
    hooks: {
      SessionStart: [{
        hooks: [{
          // exec form: command는 직접 spawn되는 실행 파일, args는 셸 토크나이징 없이 그대로 전달된다.
          // Windows cmd/powershell의 따옴표 규칙과 무관하게 동작하며 공백 포함 경로도 안전하다.
          args: [...hookExec.args],
          command: hookExec.command,
          type: "command",
        }],
      }],
    },
  };
}

function claudeAgentFile(subagent: CreateAgentCliPluginOptions["claudeDefinitions"][number]): string {
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
  // command.args는 Windows에서 cmd.exe 셸 래핑 인자(/d /s /c codex.cmd)를 담을 수 있으므로
  // 각 서브커맨드 인자 앞에 항상 보존한다. POSIX에서는 빈 배열이라 동작이 동일하다.
  const marketplaceList = runCommand({ ...command, args: [...command.args, "plugin", "marketplace", "list"] });
  assertCommandSucceeded("codex plugin marketplace list", marketplaceList);
  const marketplaces = findMarketplaceEntries(marketplaceList, registration.marketplaceName);
  const targetRoot = normalizeMarketplaceRoot(registration.marketplaceDir, command.cwd);
  const hasTargetMarketplace = marketplaces.some((entry) => normalizeMarketplaceRoot(entry.root, command.cwd) === targetRoot);
  const hasStaleMarketplace = marketplaces.some((entry) => normalizeMarketplaceRoot(entry.root, command.cwd) !== targetRoot);
  if (hasStaleMarketplace) {
    runCommand({
      ...command,
      args: [...command.args, "plugin", "marketplace", "remove", registration.marketplaceName],
    });
  }
  if (!hasTargetMarketplace || hasStaleMarketplace) {
    const addMarketplace = runCommand({
      ...command,
      args: [...command.args, "plugin", "marketplace", "add", registration.marketplaceDir],
    });
    assertCommandSucceeded("codex plugin marketplace add", addMarketplace);
  }

  const pluginList = runCommand({ ...command, args: [...command.args, "plugin", "list"] });
  assertCommandSucceeded("codex plugin list", pluginList);
  const installed = isCodexPluginInstalled(pluginList, registration.pluginName, registration.marketplaceName);
  const previousHash = readHash(registration.hashPath);
  if (installed && previousHash === registration.contentHash) {
    neutralizeCodexFleetPluginConfig({
      codexHome: resolveCodexHome(command.env),
      pluginKey: CODEX_FLEET_PLUGIN_KEY,
    });
    return;
  }

  const addPlugin = runCommand({
    ...command,
    args: [...command.args, "plugin", "add", registration.pluginName, "-m", registration.marketplaceName],
  });
  assertCommandSucceeded("codex plugin add", addPlugin);
  neutralizeCodexFleetPluginConfig({
    codexHome: resolveCodexHome(command.env),
    pluginKey: CODEX_FLEET_PLUGIN_KEY,
  });
  writePrivateFile(registration.hashPath, `${registration.contentHash}\n`, path.dirname(registration.hashPath));
}

function resolveCodexHome(env: Readonly<Record<string, string>>): string {
  return env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex");
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

function isCodexPluginInstalled(result: CodexCommandResult, pluginName: string, marketplaceName: string): boolean {
  const targetPlugin = `${pluginName}@${marketplaceName}`;
  return commandOutput(result).split(/\r?\n/).some((line) => {
    const [listedPlugin, status] = line.trim().split(/\s+/);
    return listedPlugin === targetPlugin && status?.startsWith("installed") === true;
  });
}

function commandOutput(result: CodexCommandResult): string {
  return [result.stdout, result.stderr].filter((entry) => entry.length > 0).join("\n");
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
