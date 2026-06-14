import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { linkPrivateSymlink, writePrivateFile } from "./fs.js";
import type { AssetEntry, CopyDirectoryIntoPluginOptions } from "./types.js";

type UserFleetSourceEntry =
  | { readonly kind: "directory"; readonly sourcePath: string; readonly pluginRelative: "agents" | "hooks" | "skills" }
  | { readonly kind: "file"; readonly sourcePath: string; readonly pluginRelative: ".mcp.json" };

export function copyDirectoryIntoPlugin(
  sourceDir: string,
  pluginRoot: string,
  pluginRelative: string,
  options: CopyDirectoryIntoPluginOptions = {},
): void {
  const followSymlinks = options.followSymlinks === true;
  if (!existsSync(sourceDir)) {
    if (options.required === true) {
      throw new Error(`Failed to read Fleet plugin skills directory ${options.label ?? sourceDir}: directory is missing`);
    }
    return;
  }
  const sourceStat = lstatSync(sourceDir);
  if (sourceStat.isSymbolicLink() && !followSymlinks) {
    throw new Error(`Fleet plugin source directory is a symlink: ${sourceDir}`);
  }
  const resolvedStat = sourceStat.isSymbolicLink() ? statSync(sourceDir) : sourceStat;
  if (!resolvedStat.isDirectory()) {
    if (options.required === true) {
      throw new Error(`Failed to read Fleet plugin skills directory ${options.label ?? sourceDir}: not a directory`);
    }
    throw new Error(`Fleet plugin source path is not a directory: ${sourceDir}`);
  }
  for (const entry of listAssetEntries(sourceDir, followSymlinks)) {
    const destPath = path.join(pluginRoot, pluginRelative, entry.relativePath);
    if (entry.kind === "symlink") {
      linkPrivateSymlink(destPath, entry.target, pluginRoot);
      continue;
    }
    writePrivateFile(destPath, readFileSync(path.join(sourceDir, entry.relativePath), "utf8"), pluginRoot);
  }
}

export function linkUserFleetSourcesIntoPlugin(sourceRoot: string, pluginRoot: string): void {
  const entries = listUserFleetSourceEntries(sourceRoot);
  for (const entry of entries) {
    linkPrivateSymlink(path.join(pluginRoot, entry.pluginRelative), entry.sourcePath, pluginRoot);
  }
}

function listAssetEntries(rootPath: string, followSymlinks = false): AssetEntry[] {
  const entries: AssetEntry[] = [];
  collectAssetEntries(rootPath, rootPath, entries, followSymlinks);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function listUserFleetSourceEntries(sourceRoot: string): UserFleetSourceEntry[] {
  const entries: UserFleetSourceEntry[] = [];
  for (const pluginRelative of ["skills", "agents", "hooks"] as const) {
    const sourcePath = path.join(sourceRoot, pluginRelative);
    if (!existsSync(sourcePath)) continue;
    const resolvedStat = statSync(sourcePath);
    if (!resolvedStat.isDirectory()) {
      throw new Error(`Fleet plugin source path is not a directory: ${sourcePath}`);
    }
    entries.push({ kind: "directory", pluginRelative, sourcePath });
  }
  const mcpPath = path.join(sourceRoot, ".mcp.json");
  if (existsSync(mcpPath)) {
    const resolvedStat = statSync(mcpPath);
    if (!resolvedStat.isFile()) {
      throw new Error(`Fleet plugin source path is not a file: ${mcpPath}`);
    }
    entries.push({ kind: "file", pluginRelative: ".mcp.json", sourcePath: mcpPath });
  }
  return entries;
}

function collectAssetEntries(
  rootPath: string,
  currentPath: string,
  entries: AssetEntry[],
  followSymlinks: boolean,
): void {
  for (const entry of readdirSync(currentPath)) {
    const entryPath = path.join(currentPath, entry);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      if (!followSymlinks) {
        throw new Error(`Fleet plugin asset symlink is unsupported: ${path.relative(rootPath, entryPath)}`);
      }
      const target = resolveSymlinkTarget(entryPath);
      if (target === undefined) continue;
      entries.push({ kind: "symlink", relativePath: path.relative(rootPath, entryPath), target });
      continue;
    }
    if (stat.isDirectory()) {
      collectAssetEntries(rootPath, entryPath, entries, followSymlinks);
      continue;
    }
    if (stat.isFile()) {
      entries.push({ kind: "file", relativePath: path.relative(rootPath, entryPath) });
    }
  }
}

function resolveSymlinkTarget(entryPath: string): string | undefined {
  try {
    return realpathSync(entryPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}
