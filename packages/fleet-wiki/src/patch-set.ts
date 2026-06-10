import { mkdir } from "node:fs/promises";
import path from "node:path";

import { PATCH_META_FILENAME } from "./constants.js";
import { readJsonFile, writeJsonFile } from "./store.js";
import type { MemoryPaths, PatchSet } from "./types.js";

export const PATCH_SET_DIRNAME = "_sets";
export const PATCH_SET_META_FILENAME = PATCH_META_FILENAME;

export function getPatchSetDir(paths: MemoryPaths, patchSetId: string): string {
  assertSafePatchSetId(patchSetId);
  const patchSetDir = path.join(paths.queueDir, PATCH_SET_DIRNAME, patchSetId);
  const relative = path.relative(path.join(paths.queueDir, PATCH_SET_DIRNAME), patchSetDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`[fleet-wiki] patch set id escapes queue/_sets: ${patchSetId}`);
  }
  return patchSetDir;
}

export function getPatchSetMetaFile(paths: MemoryPaths, patchSetId: string): string {
  return path.join(getPatchSetDir(paths, patchSetId), PATCH_SET_META_FILENAME);
}

export function buildPatchSetId(createdAt: string, sourceRef: string): string {
  const compact = createdAt.replace(/[:.]/g, "-");
  const hash = Buffer.from(sourceRef).toString("hex").slice(0, 8) || "00000000";
  return `${compact}-${hash}`;
}

export async function writePatchSet(paths: MemoryPaths, patchSet: PatchSet): Promise<void> {
  await mkdir(getPatchSetDir(paths, patchSet.id), { recursive: true });
  const patchSetFile = getPatchSetMetaFile(paths, patchSet.id);
  await writeJsonFile(patchSetFile, patchSet satisfies PatchSet, paths);
}

export async function readPatchSet(paths: MemoryPaths, patchSetId: string): Promise<PatchSet> {
  const patchSet = await readJsonFile<PatchSet>(getPatchSetMetaFile(paths, patchSetId));
  assertSafePatchSetId(patchSet.id);
  return patchSet;
}

function assertSafePatchSetId(patchSetId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(patchSetId)) {
    throw new Error(`[fleet-wiki] unsafe patch set id: ${patchSetId}`);
  }
  if (patchSetId.includes("/") || patchSetId.includes("\\")) {
    throw new Error(`[fleet-wiki] unsafe patch set id: ${patchSetId}`);
  }
}
