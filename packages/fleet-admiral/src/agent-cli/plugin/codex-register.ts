import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { neutralizeCodexFleetPluginConfig } from "./codex-config.js";
import { writePrivateFile } from "./fs.js";
import type {
  AgentCliPluginMarketplaceLock,
  CodexCommandResult,
  CodexCommandRunner,
  CodexPluginRegistration,
  CodexPluginRegistrationCommand,
} from "./types.js";

export async function ensureCodexPluginRegistered(
  registration: CodexPluginRegistration,
  command: CodexPluginRegistrationCommand,
  runCommand: CodexCommandRunner,
  withMarketplaceLock: AgentCliPluginMarketplaceLock,
): Promise<string | undefined> {
  try {
    await withMarketplaceLock(registration.marketplaceDir, () => {
      ensureCodexPluginRegisteredOrThrow(registration, command, runCommand);
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function ensureCodexPluginRegisteredOrThrow(
  registration: CodexPluginRegistration,
  command: CodexPluginRegistrationCommand,
  runCommand: CodexCommandRunner,
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
  const pluginKey = `${registration.pluginName}@${registration.marketplaceName}`;
  if (installed && previousHash === registration.contentHash) {
    neutralizeCodexFleetPluginConfig({
      codexHome: resolveCodexHome(command.env),
      pluginKey,
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
    pluginKey,
  });
  writePrivateFile(registration.hashPath, `${registration.contentHash}\n`, path.dirname(registration.hashPath));
}

function assertCommandSucceeded(label: string, result: CodexCommandResult): void {
  if (result.status === 0) return;
  const detail = [result.stderr.trim(), result.stdout.trim()].filter((entry) => entry.length > 0).join("\n");
  throw new Error(`${label} failed${detail.length > 0 ? `: ${detail}` : ""}`);
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
