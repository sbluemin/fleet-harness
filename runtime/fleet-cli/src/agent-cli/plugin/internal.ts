import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { linkPrivateSymlink, writePrivateFile } from "./fs.js";
import type { AssetEntry, CopyDirectoryIntoPluginOptions } from "./types.js";

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

export function copyUserFleetSourcesIntoPlugin(sourceRoot: string, pluginRoot: string): void {
  copyDirectoryIntoPlugin(path.join(sourceRoot, "skills"), pluginRoot, "skills", { followSymlinks: true });
  copyDirectoryIntoPlugin(path.join(sourceRoot, "agents"), pluginRoot, "agents", { followSymlinks: true });
  copyDirectoryIntoPlugin(path.join(sourceRoot, "hooks"), pluginRoot, "hooks", { followSymlinks: true });
  copyOptionalFileIntoPlugin(path.join(sourceRoot, ".mcp.json"), path.join(pluginRoot, ".mcp.json"), pluginRoot, { followSymlinks: true });
}

function copyOptionalFileIntoPlugin(
  sourceFile: string,
  destPath: string,
  pluginRoot: string,
  options: CopyDirectoryIntoPluginOptions = {},
): void {
  const followSymlinks = options.followSymlinks === true;
  if (!existsSync(sourceFile)) return;
  const sourceStat = lstatSync(sourceFile);
  if (sourceStat.isSymbolicLink() && !followSymlinks) {
    throw new Error(`Fleet plugin source file is a symlink: ${sourceFile}`);
  }
  const resolvedStat = sourceStat.isSymbolicLink() ? statSync(sourceFile) : sourceStat;
  if (!resolvedStat.isFile()) {
    throw new Error(`Fleet plugin source path is not a file: ${sourceFile}`);
  }
  writePrivateFile(destPath, readFileSync(sourceFile, "utf8"), pluginRoot);
}

function listAssetEntries(rootPath: string, followSymlinks = false): AssetEntry[] {
  const entries: AssetEntry[] = [];
  collectAssetEntries(rootPath, rootPath, entries, followSymlinks);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
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
