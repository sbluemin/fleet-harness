import crypto from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assetBundle, renderAssetPluginRoot, validateClaudeAgentFileStems } from "./fleet.js";
import { globalBundle, globalFleetContentExists, renderGlobalPluginRoot } from "./fleet-global.js";
import { projectBundle, renderProjectPluginRoot, resolveProjectFleetRoot } from "./fleet-project.js";
import { ensurePrivateDir, removePrivatePath, writePrivateJson } from "./fs.js";
import type {
  AgentCliPlugin,
  CreateAgentCliPluginOptions,
  MarketplaceTarget,
  PluginBundle,
  RenderablePluginBundle,
} from "./types.js";

export { ensureCodexPluginRegistered } from "./codex-register.js";

export const CODEX_FLEET_PLUGIN_KEY = "fleet@fleet-harness";
export const FLEET_MARKETPLACE_NAME = "fleet-harness";

const FLEET_PROJECT_MARKETPLACE_NAME_PREFIX = "fleet-project";
const MARKETPLACE_DIR_NAME = "marketplace";
const FLAT_PLUGIN_DIR_NAME = "plugin";
const PLUGIN_BUNDLES_DIR_NAME = "plugins";
const PLUGIN_BUNDLES: readonly PluginBundle[] = [assetBundle, projectBundle, globalBundle];
const PLUGIN_MANAGED_ENTRIES = [
  ".codex-plugin",
  ".claude-plugin",
  ".mcp.json",
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
const FLAT_MARKETPLACE_MANAGED_ENTRIES = [
  ".agents",
  ".claude-plugin",
  "plugin",
] as const;
const HASH_IGNORED_RELATIVE_PATHS = new Set(PLUGIN_BUNDLES.map((bundle) => bundle.hashFileName));

export function createAgentCliPlugin(
  options: CreateAgentCliPluginOptions,
): AgentCliPlugin {
  const fleetRoot = options.rootDir ?? path.join(os.homedir(), ".fleet");
  const renderableBundles = resolveRenderablePluginBundles(options, fleetRoot);
  const marketplaceBundles = groupRenderableBundlesByMarketplace(renderableBundles);
  validateClaudeAgentFileStems(options.claudeDefinitions);
  for (const marketplace of marketplaceBundles) {
    ensurePrivateDir(marketplace.target.root, marketplace.target.root);
    renderMarketplaceRoot(marketplace.target, marketplace.bundles.map(({ bundle }) => bundle));
  }
  const pluginRoots = renderableBundles.map(({ bundle, target }) => {
    const pluginRoot = pluginRootForTarget(target, bundle);
    renderPluginRoot(pluginRoot, bundle, options, fleetRoot);
    return pluginRoot;
  });
  const contentHashes = new Map(marketplaceBundles.map(({ target }) => [target.root, buildContentHash(target)]));
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
        pluginRoot: pluginRoots[index]!,
      }))
      : [],
    pluginRoot: pluginRoots[0]!,
    pluginRoots,
  };
}

function resolveRenderablePluginBundles(
  options: CreateAgentCliPluginOptions,
  fleetRoot: string,
): readonly RenderablePluginBundle[] {
  const homeMarketplace = homeMarketplaceTarget(fleetRoot);
  let projectMarketplace: MarketplaceTarget | undefined;
  const renderableBundles: RenderablePluginBundle[] = [];
  for (const bundle of PLUGIN_BUNDLES) {
    switch (bundle.source) {
      case "project": {
        if (!existsSync(path.join(options.cwd, ".fleet"))) break;
        projectMarketplace ??= projectMarketplaceTarget(options.cwd);
        renderableBundles.push({ bundle, target: projectMarketplace });
        break;
      }
      case "global":
        if (globalFleetContentExists(fleetRoot)) {
          renderableBundles.push({ bundle, target: homeMarketplace });
        }
        break;
      default:
        renderableBundles.push({ bundle, target: homeMarketplace });
    }
  }
  return renderableBundles;
}

function homeMarketplaceTarget(fleetRoot: string): MarketplaceTarget {
  return {
    flat: false,
    name: FLEET_MARKETPLACE_NAME,
    root: path.join(fleetRoot, MARKETPLACE_DIR_NAME),
  };
}

function projectMarketplaceTarget(cwd: string): MarketplaceTarget {
  const projectFleetRoot = resolveProjectFleetRoot(cwd);
  const hash = crypto.createHash("sha256").update(path.resolve(cwd, ".fleet")).digest("hex").slice(0, 12);
  return {
    flat: true,
    name: `${FLEET_PROJECT_MARKETPLACE_NAME_PREFIX}-${hash}`,
    root: projectFleetRoot,
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
  fleetRoot: string,
): void {
  ensurePrivateDir(pluginRoot, pluginRoot);
  prunePluginRoot(pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), codexManifest(bundle), pluginRoot);
  writePrivateJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), claudeManifest(bundle), pluginRoot);
  switch (bundle.source) {
    case "asset":
      ensurePrivateDir(path.join(pluginRoot, "agents"), pluginRoot);
      ensurePrivateDir(path.join(pluginRoot, "skills"), pluginRoot);
      renderAssetPluginRoot(pluginRoot, bundle, options);
      return;
    case "project":
      renderProjectPluginRoot(pluginRoot, options);
      return;
    case "global":
      renderGlobalPluginRoot(pluginRoot, fleetRoot);
      return;
  }
}

function renderMarketplaceRoot(target: MarketplaceTarget, bundles: readonly PluginBundle[]): void {
  const marketplaceRoot = target.root;
  ensurePrivateDir(marketplaceRoot, marketplaceRoot);
  pruneMarketplaceRoot(target);
  writePrivateJson(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), codexMarketplace(target, bundles), marketplaceRoot);
  writePrivateJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), claudeMarketplace(target, bundles), marketplaceRoot);
}

function prunePluginRoot(pluginRoot: string): void {
  for (const entry of PLUGIN_MANAGED_ENTRIES) {
    removePrivatePath(path.join(pluginRoot, entry), pluginRoot);
  }
}

function pruneMarketplaceRoot(target: MarketplaceTarget): void {
  const entries = target.flat ? FLAT_MARKETPLACE_MANAGED_ENTRIES : MARKETPLACE_MANAGED_ENTRIES;
  for (const entry of entries) {
    removePrivatePath(path.join(target.root, entry), target.root);
  }
}

function buildContentHash(target: MarketplaceTarget): string {
  const hash = crypto.createHash("sha256");
  for (const filePath of listRenderableFiles(target)) {
    const relativePath = path.relative(target.root, filePath);
    hash.update(relativePath);
    hash.update("\0");
    const stat = lstatSync(filePath);
    hash.update(stat.isSymbolicLink() ? readlinkSync(filePath) : readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listRenderableFiles(target: MarketplaceTarget): string[] {
  const files: string[] = [];
  const entries = target.flat ? FLAT_MARKETPLACE_MANAGED_ENTRIES : MARKETPLACE_MANAGED_ENTRIES;
  for (const entry of entries) {
    const entryPath = path.join(target.root, entry);
    if (!existsSync(entryPath)) continue;
    collectRenderableFiles(target.root, entryPath, files);
  }
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

function pluginRootForTarget(target: MarketplaceTarget, bundle: PluginBundle): string {
  return target.flat
    ? path.join(target.root, FLAT_PLUGIN_DIR_NAME)
    : path.join(target.root, PLUGIN_BUNDLES_DIR_NAME, bundle.directoryName);
}

function marketplacePluginPath(target: MarketplaceTarget, bundle: PluginBundle): string {
  if (target.flat) return `./${FLAT_PLUGIN_DIR_NAME}`;
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
