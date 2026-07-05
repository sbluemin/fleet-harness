import crypto from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import { getFleetDataDir } from "@dotobokuri/core-infra/data-dir";

import { assetBundle, renderAssetPluginRoot } from "./fleet.js";
import { cleanupPrivateRoot, ensurePrivateDir, removePrivatePath, writePrivateJson } from "./fs.js";
import type {
  AgentCliPlugin,
  CreateAgentCliPluginOptions,
  MarketplaceTarget,
  PluginBundle,
  RenderablePluginBundle,
} from "./types.js";

export { cleanupDeprecatedCodexPluginState, ensureCodexPluginRegistered } from "./codex-register.js";
export type { DeprecatedCodexPluginCleanupTargets } from "./codex-register.js";
export type {
  AgentCliPlugin,
  AgentCliPluginMarketplaceLock,
  CodexCommandResult,
  CodexCommandRunner,
  CodexPluginRegistration,
  CodexPluginRegistrationCommand,
  CreateAgentCliPluginOptions,
} from "./types.js";

export const FLEET_MARKETPLACE_NAME = "fleet-harness";

const MARKETPLACE_DIR_NAME = "marketplace";
const PLUGIN_BUNDLES_DIR_NAME = "plugins";
const PLUGIN_BUNDLES: readonly PluginBundle[] = [assetBundle];
const MARKETPLACE_MANAGED_ENTRIES = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
  "hooks",
  "skills",
  "agents",
  "mcp.json",
  "claude",
  "codex-marketplace",
  "plugins",
] as const;
const MARKETPLACE_PRUNE_ENTRIES = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
  "hooks",
  "skills",
  "agents",
  "mcp.json",
  "claude",
  "codex-marketplace",
] as const;
const HASH_IGNORED_RELATIVE_PATHS = new Set(PLUGIN_BUNDLES.map((bundle) => bundle.hashFileName));

export async function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): Promise<AgentCliPlugin> {
  const fleetRoot = options.rootDir ?? options.dataDir ?? getFleetDataDir();
  const renderableBundles = resolveRenderablePluginBundles(fleetRoot);
  const marketplaceBundles = groupRenderableBundlesByMarketplace(renderableBundles);
  const pluginRoots = new Map<PluginBundle, string>();
  const contentHashes = new Map<string, string>();
  for (const marketplace of marketplaceBundles) {
    await options.withMarketplaceLock(marketplace.target.root, () => {
      for (const { bundle, target } of marketplace.bundles) {
        const pluginRoot = pluginRootForTarget(target, bundle);
        renderPluginRoot(pluginRoot, bundle, options);
        pluginRoots.set(bundle, pluginRoot);
      }
      renderMarketplaceRoot(marketplace.target, marketplace.bundles.map(({ bundle }) => bundle));
      contentHashes.set(marketplace.target.root, buildContentHash(marketplace.target));
    });
  }
  const resolvedPluginRoots = renderableBundles.map(({ bundle }) => pluginRoots.get(bundle)!);
  const cleanup = (): void => {};
  options.onCleanup?.(cleanup);
  return {
    cleanup,
    codexRegistrations: options.cliId === "codex"
      ? renderableBundles.map(({ bundle, target }, index) => ({
        contentHash: contentHashes.get(target.root)!,
        hashPath: path.join(target.root, bundle.hashFileName),
        marketplaceDir: target.root,
        marketplaceName: target.name,
        pluginName: bundle.name,
        pluginRoot: resolvedPluginRoots[index]!,
      }))
      : [],
    pluginRoot: resolvedPluginRoots[0]!,
    pluginRoots: resolvedPluginRoots,
  };
}

function resolveRenderablePluginBundles(
  fleetRoot: string,
): readonly RenderablePluginBundle[] {
  const homeMarketplace = homeMarketplaceTarget(fleetRoot);
  return PLUGIN_BUNDLES.map((bundle) => ({ bundle, target: homeMarketplace }));
}

function homeMarketplaceTarget(fleetRoot: string): MarketplaceTarget {
  return {
    name: FLEET_MARKETPLACE_NAME,
    root: path.join(fleetRoot, MARKETPLACE_DIR_NAME),
  };
}

function groupRenderableBundlesByMarketplace(
  bundles: readonly RenderablePluginBundle[],
): Array<{ readonly target: MarketplaceTarget; readonly bundles: RenderablePluginBundle[] }> {
  const groups: Array<{ readonly target: MarketplaceTarget; readonly bundles: RenderablePluginBundle[] }> = [];
  for (const entry of bundles) {
    const group = groups.find(({ target }) => target.root === entry.target.root);
    if (group) {
      group.bundles.push(entry);
      continue;
    }
    groups.push({ target: entry.target, bundles: [entry] });
  }
  return groups;
}

function renderPluginRoot(
  pluginRoot: string,
  bundle: PluginBundle,
  options: CreateAgentCliPluginOptions,
): void {
  const parentRoot = path.dirname(pluginRoot);
  ensurePrivateDir(parentRoot, parentRoot);
  const stageParent = createStagingDir(parentRoot);
  const stagedPluginRoot = path.join(stageParent, path.basename(pluginRoot));
  try {
    ensurePrivateDir(stagedPluginRoot, stagedPluginRoot);
    writePrivateJson(path.join(stagedPluginRoot, ".claude-plugin", "plugin.json"), claudeManifest(bundle), stagedPluginRoot);
    switch (bundle.source) {
      case "asset":
        if (options.cliId === "claude") {
          ensurePrivateDir(path.join(stagedPluginRoot, "agents"), stagedPluginRoot);
        }
        ensurePrivateDir(path.join(stagedPluginRoot, "skills"), stagedPluginRoot);
        renderAssetPluginRoot(stagedPluginRoot, bundle, options);
        break;
    }
    writePrivateJson(path.join(stagedPluginRoot, ".codex-plugin", "plugin.json"), codexManifest(bundle, stagedPluginRoot), stagedPluginRoot);
    writePrivateJson(path.join(stagedPluginRoot, ".cursor-plugin", "plugin.json"), cursorManifest(bundle, stagedPluginRoot), stagedPluginRoot);
    removePrivatePath(pluginRoot, parentRoot);
    renameSync(stagedPluginRoot, pluginRoot);
  } finally {
    cleanupPrivateRoot(stageParent, parentRoot);
  }
}

function renderMarketplaceRoot(target: MarketplaceTarget, bundles: readonly PluginBundle[]): void {
  const marketplaceRoot = target.root;
  ensurePrivateDir(marketplaceRoot, marketplaceRoot);
  const stagedRoot = createStagingDir(marketplaceRoot);
  try {
    writePrivateJson(path.join(stagedRoot, ".agents", "plugins", "marketplace.json"), codexMarketplace(target, bundles), stagedRoot);
    writePrivateJson(path.join(stagedRoot, ".claude-plugin", "marketplace.json"), claudeMarketplace(target, bundles), stagedRoot);
    writePrivateJson(path.join(stagedRoot, ".cursor-plugin", "marketplace.json"), cursorMarketplace(target, bundles), stagedRoot);
    pruneMarketplaceRoot(target);
    pruneStalePluginDirs(target, bundles);
    for (const entry of readdirSync(stagedRoot)) {
      renameSync(path.join(stagedRoot, entry), path.join(marketplaceRoot, entry));
    }
  } finally {
    cleanupPrivateRoot(stagedRoot, marketplaceRoot);
  }
}

function pruneMarketplaceRoot(target: MarketplaceTarget): void {
  for (const entry of MARKETPLACE_PRUNE_ENTRIES) {
    removePrivatePath(path.join(target.root, entry), target.root);
  }
}

// 이번 렌더에 포함되지 않은 번들의 잔재 디렉터리(예: 과거에 렌더된 fleet-global)를 plugins/ 아래에서 제거한다.
// 제거된 번들의 stale 디렉터리가 marketplace 콘텐츠 해시에 섞여 불필요한 재등록을 유발하는 것을 막는다.
function pruneStalePluginDirs(target: MarketplaceTarget, bundles: readonly PluginBundle[]): void {
  const pluginsDir = path.join(target.root, PLUGIN_BUNDLES_DIR_NAME);
  if (!existsSync(pluginsDir)) return;
  const activeDirectoryNames = new Set(bundles.map((bundle) => bundle.directoryName));
  for (const entry of readdirSync(pluginsDir)) {
    if (activeDirectoryNames.has(entry)) continue;
    removePrivatePath(path.join(pluginsDir, entry), target.root);
  }
}

function buildContentHash(target: MarketplaceTarget): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listRenderableFiles(target)) {
    const relativePath = path.relative(target.root, filePath);
    hash.update(relativePath);
    hash.update("\0");
    // 심볼릭 링크는 타깃 경로가 아니라 링크가 가리키는 실제 파일 내용을 해시한다.
    // (readFileSync는 링크를 따라가 원본 내용을 읽으므로 .fleet 소스 내용 변경이 해시에 반영된다.)
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function createStagingDir(rootPath: string): string {
  const stageRoot = mkdtempSync(path.join(rootPath, `.fleet-stage-${process.pid}-${Date.now()}-`));
  return stageRoot;
}

function listRenderableFiles(target: MarketplaceTarget): string[] {
  const files: string[] = [];
  const ancestorRealDirs = new Set<string>();
  for (const entry of MARKETPLACE_MANAGED_ENTRIES) {
    const entryPath = path.join(target.root, entry);
    if (!existsSync(entryPath)) continue;
    collectRenderableFiles(target.root, entryPath, files, ancestorRealDirs);
  }
  return files.sort();
}

function collectRenderableFiles(
  rootPath: string,
  currentPath: string,
  files: string[],
  ancestorRealDirs: Set<string>,
): void {
  // 현재 하강 경로의 조상(ancestor) 기준으로만 순환 심볼릭 링크를 차단한다.
  // 전역 누적 집합이 아니라 조상 집합을 사용하므로, 같은 실제 디렉터리를 가리키는
  // 별개의 논리 경로(예: 서로 다른 엔트리가 같은 타깃으로 링크된 경우)는 각각 해시에 반영된다.
  const realDir = realpathSync(currentPath);
  if (ancestorRealDirs.has(realDir)) return;
  ancestorRealDirs.add(realDir);
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const relativePath = path.relative(rootPath, entryPath);
    if (HASH_IGNORED_RELATIVE_PATHS.has(relativePath)) continue;
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      collectSymlinkedRenderable(rootPath, entryPath, files, ancestorRealDirs);
      continue;
    }
    if (stat.isDirectory()) {
      collectRenderableFiles(rootPath, entryPath, files, ancestorRealDirs);
      continue;
    }
    if (stat.isFile()) {
      files.push(entryPath);
    }
  }
  // 백트랙: 형제·다른 엔트리가 같은 타깃을 공유해도 방문할 수 있도록 조상에서 제거한다.
  ancestorRealDirs.delete(realDir);
}

function collectSymlinkedRenderable(
  rootPath: string,
  entryPath: string,
  files: string[],
  ancestorRealDirs: Set<string>,
): void {
  // 링크가 가리키는 실제 대상의 종류를 확인한다. 끊어진(dangling) 링크는 건너뛴다.
  let resolvedStat;
  try {
    resolvedStat = statSync(entryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
    throw error;
  }
  if (resolvedStat.isDirectory()) {
    // 디렉터리 링크는 따라 들어가 내부 파일 내용을 해시 대상으로 수집한다.
    collectRenderableFiles(rootPath, entryPath, files, ancestorRealDirs);
    return;
  }
  if (resolvedStat.isFile()) {
    files.push(entryPath);
  }
}

function codexMarketplace(target: MarketplaceTarget, bundles: readonly PluginBundle[]): unknown {
  return {
    name: target.name,
    plugins: bundles.map((bundle) => ({
      name: bundle.name,
      displayName: bundle.displayName,
      source: {
        source: "local",
        path: marketplacePluginPath(target, bundle),
      },
      description: bundle.description,
    })),
  };
}

function claudeMarketplace(target: MarketplaceTarget, bundles: readonly PluginBundle[]): unknown {
  return {
    name: target.name,
    description: "Fleet plugin marketplace",
    owner: {
      name: "Fleet",
    },
    plugins: bundles.map((bundle) => ({
      name: bundle.name,
      description: bundle.description,
      author: {
        name: "Fleet",
      },
      category: "development",
      source: marketplacePluginPath(target, bundle),
    })),
  };
}

function cursorMarketplace(target: MarketplaceTarget, bundles: readonly PluginBundle[]): unknown {
  return {
    name: target.name,
    owner: "fleet",
    plugins: bundles.map((bundle) => ({
      name: bundle.name,
      description: bundle.description,
      source: marketplacePluginPath(target, bundle),
    })),
  };
}

function pluginRootForTarget(target: MarketplaceTarget, bundle: PluginBundle): string {
  return path.join(target.root, PLUGIN_BUNDLES_DIR_NAME, bundle.directoryName);
}

function marketplacePluginPath(target: MarketplaceTarget, bundle: PluginBundle): string {
  return `./${PLUGIN_BUNDLES_DIR_NAME}/${bundle.directoryName}`;
}

function codexManifest(bundle: PluginBundle, pluginRoot: string): unknown {
  return {
    name: bundle.name,
    version: codexManifestVersion(bundle, pluginRoot),
    description: bundle.description,
    skills: "./skills/",
  };
}

function cursorManifest(bundle: PluginBundle, pluginRoot: string): unknown {
  return {
    name: bundle.name,
    version: cursorManifestVersion(bundle, pluginRoot),
    description: bundle.description,
  };
}

function cursorManifestVersion(bundle: PluginBundle, pluginRoot: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(bundle.name);
  hash.update("\0");
  hash.update(bundle.description);
  hash.update("\0");
  for (const filePath of listCursorEffectivePluginFiles(pluginRoot)) {
    const relativePath = path.relative(pluginRoot, filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return `0.0.0+${hash.digest("hex").slice(0, 12)}`;
}

function codexManifestVersion(bundle: PluginBundle, pluginRoot: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(bundle.name);
  hash.update("\0");
  hash.update(bundle.description);
  hash.update("\0");
  for (const filePath of listCodexEffectivePluginFiles(pluginRoot)) {
    const relativePath = path.relative(pluginRoot, filePath);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }
  return `0.0.0+${hash.digest("hex").slice(0, 12)}`;
}

function listCodexEffectivePluginFiles(pluginRoot: string): string[] {
  const skillsPath = path.join(pluginRoot, "skills");
  if (!existsSync(skillsPath)) return [];
  const files: string[] = [];
  collectRenderableFiles(pluginRoot, skillsPath, files, new Set());
  return files.sort();
}

function listCursorEffectivePluginFiles(pluginRoot: string): string[] {
  const files: string[] = [];
  // mcp.json에는 세션별 bearer 토큰이 들어가므로 의도적으로 해시에 포함한다.
  // Cursor가 새 세션마다 최신 MCP 토큰을 재적재하도록 플러그인 버전을 갱신한다.
  for (const entry of ["skills", "rules", "hooks", "mcp.json"]) {
    const entryPath = path.join(pluginRoot, entry);
    if (!existsSync(entryPath)) continue;
    const stat = lstatSync(entryPath);
    if (stat.isFile()) {
      files.push(entryPath);
      continue;
    }
    if (stat.isDirectory()) {
      collectRenderableFiles(pluginRoot, entryPath, files, new Set());
    }
  }
  return files.sort();
}

function claudeManifest(bundle: PluginBundle): unknown {
  return {
    name: bundle.name,
    version: "0.0.0",
    description: bundle.description,
  };
}
