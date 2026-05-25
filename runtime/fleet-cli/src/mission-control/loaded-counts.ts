import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { DEFAULT_CARRIER_PERSONAS } from "@dotobokuri/fleet-carriers";
import { resolveMemoryPaths } from "@dotobokuri/fleet-wiki";

export type FleetCliChannel = "stable" | "canary" | "local";

export interface FleetCliRelease {
  readonly channel: FleetCliChannel;
  readonly version: string;
}

export interface MissionControlCounts {
  readonly carriers: number;
  readonly queuedPatches: number;
  readonly wikiEntries: number;
}

export interface DiscoverMissionControlCountsOptions {
  readonly invocationCwd: string;
}

const WIKI_INDEX_FILENAME = "index.md";
const QUEUE_PATCH_FILENAME = "patch.md";

export function discoverMissionControlCounts(options: DiscoverMissionControlCountsOptions): MissionControlCounts {
  const paths = resolveMemoryPaths(options.invocationCwd);
  return {
    carriers: DEFAULT_CARRIER_PERSONAS.length,
    queuedPatches: countQueuedPatches(paths.queueDir),
    wikiEntries: countMarkdownFilesRecursively(paths.wikiDir, true),
  };
}

export function readFleetCliRelease(): FleetCliRelease {
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere("../../package.json") as { private?: boolean; version?: string };
  const version = pkg.version ?? "";
  if (pkg.private === true) {
    return { channel: "local", version };
  }
  return { channel: version.includes("-") ? "canary" : "stable", version };
}

function countQueuedPatches(queueDir: string): number {
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
    if (existsSync(patchPath) && statSync(patchPath).isFile()) {
      count += 1;
    }
  }
  return count;
}

function countMarkdownFilesRecursively(dir: string, isWikiRoot: boolean): number {
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
