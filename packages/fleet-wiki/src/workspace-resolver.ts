import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createMemoryPaths } from "./paths.js";
import type { MemoryPaths } from "./types.js";

export interface WikiWorkspace { readonly cwd: string; readonly path: string; }
export interface WikiWorkspaceResolverDependencies {
  ensureWorkspace(cwd: string): WikiWorkspace;
  withMigrationLock<T>(workspace: WikiWorkspace, operation: () => T): T;
}
export interface WikiWorkspaceResolver { resolve(cwd: string): MemoryPaths; }
interface WikiWorkspaceResolverTestHooks {
  beforeMigrationCommit?(): void;
  beforeCopyFile?(source: string, destination: string): void;
}
interface MigrationMarker { version: 1; outcome: "copied"; transactionId: string; completedAt: string; }

const STAGING_PREFIX = "knowledge.migrating-";
const MARKER_NAME = "knowledge.migrated.json";
const MARKER_TEMP_REGEXP = /^knowledge\.migrated\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;
const IGNORED_FSYNC_ERROR_CODES = new Set(["EPERM", "EINVAL", "ENOSYS"]);

/** Host-injected canonical-workspace gate; fleet-wiki intentionally knows no host package. */
export function createWikiWorkspaceResolver(deps: WikiWorkspaceResolverDependencies): WikiWorkspaceResolver {
  return createResolver(deps);
}

/** Test-only module seam; intentionally absent from the package-root barrel. */
export function createWikiWorkspaceResolverForTest(
  deps: WikiWorkspaceResolverDependencies,
  hooks: WikiWorkspaceResolverTestHooks,
): WikiWorkspaceResolver {
  return createResolver(deps, hooks);
}

function createResolver(
  deps: WikiWorkspaceResolverDependencies,
  hooks?: WikiWorkspaceResolverTestHooks,
): WikiWorkspaceResolver {
  return { resolve: (cwd) => {
    const workspace = deps.ensureWorkspace(cwd);
    return deps.withMigrationLock(workspace, () => resolveLocked(workspace, hooks));
  } };
}

function resolveLocked(workspace: WikiWorkspace, hooks?: WikiWorkspaceResolverTestHooks): MemoryPaths {
  const destination = path.join(workspace.path, "knowledge");
  const source = path.join(workspace.cwd, ".fleet", "knowledge");
  const markerPath = path.join(workspace.path, MARKER_NAME);
  const destinationState = inspectTree(destination, true);
  // Destination content wins before source or control state is inspected.
  if (destinationState === "content") return createMemoryPaths(destination);
  if (destinationState === "unsafe") throw new Error("Unsafe Fleet Wiki destination state");

  const marker = readMarker(markerPath);
  const stagingEntries = inspectReservedControlState(workspace.path);
  if (marker) {
    const staging = path.join(workspace.path, `${STAGING_PREFIX}${marker.transactionId}`);
    const stagingState = inspectTree(staging);
    if (stagingState === "content") {
      removeEmptyDirectories(destination);
      fs.renameSync(staging, destination);
      syncDirectory(workspace.path);
    } else if (stagingState !== "missing") throw new Error("Unsafe Fleet Wiki migration staging state");
    return createMemoryPaths(destination);
  }

  const sourceState = inspectTree(source);
  if (sourceState === "unsafe") throw new Error("Unsafe Fleet Wiki legacy source state");
  removePriorStaging(workspace.path, stagingEntries);
  if (sourceState !== "content") return createMemoryPaths(destination);
  removeEmptyDirectories(destination);
  const transactionId = randomUUID();
  const staging = path.join(workspace.path, `${STAGING_PREFIX}${transactionId}`);
  copyTree(source, staging, hooks);
  if (inspectTree(staging) !== "content") throw new Error("Invalid Fleet Wiki migration staging result");
  syncDirectory(staging);
  hooks?.beforeMigrationCommit?.();
  const rechecked = inspectTree(destination, true);
  if (rechecked === "content") throw new Error("Fleet Wiki destination race detected");
  if (rechecked === "unsafe") throw new Error("Unsafe Fleet Wiki destination race");
  writeAtomic(markerPath, `${JSON.stringify({ version: 1, outcome: "copied", transactionId, completedAt: new Date().toISOString() } satisfies MigrationMarker)}\n`);
  syncDirectory(workspace.path);
  removeEmptyDirectories(destination);
  fs.renameSync(staging, destination);
  syncDirectory(workspace.path);
  return createMemoryPaths(destination);
}

type TreeState = "missing" | "empty" | "content" | "unsafe";
function inspectTree(target: string, regularRootIsContent = false, treeRoot = target): TreeState {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  const nodeKind = classifyWikiWorkspaceNodeForTest(stat);
  if (nodeKind === "unsafe") return "unsafe";
  if (nodeKind === "file") return regularRootIsContent ? "content" : "unsafe";
  let content = false;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      if (readSafeFileSymlink(treeRoot, entryPath) === null) return "unsafe";
      content = true;
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) return "unsafe";
    if (entry.isFile()) content = true;
    if (entry.isDirectory()) {
      const nested = inspectTree(entryPath, false, treeRoot);
      if (nested === "unsafe") return "unsafe";
      if (nested === "content") content = true;
    }
  }
  return content ? "content" : "empty";
}

function readMarker(markerPath: string): MigrationMarker | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(markerPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe Fleet Wiki migration marker");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { throw new Error("Invalid Fleet Wiki migration marker"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Fleet Wiki migration marker");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.outcome !== "copied" || typeof record.transactionId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(record.transactionId) || typeof record.completedAt !== "string") throw new Error("Invalid Fleet Wiki migration marker");
  return record as unknown as MigrationMarker;
}

function copyTree(source: string, destination: string, hooks?: WikiWorkspaceResolverTestHooks, sourceRoot = source): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name); const to = path.join(destination, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = readSafeFileSymlink(sourceRoot, from);
      if (target === null) throw new Error("Unsafe Fleet Wiki legacy source state");
      fs.symlinkSync(target, to, "file");
      continue;
    }
    const nodeKind = classifyWikiWorkspaceNodeForTest(stat);
    if (nodeKind === "unsafe") throw new Error("Unsafe Fleet Wiki legacy source state");
    if (nodeKind === "directory") copyTree(from, to, hooks, sourceRoot);
    else { hooks?.beforeCopyFile?.(from, to); fs.copyFileSync(from, to); syncFile(to); }
  }
  syncDirectory(destination);
}

function readSafeFileSymlink(treeRoot: string, linkPath: string): string | null {
  const target = fs.readlinkSync(linkPath);
  if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) return null;
  const lexicalRoot = path.resolve(treeRoot);
  const lexicalTarget = path.resolve(path.dirname(linkPath), target);
  if (!isWithinRoot(lexicalRoot, lexicalTarget)) return null;
  let canonicalRoot: string;
  let canonicalTarget: string;
  let targetStat: fs.Stats;
  try {
    canonicalRoot = fs.realpathSync(treeRoot);
    canonicalTarget = fs.realpathSync(linkPath);
    targetStat = fs.statSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!isWithinRoot(canonicalRoot, canonicalTarget) || !targetStat.isFile()) return null;
  return target;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Test-only direct-module seam for the lstat branch; absent from the package-root barrel. */
export function classifyWikiWorkspaceNodeForTest(stat: fs.Stats): "file" | "directory" | "unsafe" {
  if (stat.isSymbolicLink()) return "unsafe";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "unsafe";
}

function removeEmptyDirectories(target: string): void {
  const state = inspectTree(target, true);
  if (state === "missing") return;
  if (state === "unsafe") throw new Error("Unsafe Fleet Wiki destination state");
  if (state === "empty") fs.rmSync(target, { recursive: true, force: false });
}

function removePriorStaging(workspacePath: string, stagingEntries: readonly string[]): void {
  for (const name of stagingEntries) fs.rmSync(path.join(workspacePath, name), { recursive: true, force: false });
}

function inspectReservedControlState(workspacePath: string): string[] {
  const stagingEntries: string[] = [];
  for (const entry of fs.readdirSync(workspacePath, { withFileTypes: true })) {
    if (entry.name.startsWith(`${MARKER_NAME}.`)) {
      const residuePath = path.join(workspacePath, entry.name);
      const residue = fs.lstatSync(residuePath);
      if (MARKER_TEMP_REGEXP.test(entry.name) && residue.isFile() && !residue.isSymbolicLink()) {
        fs.unlinkSync(residuePath);
        continue;
      }
      throw new Error("Unsafe Fleet Wiki migration marker control state");
    }
    if (!entry.name.startsWith(STAGING_PREFIX)) continue;
    if (!/^[0-9a-f-]{36}$/i.test(entry.name.slice(STAGING_PREFIX.length)) || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe Fleet Wiki migration staging state");
    if (inspectTree(path.join(workspacePath, entry.name)) === "unsafe") throw new Error("Unsafe Fleet Wiki migration staging state");
    stagingEntries.push(entry.name);
  }
  return stagingEntries;
}

function writeAtomic(target: string, contents: string): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  syncFile(temporary);
  fs.renameSync(temporary, target);
}
function fsyncBestEffort(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code !== "string" || !IGNORED_FSYNC_ERROR_CODES.has(code)) throw error;
  }
}

function syncFile(target: string): void { const fd = fs.openSync(target, "r"); try { fsyncBestEffort(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(target: string): void {
  if (!shouldSyncDirectoryForTest(process.platform)) return;
  const fd = fs.openSync(target, "r"); try { fsyncBestEffort(fd); } finally { fs.closeSync(fd); }
}

/** Test-only direct-module seam for the platform-specific directory fsync policy; absent from the package-root barrel. */
export function shouldSyncDirectoryForTest(platform: NodeJS.Platform): boolean { return platform !== "win32"; }
