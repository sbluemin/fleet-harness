import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { findWorkspaceDirectory } from "@dotobokuri/core-infra";
import { DEFAULT_CARRIER_COUNT } from "@dotobokuri/fleet-carriers";
import { createMemoryPaths } from "@dotobokuri/fleet-wiki";

export interface MissionControlCounts {
  readonly carriers: number;
  readonly queuedPatches: number;
  readonly wikiEntries: number;
}

export interface DiscoverMissionControlCountsOptions {
  readonly dataDir: string;
  readonly invocationCwd: string;
}

const WIKI_INDEX_FILENAME = "index.md";
const QUEUE_PATCH_FILENAME = "patch.md";

export function discoverMissionControlCounts(options: DiscoverMissionControlCountsOptions): MissionControlCounts {
  const workspace = findExistingWorkspace(options);
  if (!workspace) return emptyCounts();
  const paths = createMemoryPaths(join(workspace.path, "knowledge"));
  if (!isSafeDirectory(paths.root)) return emptyCounts();
  return {
    carriers: DEFAULT_CARRIER_COUNT,
    queuedPatches: countQueuedPatches(paths.queueDir),
    wikiEntries: countMarkdownFilesRecursively(paths.wikiDir, true),
  };
}

function findExistingWorkspace(options: DiscoverMissionControlCountsOptions) {
  try {
    return findWorkspaceDirectory(options.dataDir, options.invocationCwd);
  } catch {
    return null;
  }
}

function emptyCounts(): MissionControlCounts {
  return { carriers: DEFAULT_CARRIER_COUNT, queuedPatches: 0, wikiEntries: 0 };
}

function countQueuedPatches(queueDir: string): number {
  if (!isSafeDirectory(queueDir)) return 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(queueDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) {
      continue;
    }
    const patchPath = join(queueDir, entry.name, QUEUE_PATCH_FILENAME);
    if (isSafeFile(patchPath)) {
      count += 1;
    }
  }
  return count;
}

function countMarkdownFilesRecursively(dir: string, isWikiRoot: boolean): number {
  if (!isSafeDirectory(dir)) return 0;
  let count = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countMarkdownFilesRecursively(entryPath, false);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    if (isWikiRoot && entry.name === WIKI_INDEX_FILENAME) {
      continue;
    }
    count += 1;
  }
  return count;
}

function isSafeDirectory(target: string): boolean {
  try {
    const stat = lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeFile(target: string): boolean {
  try {
    const stat = lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
