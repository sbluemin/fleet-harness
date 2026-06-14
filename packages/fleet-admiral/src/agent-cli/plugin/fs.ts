import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensurePrivateDir(dirPath: string, rootBase: string = dirPath): void {
  const resolvedBase = ensureRootBase(rootBase);
  ensurePathWithinRoot(resolvedBase, dirPath);
  ensureDirectorySegments(resolvedBase, dirPath);
}

export function writePrivateJson(filePath: string, value: unknown, rootBase: string): void {
  writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`, rootBase);
}

export function writePrivateFile(filePath: string, content: string, rootBase: string): void {
  const resolvedBase = ensureRootBase(rootBase);
  ensurePathWithinRoot(resolvedBase, filePath);
  ensureDirectorySegments(resolvedBase, path.dirname(filePath));
  writeFileNoFollow(filePath, content);
  chmodBestEffort(filePath, FILE_MODE);
}

export function linkPrivateSymlink(linkPath: string, target: string, rootBase: string): void {
  // 사용자 .fleet 소스 심링크는 대상 내용을 복사하지 않고 managed tree 안에 심링크로 보존한다.
  // 링크 위치는 강화된 root 내부로 검증하고, 해소된 대상만 root 밖을 가리킬 수 있다.
  // 이는 사용자 제어 .fleet 소스를 통과시키기 위한 Admiral 승인 동작이다.
  const resolvedBase = ensureRootBase(rootBase);
  ensurePathWithinRoot(resolvedBase, linkPath);
  ensureDirectorySegments(resolvedBase, path.dirname(linkPath));
  symlinkSync(target, linkPath);
}

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

export function cleanupPrivateRoot(rootPath: string, rootBase?: string): void {
  try {
    if (rootBase !== undefined) {
      const resolvedBase = assertRootBaseSafe(rootBase);
      ensurePathWithinRoot(resolvedBase, rootPath);
      assertExistingSegmentsSafe(resolvedBase, rootPath);
    }
    const stat = lstatSync(rootPath);
    if (stat.isSymbolicLink()) return;
    rmSync(rootPath, { force: true, recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function chmodBestEffort(targetPath: string, mode: number): void {
  try {
    chmodSync(targetPath, mode);
  } catch (_error) {
    return;
  }
}

function writeFileNoFollow(filePath: string, content: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(filePath, flags, FILE_MODE);
  try {
    writeFileSync(fd, content, { encoding: "utf8" });
  } finally {
    closeSync(fd);
  }
}

function ensureRootBase(rootBase: string): string {
  const resolvedBase = path.resolve(rootBase);
  const anchor = findExistingDirectoryAnchor(path.dirname(resolvedBase));
  ensureDirectorySegments(anchor, resolvedBase);
  assertDirectorySafe(resolvedBase, "Plugin root base");
  return resolvedBase;
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

function ensureDirectorySegments(resolvedBase: string, dirPath: string): void {
  const target = path.resolve(dirPath);
  const relative = path.relative(resolvedBase, target);
  let current = resolvedBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Plugin path segment is a symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Plugin path segment is unsafe: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        mkdirSync(current, { mode: DIR_MODE });
        chmodBestEffort(current, DIR_MODE);
      } else {
        throw error;
      }
    }
    assertSegmentRealpathWithinRoot(resolvedBase, current);
  }
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
