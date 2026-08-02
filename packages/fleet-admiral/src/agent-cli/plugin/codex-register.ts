import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { neutralizeCodexFleetPluginConfig } from "./codex-config.js";
import { removePrivatePath, writePrivateFile } from "./fs.js";
import type {
  AgentCliPluginMarketplaceLock,
  CodexCommandResult,
  CodexCommandRunner,
  CodexPluginRegistration,
  CodexPluginRegistrationCommand,
} from "../types.js";

export interface DeprecatedCodexPluginCleanupTargets {
  readonly homeMarketplaceName: string;
  readonly homeMarketplaceRoot: string;
  readonly projectMarketplaceRoot: string;
}

const DEPRECATED_HOME_PLUGIN_NAME = "fleet-global";
const DEPRECATED_PROJECT_PLUGIN_NAME = "fleet-project";
const DEPRECATED_PROJECT_MARKETPLACE_NAME_PREFIX = "fleet-project-";
const FLAT_MARKETPLACE_FS_RESIDUE_ENTRIES = [".agents", ".claude-plugin", "plugin"] as const;

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

// 과거에 렌더되던 deprecated 번들(fleet-global / fleet-project)이 Codex 영속 설정에 남긴 등록과
// flat marketplace 파일시스템 잔재를 정리한다. 활성 'fleet' 코어 등록 경로는 절대 건드리지 않으며,
// 조회 결과가 비어 있으면 어떤 제거 명령도 발사하지 않아 매 launch idempotent하다. best-effort:
// Codex 명령 실패는 warning 문자열로 수렴해 launch를 막지 않는다.
export async function cleanupDeprecatedCodexPluginState(
  command: CodexPluginRegistrationCommand,
  runCommand: CodexCommandRunner,
  withMarketplaceLock: AgentCliPluginMarketplaceLock,
  targets: DeprecatedCodexPluginCleanupTargets,
): Promise<string | undefined> {
  try {
    const marketplaceList = runCommand({ ...command, args: [...command.args, "plugin", "marketplace", "list"] });
    assertCommandSucceeded("codex plugin marketplace list", marketplaceList);
    const pluginList = runCommand({ ...command, args: [...command.args, "plugin", "list"] });
    assertCommandSucceeded("codex plugin list", pluginList);

    // 홈 marketplace에는 활성 'fleet' 코어가 거주하므로 marketplace 자체는 보존하고 fleet-global plugin만 제거한다.
    if (isCodexPluginInstalled(pluginList, DEPRECATED_HOME_PLUGIN_NAME, targets.homeMarketplaceName)) {
      await withMarketplaceLock(targets.homeMarketplaceRoot, () => {
        const removed = runCommand({
          ...command,
          args: [...command.args, "plugin", "remove", DEPRECATED_HOME_PLUGIN_NAME, "-m", targets.homeMarketplaceName],
        });
        assertCommandSucceeded("codex plugin remove fleet-global", removed);
      });
    }

    // 현재 cwd의 .fleet을 root로 하는 fleet-project-* marketplace만 정리한다(hash 재계산 없이 root 동치로 식별).
    // 다른 프로젝트의 fleet-project-* marketplace는 root가 다르므로 건드리지 않는다.
    const projectTargetRoot = normalizeMarketplaceRoot(targets.projectMarketplaceRoot, command.cwd);
    const projectMarketplaces = parseMarketplaceEntries(marketplaceList).filter((entry) =>
      entry.name.startsWith(DEPRECATED_PROJECT_MARKETPLACE_NAME_PREFIX)
      && normalizeMarketplaceRoot(entry.root, command.cwd) === projectTargetRoot,
    );
    for (const marketplace of projectMarketplaces) {
      await withMarketplaceLock(targets.projectMarketplaceRoot, () => {
        if (isCodexPluginInstalled(pluginList, DEPRECATED_PROJECT_PLUGIN_NAME, marketplace.name)) {
          const removedPlugin = runCommand({
            ...command,
            args: [...command.args, "plugin", "remove", DEPRECATED_PROJECT_PLUGIN_NAME, "-m", marketplace.name],
          });
          assertCommandSucceeded("codex plugin remove fleet-project", removedPlugin);
        }
        const removedMarketplace = runCommand({
          ...command,
          args: [...command.args, "plugin", "marketplace", "remove", marketplace.name],
        });
        assertCommandSucceeded("codex plugin marketplace remove fleet-project", removedMarketplace);
        // marketplace 등록을 제거한 뒤에만 flat marketplace 파일시스템 잔재를 정리한다(메타데이터 선삭제로 깨진 marketplace를 남기지 않도록 순서 보장).
        removeFlatMarketplaceResidue(targets.projectMarketplaceRoot);
      });
    }
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
  return parseMarketplaceEntries(result).filter((entry) => entry.name === marketplaceName);
}

function parseMarketplaceEntries(
  result: CodexCommandResult,
): Array<{ readonly name: string; readonly root: string }> {
  const entries: Array<{ readonly name: string; readonly root: string }> = [];
  for (const line of commandOutput(result).split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+(.+)$/);
    if (match) {
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

function removeFlatMarketplaceResidue(projectMarketplaceRoot: string): void {
  for (const entry of FLAT_MARKETPLACE_FS_RESIDUE_ENTRIES) {
    removePrivatePath(path.join(projectMarketplaceRoot, entry), projectMarketplaceRoot);
  }
}
