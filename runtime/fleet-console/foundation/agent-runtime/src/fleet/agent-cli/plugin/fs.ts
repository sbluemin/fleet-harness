import { lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

export function removePrivatePath(targetPath: string, rootBase: string): void {
  const resolvedBase = assertRootBaseSafe(rootBase);
  ensurePathWithinRoot(resolvedBase, targetPath);
  try {
    assertExistingParentSegmentsSafe(resolvedBase, targetPath);
    rmSync(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function assertRootBaseSafe(rootBase: string): string {
  const resolvedBase = path.resolve(rootBase);
  assertExistingSegmentsSafe(findExistingDirectoryAnchor(path.dirname(resolvedBase)), resolvedBase);
  assertDirectorySafe(resolvedBase, "Plugin root base");
  return resolvedBase;
}

function findExistingDirectoryAnchor(targetPath: string): string {
  const resolvedTarget = path.resolve(targetPath);
  let current = resolvedTarget;
  while (true) {
    try {
      assertDirectorySafe(current, "Plugin path anchor");
      return current;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) throw error;
        current = parent;
        continue;
      }
      throw error;
    }
  }
}

function assertDirectorySafe(dirPath: string, label: string): void {
  const stat = lstatSync(dirPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symlink: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is unsafe: ${dirPath}`);
  }
}

function ensurePathWithinRoot(resolvedBase: string, candidatePath: string): void {
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Plugin path escapes root base: ${candidatePath}`);
}

function assertExistingSegmentsSafe(resolvedBase: string, targetPath: string): void {
  const target = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, target);
  let current = resolvedBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin path segment is a symlink: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Plugin path segment is unsafe: ${current}`);
    }
    assertSegmentRealpathWithinRoot(resolvedBase, current);
  }
}

function assertExistingParentSegmentsSafe(resolvedBase: string, targetPath: string): void {
  assertExistingSegmentsSafe(resolvedBase, path.dirname(targetPath));
}

function assertSegmentRealpathWithinRoot(resolvedBase: string, segmentPath: string): void {
  const baseRealpath = realpathSync(resolvedBase);
  const segmentRealpath = realpathSync(segmentPath);
  const relative = path.relative(baseRealpath, segmentRealpath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Plugin path segment escapes root base: ${segmentPath}`);
}
