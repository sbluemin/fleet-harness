import fs from "node:fs";
import path from "node:path";

import {
  WORLD_METRICS_LIMITS,
  type WorldTheaterMetrics,
  type WorldTheaterStatus,
} from "../shared/world-metrics-contract.js";

/**
 * 사령관 소속 Theater 디렉터리의 파일·폴더 수를 안전하고 빠르게 집계하는 제한 BFS 스캐너.
 *
 * - 노이즈 디렉터리(`.git`, `node_modules`, `dist` 등) 제외
 * - 스캔 전 canonical realpath 일치 및 비심링크 디렉터리 검증, 순회 중 심링크 미추적
 * - 엔트리 수(`maxEntries`) · 깊이(`maxDepth`) · 시간(`maxDurationMs`) 하드 캡 + 주기적 이벤트 루프 양보
 * - canonical `path` 키 기준 TTL 캐시 및 single-flight 병합 (중복 배정 Theater 1회만 스캔)
 */

const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  ".yarn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "target",
  ".fleet",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  "coverage",
  "vendor",
  "Pods",
  "DerivedData",
  ".terraform",
]);

const IGNORED_FILE_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
]);

const YIELD_EVERY_DIRS = 64;

export interface TheaterScanTarget {
  readonly theaterId: string;
  readonly rootPath: string;
}

export interface TheaterMetricsScannerOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxDurationMs?: number;
  readonly cacheTtlMs?: number;
  readonly refreshCooldownMs?: number;
  readonly concurrency?: number;
  readonly now?: () => number;
}

interface RawScanResult {
  readonly status: WorldTheaterStatus;
  readonly fileCount: number;
  readonly dirCount: number;
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly scannedAt: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function isContainedPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

async function scanDirectoryBounded(
  rootPath: string,
  limits: {
    readonly maxEntries: number;
    readonly maxDepth: number;
    readonly maxDurationMs: number;
  },
  now: () => number,
): Promise<RawScanResult> {
  const startedAt = now();

  // 1. 어휘적 검사 + 실제 경로(realpath) 및 심링크 거부 검사
  if (!rootPath || !path.isAbsolute(rootPath) || rootPath.includes("\0") || path.normalize(rootPath) !== rootPath) {
    return { status: "missing", fileCount: 0, dirCount: 0, totalEntries: 0, truncated: false, scannedAt: now() };
  }

  let canonicalRoot: string;
  try {
    const lstat = await fs.promises.lstat(rootPath);
    if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
      return { status: "missing", fileCount: 0, dirCount: 0, totalEntries: 0, truncated: false, scannedAt: now() };
    }
    canonicalRoot = await fs.promises.realpath(rootPath);
    if (canonicalRoot !== rootPath) {
      return { status: "missing", fileCount: 0, dirCount: 0, totalEntries: 0, truncated: false, scannedAt: now() };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const status: WorldTheaterStatus = code === "EACCES" || code === "EPERM" ? "unreadable" : "missing";
    return { status, fileCount: 0, dirCount: 0, totalEntries: 0, truncated: false, scannedAt: now() };
  }

  // 2. 제한 BFS 순회 (심링크 미추적, 노이즈 디렉터리 스킵, 하드 캡 적용)
  let fileCount = 0;
  let dirCount = 0;
  let truncated = false;
  let dirsVisited = 0;

  const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: canonicalRoot, depth: 0 }];
  let cursor = 0;

  while (cursor < queue.length) {
    const current = queue[cursor++]!;
    if (now() - startedAt >= limits.maxDurationMs) {
      truncated = true;
      break;
    }
    if (fileCount + dirCount >= limits.maxEntries) {
      truncated = true;
      break;
    }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      if (current.depth === 0) {
        return { status: "unreadable", fileCount: 0, dirCount: 0, totalEntries: 0, truncated: false, scannedAt: now() };
      }
      continue;
    }

    dirsVisited += 1;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        dirCount += 1;
        if (fileCount + dirCount >= limits.maxEntries) {
          truncated = true;
          break;
        }
        if (current.depth + 1 < limits.maxDepth) {
          const childPath = path.join(current.dir, entry.name);
          if (isContainedPath(canonicalRoot, childPath)) {
            queue.push({ dir: childPath, depth: current.depth + 1 });
          }
        }
      } else if (entry.isFile()) {
        if (IGNORED_FILE_NAMES.has(entry.name)) continue;
        fileCount += 1;
        if (fileCount + dirCount >= limits.maxEntries) {
          truncated = true;
          break;
        }
      }
    }

    if (truncated) break;
    if (dirsVisited % YIELD_EVERY_DIRS === 0) {
      await yieldToEventLoop();
    }
  }

  return {
    status: "available",
    fileCount,
    dirCount,
    totalEntries: fileCount + dirCount,
    truncated,
    scannedAt: now(),
  };
}

export function createTheaterMetricsScanner(options: TheaterMetricsScannerOptions = {}) {
  const maxEntries = options.maxEntries ?? WORLD_METRICS_LIMITS.maxEntries;
  const maxDepth = options.maxDepth ?? WORLD_METRICS_LIMITS.maxDepth;
  const maxDurationMs = options.maxDurationMs ?? WORLD_METRICS_LIMITS.maxDurationMs;
  const cacheTtlMs = options.cacheTtlMs ?? WORLD_METRICS_LIMITS.cacheTtlMs;
  const refreshCooldownMs = options.refreshCooldownMs ?? WORLD_METRICS_LIMITS.refreshCooldownMs;
  const concurrency = Math.max(1, options.concurrency ?? WORLD_METRICS_LIMITS.concurrency);
  const now = options.now ?? (() => Date.now());

  const cache = new Map<string, RawScanResult>();
  const inFlight = new Map<string, Promise<RawScanResult>>();

  async function scanOne(rootPath: string, forceRefresh: boolean): Promise<RawScanResult> {
    const cached = cache.get(rootPath);
    const currentNow = now();
    if (cached) {
      const age = currentNow - cached.scannedAt;
      if (!forceRefresh && age < cacheTtlMs) return cached;
      if (forceRefresh && age < refreshCooldownMs) return cached;
    }

    const existing = inFlight.get(rootPath);
    if (existing) return existing;

    const promise = scanDirectoryBounded(rootPath, { maxEntries, maxDepth, maxDurationMs }, now)
      .then((result) => {
        cache.set(rootPath, result);
        return result;
      })
      .finally(() => {
        inFlight.delete(rootPath);
      });
    inFlight.set(rootPath, promise);
    return promise;
  }

  async function scanTargets(
    targets: readonly TheaterScanTarget[],
    options?: { readonly refresh?: boolean },
  ): Promise<Readonly<Record<string, WorldTheaterMetrics>>> {
    const forceRefresh = options?.refresh === true;
    // 동일 canonical path를 공유하는 Theater는 1회만 스캔한다.
    const uniqueByPath = new Map<string, string[]>();
    for (const target of targets) {
      const ids = uniqueByPath.get(target.rootPath);
      if (ids) {
        if (!ids.includes(target.theaterId)) ids.push(target.theaterId);
      } else {
        uniqueByPath.set(target.rootPath, [target.theaterId]);
      }
    }

    const paths = [...uniqueByPath.keys()];
    const resultsByPath = new Map<string, RawScanResult>();
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < paths.length) {
        const rootPath = paths[nextIndex++]!;
        const scan = await scanOne(rootPath, forceRefresh);
        resultsByPath.set(rootPath, scan);
      }
    }

    const workerCount = Math.min(concurrency, paths.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    const out: Record<string, WorldTheaterMetrics> = {};
    for (const [rootPath, theaterIds] of uniqueByPath.entries()) {
      const scan = resultsByPath.get(rootPath);
      if (!scan) continue;
      for (const theaterId of theaterIds) {
        out[theaterId] = {
          theaterId,
          status: scan.status,
          fileCount: scan.fileCount,
          dirCount: scan.dirCount,
          totalEntries: scan.totalEntries,
          truncated: scan.truncated,
          scannedAt: scan.scannedAt,
        };
      }
    }
    return out;
  }

  return {
    scanTargets,
    invalidatePath(rootPath?: string): void {
      if (rootPath === undefined) {
        cache.clear();
      } else {
        cache.delete(rootPath);
      }
    },
    dispose(): void {
      cache.clear();
      inFlight.clear();
    },
  };
}

export type TheaterMetricsScanner = ReturnType<typeof createTheaterMetricsScanner>;
