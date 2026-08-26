import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { assertWithinRoot, NOFOLLOW_FLAG } from "@dotobokuri/core-infra/fs-store";

import type { Scope, SkillPackageFile, SkillPackageManifest } from "./skill-types.js";

const MAX_DEPTH = 4;
const MAX_ENTRIES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx", ".xml",
]);
const TEXT_EXTENSIONS = new Set([".json", ".txt", ".yaml", ".yml", ".toml"]);

interface ValidatedSkillRoot {
  readonly realAllowedRoot: string;
  readonly realRoot: string;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function classifyFile(relativePath: string, size: number): Pick<SkillPackageFile, "role" | "format" | "readable"> {
  const parts = relativePath.split("/");
  const top = parts[0]?.toLocaleLowerCase();
  const extension = path.posix.extname(relativePath).toLocaleLowerCase();
  const role = relativePath === "SKILL.md"
    ? "entry"
    : top === "references" || top === "reference"
      ? "reference"
      : top === "scripts" || top === "script"
        ? "script"
        : top === "assets" || top === "asset"
          ? "asset"
          : "file";
  const format = extension === ".md"
    ? "markdown"
    : CODE_EXTENSIONS.has(extension)
      ? "code"
      : TEXT_EXTENSIONS.has(extension)
        ? "text"
        : "unsupported";
  return { role, format, readable: format !== "unsupported" && size <= MAX_FILE_BYTES };
}

export async function validateSkillRoot(skillRoot: string, allowedRoot: string): Promise<ValidatedSkillRoot> {
  const [realAllowedRoot, realRoot] = await Promise.all([
    fs.realpath(allowedRoot),
    fs.realpath(skillRoot),
  ]);
  try {
    assertWithinRoot(realAllowedRoot, realRoot);
  } catch {
    throw new Error("path_outside_scope");
  }
  return { realAllowedRoot, realRoot };
}

export async function buildSkillDisplayPath(
  skillRoot: string,
  allowedRoot: string,
  scope: Scope,
): Promise<string | undefined> {
  try {
    const { realAllowedRoot, realRoot } = await validateSkillRoot(skillRoot, allowedRoot);
    const relative = path.relative(realAllowedRoot, realRoot);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const displayRelative = toPosix(relative);
    return scope === "global" ? `~/${displayRelative}` : displayRelative;
  } catch {
    return undefined;
  }
}

export async function inspectSkillPackage(
  skillRoot: string,
  allowedRoot: string,
): Promise<SkillPackageManifest> {
  const { realRoot } = await validateSkillRoot(skillRoot, allowedRoot);
  const files: SkillPackageFile[] = [];
  const folders = new Set<string>();
  let totalBytes = 0;
  let omittedSymlinks = 0;
  let visitedEntries = 0;
  let truncated = false;

  const walk = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (truncated) return;
    const dir = await fs.opendir(directory);
    for await (const entry of dir) {
      // 숨김 항목도 inspection 비용이므로 cap에 포함한다. 그렇지 않으면 수십만 hidden entry가
      // 200개 예산 밖에서 readdir/정렬 비용을 만들 수 있다.
      if (visitedEntries >= MAX_ENTRIES) { truncated = true; return; }
      visitedEntries += 1;
      if (entry.name.startsWith(".")) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        omittedSymlinks += 1;
        continue;
      }
      if (stats.isDirectory()) {
        folders.add(relativePath);
        if (depth >= MAX_DEPTH) {
          truncated = true;
          continue;
        }
        await walk(absolutePath, relativePath, depth + 1);
        if (truncated) return;
        continue;
      }
      if (!stats.isFile()) continue;
      totalBytes += stats.size;
      const classification = classifyFile(relativePath, stats.size);
      files.push({
        path: relativePath,
        name: entry.name,
        size: stats.size,
        ...classification,
      });
    }
  };

  await walk(realRoot, "", 0);
  files.sort((left, right) => {
    if (left.role === "entry") return -1;
    if (right.role === "entry") return 1;
    return left.path.localeCompare(right.path);
  });
  return {
    files,
    folderCount: folders.size,
    totalBytes,
    truncated,
    tooLarge: totalBytes > MAX_TOTAL_BYTES,
    omittedSymlinks,
  };
}

function validateRelativeFilePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) return false;
  const parts = relativePath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."));
}

async function openPackageFileNoFollow(root: string, relativePath: string): Promise<FileHandle> {
  const segments = relativePath.split("/");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pinnedRoot = await fs.realpath(root);
    let current = pinnedRoot;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new Error("symlink_not_allowed");
      if (!stats.isDirectory()) throw new Error("file_not_found");
    }

    const candidate = path.join(pinnedRoot, ...segments);
    const finalStats = await fs.lstat(candidate);
    if (finalStats.isSymbolicLink()) throw new Error("symlink_not_allowed");
    let handle: FileHandle;
    try {
      handle = await fs.open(candidate, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("symlink_not_allowed");
      throw error;
    }
    try {
      const [openedStats, currentStats, currentRoot] = await Promise.all([
        handle.stat(),
        fs.lstat(candidate),
        fs.realpath(root),
      ]);
      if (
        currentStats.isSymbolicLink()
        || openedStats.dev !== currentStats.dev
        || openedStats.ino !== currentStats.ino
      ) {
        throw new Error("symlink_not_allowed");
      }
      if (currentRoot !== pinnedRoot) {
        // skill root가 교체됐다. 열린 handle은 검증했던 이전 root 안일 수 있지만, 지금 사용자가
        // 선택한 package identity와 달라졌으므로 한 번만 새 root를 검증해 다시 연다.
        await handle.close();
        if (attempt === 0) continue;
        throw new Error("symlink_not_allowed");
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
  throw new Error("symlink_not_allowed");
}

export async function readSkillPackageFile(
  skillRoot: string,
  allowedRoot: string,
  relativePath: string,
): Promise<{ readonly content: string; readonly file: SkillPackageFile }> {
  if (!validateRelativeFilePath(relativePath)) throw new Error("invalid_file_path");
  const { realRoot } = await validateSkillRoot(skillRoot, allowedRoot);
  const handle = await openPackageFileNoFollow(realRoot, relativePath);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("file_not_found");
    if (stats.size > MAX_FILE_BYTES) throw new Error("file_too_large");

    // The file can grow after stat(). Bound the I/O itself so a concurrent rewrite cannot make
    // this preview allocate or return more than the advertised package-file limit.
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.byteLength - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_FILE_BYTES) throw new Error("file_too_large");

    const classification = classifyFile(relativePath, totalBytes);
    if (!classification.readable) throw new Error("unsupported_file");
    const file: SkillPackageFile = {
      path: relativePath,
      name: path.posix.basename(relativePath),
      size: totalBytes,
      ...classification,
    };
    return { content: buffer.subarray(0, totalBytes).toString("utf-8"), file };
  } finally {
    await handle.close();
  }
}

export const SKILL_PACKAGE_LIMITS = {
  maxDepth: MAX_DEPTH,
  maxEntries: MAX_ENTRIES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
} as const;
