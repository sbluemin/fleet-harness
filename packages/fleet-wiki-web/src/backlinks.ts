import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  extractLegacyMarkdownWikiLinks,
  extractMarkdownLinkTargets,
  extractWikiLinks,
  listWiki,
} from "@sbluemin/fleet-wiki";
import type { MemoryPaths } from "@sbluemin/fleet-wiki";

export interface Backlink {
  id: string;
  title: string;
  occurrences: number;
}

interface BacklinkCache {
  fingerprint: string;
  byTargetId: Map<string, Backlink[]>;
}

interface WikiFileSnapshot {
  id: string;
  title: string;
  filePath: string;
  body: string;
  mtimeMs: number;
}

let cache: BacklinkCache | null = null;

export { extractMarkdownLinkTargets };

export async function getBacklinks(id: string, paths: MemoryPaths): Promise<Backlink[]> {
  const snapshots = await readWikiSnapshots(paths);
  const fingerprint = snapshots.map((item) => `${item.id}:${item.mtimeMs}`).join("|");
  if (!cache || cache.fingerprint !== fingerprint) {
    cache = {
      fingerprint,
      byTargetId: buildBacklinkMap(snapshots, paths),
    };
  }
  return cache.byTargetId.get(id) ?? [];
}

async function readWikiSnapshots(paths: MemoryPaths): Promise<WikiFileSnapshot[]> {
  const entries = await listWiki(paths);
  const files = await listMarkdownFiles(paths.wikiDir);
  const fileById = new Map(files.map((filePath) => [path.basename(filePath, ".md"), filePath]));
  const snapshots: WikiFileSnapshot[] = [];

  for (const entry of entries) {
    const filePath = fileById.get(entry.id) ?? path.join(paths.wikiDir, `${entry.id}.md`);
    const fileStat = await stat(filePath);
    snapshots.push({
      id: entry.id,
      title: entry.title,
      filePath,
      body: entry.body,
      mtimeMs: fileStat.mtimeMs,
    });
  }
  return snapshots;
}

async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(filePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(filePath);
    }
  }
  return files;
}

function buildBacklinkMap(snapshots: WikiFileSnapshot[], paths: MemoryPaths): Map<string, Backlink[]> {
  const titles = new Map(snapshots.map((item) => [item.id, item.title]));
  const counts = new Map<string, Map<string, number>>();

  for (const source of snapshots) {
    const targetIds = [
      ...extractWikiLinks(source.body),
      ...extractLegacyMarkdownWikiLinks(source.body, paths.wikiDir, source.filePath).map((link) => link.entryId),
    ];
    for (const targetId of targetIds) {
      if (!targetId || targetId === source.id) continue;
      const sourceCounts = counts.get(targetId) ?? new Map<string, number>();
      sourceCounts.set(source.id, (sourceCounts.get(source.id) ?? 0) + 1);
      counts.set(targetId, sourceCounts);
    }
  }

  const backlinks = new Map<string, Backlink[]>();
  for (const [targetId, sourceCounts] of counts) {
    backlinks.set(
      targetId,
      [...sourceCounts.entries()]
        .map(([sourceId, occurrences]) => ({
          id: sourceId,
          title: titles.get(sourceId) ?? sourceId,
          occurrences,
        }))
        .sort((left, right) => right.occurrences - left.occurrences || left.id.localeCompare(right.id)),
    );
  }
  return backlinks;
}
