import * as fs from "node:fs";
import * as path from "node:path";

import { getFleetDataDir } from "../data-dir/paths.js";
import type { ReadRecentLogFilesOptions, RecentLogFile } from "./types.js";

const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const MAX_LOG_READ_BYTES = 256 * 1024;
const MAX_LINES_PER_FILE = 200;
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 20;

export function readRecentLogFiles(options: ReadRecentLogFilesOptions): RecentLogFile[] {
  const limit = clampLimit(options.limit);
  if (limit <= 0) return [];

  const logsDir = path.join(getFleetDataDir(), "logs");
  const filterCategory = options.category ? sanitizeCategory(options.category) : undefined;

  try {
    if (!isSafeLogDirectory(logsDir)) return [];
    return fs.readdirSync(logsDir)
      .filter((fileName) => isAllowedLogFileName(fileName, filterCategory))
      .map((fileName) => readLogFile(logsDir, fileName))
      .filter((file): file is RecentLogFile => file !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function readLogFile(logsDir: string, fileName: string): RecentLogFile | null {
  const filePath = path.join(logsDir, fileName);
  if (!isPathInside(logsDir, filePath)) return null;

  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW_FLAG);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;

    const sizeBytes = stat.size;
    const readBytes = Math.min(sizeBytes, MAX_LOG_READ_BYTES);
    const start = Math.max(0, sizeBytes - readBytes);
    const buffer = Buffer.alloc(readBytes);
    const bytesRead = readBytes > 0 ? fs.readSync(fd, buffer, 0, readBytes, start) : 0;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-MAX_LINES_PER_FILE);

    return {
      category: parseCategory(fileName),
      fileName,
      lines,
      mtimeMs: stat.mtimeMs,
      sizeBytes,
      truncated: sizeBytes > MAX_LOG_READ_BYTES,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 닫기 실패는 읽기 결과와 무관하므로 무시한다.
      }
    }
  }
}

function isSafeLogDirectory(logsDir: string): boolean {
  const stat = fs.lstatSync(logsDir);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function isAllowedLogFileName(fileName: string, category: string | undefined): boolean {
  if (path.basename(fileName) !== fileName) return false;
  if (fileName.startsWith(".")) return false;
  if (!fileName.endsWith(".log")) return false;
  return category === undefined || fileName.startsWith(`${category}-`);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sanitizeCategory(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return sanitized.length > 0 && !sanitized.startsWith(".") ? sanitized : "general";
}

function parseCategory(fileName: string): string {
  const index = fileName.indexOf("-");
  return index > 0 ? fileName.slice(0, index) : "general";
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(limit)));
}
