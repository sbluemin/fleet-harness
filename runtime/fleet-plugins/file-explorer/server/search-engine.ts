import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import fsp from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { FileSearchItem, FileSearchResult, Utf16Span } from "./types.js";

type NodeRequire = ReturnType<typeof createRequire>;

const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
const requireFromConsole = resolveConsolePackageRequire(fileURLToPath(import.meta.url), createRequire(import.meta.url));

const RG_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const RG_CONTENT_MATCH_CAP = 2_000;
const PATH_CACHE_TTL_MS = 30_000;
const VCS_GLOBS = ["!.git/**", "!.svn/**", "!.hg/**"] as const;

interface PathCatalog {
  readonly root: string;
  readonly includeHidden: boolean;
  readonly createdAt: number;
  readonly paths: readonly string[];
}

const pathCatalogs = new Map<string, Promise<PathCatalog>>();
const catalogRoots = new Map<string, string>();

export interface SearchFilesWithRipgrepOptions {
  readonly signal?: AbortSignal;
  readonly includeHidden?: boolean;
  readonly includeIgnored?: boolean;
  readonly scope?: "files" | "contents";
  readonly literal?: boolean;
}

interface RipgrepJsonText {
  readonly text?: string;
  readonly bytes?: string;
}

interface RipgrepJsonSubmatch {
  readonly match: RipgrepJsonText;
  readonly start: number;
  readonly end: number;
}

interface RipgrepJsonMatch {
  readonly type: "match";
  readonly data: {
    readonly path: RipgrepJsonText;
    readonly lines: RipgrepJsonText;
    readonly line_number: number;
    readonly submatches: readonly RipgrepJsonSubmatch[];
  };
}

export function invalidateSearchCatalog(theaterPath?: string): void {
  if (!theaterPath) {
    pathCatalogs.clear();
    catalogRoots.clear();
    return;
  }
  const resolved = path.resolve(theaterPath);
  for (const [key, root] of catalogRoots) {
    if (root !== resolved) continue;
    pathCatalogs.delete(key);
    catalogRoots.delete(key);
  }
}

function catalogKey(root: string, includeHidden: boolean, includeIgnored: boolean): string {
  return JSON.stringify([root, includeHidden, includeIgnored]);
}

function resolveConsolePackageRequire(currentFile: string, fallback: NodeRequire): NodeRequire {
  const explicitRoot = process.env.FLEET_CONSOLE_PACKAGE_ROOT;
  if (explicitRoot) {
    const explicitPackageJson = path.join(explicitRoot, "package.json");
    if (isFleetConsolePackage(explicitPackageJson)) return createRequire(explicitPackageJson);
  }
  let directory = path.dirname(currentFile);
  while (true) {
    const candidates = [
      path.join(directory, "package.json"),
      path.join(directory, "runtime", "fleet-console", "package.json"),
      path.join(directory, "..", "..", "fleet-console", "package.json"),
    ];
    for (const packageJson of candidates) {
      if (isFleetConsolePackage(packageJson)) return createRequire(packageJson);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return fallback;
    directory = parent;
  }
}

function isFleetConsolePackage(packageJson: string): boolean {
  if (!existsSync(packageJson)) return false;
  try {
    const manifest = JSON.parse(readFileSync(packageJson, "utf8")) as { readonly name?: unknown };
    return manifest.name === FLEET_CONSOLE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export async function searchFilesWithRipgrep(
  theaterPath: string,
  query: string,
  limit: number,
  options: SearchFilesWithRipgrepOptions = {},
): Promise<FileSearchResult> {
  const startedAt = performance.now();
  const root = await fsp.realpath(theaterPath);
  const scope = options.scope ?? "files";
  const outcome = scope === "contents"
    ? await searchContents(root, query, limit, options)
    : await searchPaths(root, query, limit, options);
  return {
    files: outcome.items,
    totalMatches: outcome.totalMatches ?? outcome.items.length,
    complete: outcome.complete,
    ignoredSkipped: false,
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    engine: "ripgrep",
  };
}

async function searchPaths(
  root: string,
  query: string,
  limit: number,
  options: SearchFilesWithRipgrepOptions,
): Promise<{ readonly items: FileSearchItem[]; readonly totalMatches: number; readonly complete: true }> {
  const catalog = await getPathCatalog(root, options);
  if (options.signal?.aborted) return { items: [], totalMatches: 0, complete: true };
  const ranked = catalog.paths
    .map((relativePath) => rankPath(relativePath, query))
    .filter((item): item is RankedPath => item !== null)
    .sort(compareRankedPaths);
  return {
    totalMatches: ranked.length,
    complete: true,
    items: ranked.slice(0, limit).map(({ relativePath, score, pathRanges }) => ({
      relativePath,
      kind: "file",
      source: "path",
      score,
      pathRanges,
    })),
  };
}

async function getPathCatalog(root: string, options: SearchFilesWithRipgrepOptions): Promise<PathCatalog> {
  const includeHidden = options.includeHidden === true;
  const includeIgnored = options.includeIgnored === true;
  const key = catalogKey(root, includeHidden, includeIgnored);
  catalogRoots.set(key, path.resolve(root));
  const existing = pathCatalogs.get(key);
  if (existing) {
    const catalog = await existing;
    if (performance.now() - catalog.createdAt <= PATH_CACHE_TTL_MS) return catalog;
    pathCatalogs.delete(key);
  }
  const pending = collectPaths(root, includeHidden, includeIgnored, options.signal)
    .then((paths): PathCatalog => ({ root, includeHidden, createdAt: performance.now(), paths }))
    .catch((error) => {
      pathCatalogs.delete(key);
      catalogRoots.delete(key);
      throw error;
    });
  pathCatalogs.set(key, pending);
  return pending;
}

async function collectPaths(root: string, includeHidden: boolean, includeIgnored: boolean, signal?: AbortSignal): Promise<string[]> {
  const args = ["--files", "--null", "--no-config", "--no-require-git"];
  if (includeHidden) args.push("--hidden");
  if (includeIgnored) args.push("--no-ignore");
  for (const glob of VCS_GLOBS) args.push("-g", glob);
  const output = await runRipgrep(root, args, signal);
  return output
    .split("\0")
    .filter(Boolean)
    .map(normalizeRelativePath)
    .filter((relativePath) => includeHidden || !relativePath.split("/").some((segment) => segment.startsWith(".")));
}

async function searchContents(
  root: string,
  query: string,
  limit: number,
  options: SearchFilesWithRipgrepOptions,
): Promise<{ readonly items: FileSearchItem[]; readonly totalMatches?: number; readonly complete: boolean }> {
  const args = [
    "--json",
    "--no-config",
    "--no-require-git",
    "--line-number",
    "--with-filename",
    "--color",
    "never",
    "--max-count",
    "3",
  ];
  if (options.literal !== false) args.push("--fixed-strings");
  if (options.includeHidden === true) args.push("--hidden");
  if (options.includeIgnored === true) args.push("--no-ignore");
  for (const glob of VCS_GLOBS) args.push("-g", glob);
  args.push("--", query, ".");

  const child = spawnRipgrep(root, args);
  const detach = bindAbort(child, options.signal);
  const candidates: FileSearchItem[] = [];
  let pending = "";
  let stderr = "";
  let settled = false;

  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const item = parseContentMatch(line, query);
          if (item) candidates.push(item);
          if (candidates.length >= Math.min(RG_CONTENT_MATCH_CAP, limit)) {
            settled = true;
            child.kill();
            resolve();
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, killedSignal) => {
        if (settled || options.signal?.aborted || killedSignal) { resolve(); return; }
        if (pending) {
          const item = parseContentMatch(pending, query);
          if (item) candidates.push(item);
        }
        // rg는 일치 없음에 1을 쓴다.
        if (code === 0 || code === 1) resolve();
        else reject(new Error(stderr.trim() || `ripgrep exited ${code}`));
      });
    });
  } finally {
    detach();
  }

  return {
    items: candidates.slice(0, limit),
    totalMatches: settled ? undefined : candidates.length,
    complete: !settled,
  };
}

function parseContentMatch(line: string, query: string): FileSearchItem | null {
  let event: RipgrepJsonMatch;
  try {
    event = JSON.parse(line) as RipgrepJsonMatch;
  } catch {
    return null;
  }
  if (event.type !== "match") return null;
  const relativePath = normalizeRelativePath(decodeRipgrepText(event.data.path));
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) return null;
  const rawLine = decodeRipgrepBuffer(event.data.lines);
  const decodedLine = rawLine.toString("utf8");
  const text = decodedLine.replace(/\r?\n$/, "");
  const ranges = event.data.submatches
    .map((submatch) => byteSpanToUtf16(rawLine, submatch.start, submatch.end))
    .filter((range): range is Utf16Span => range !== null)
    .map((range) => ({ start: Math.min(range.start, text.length), end: Math.min(range.end, text.length) }))
    .filter((range) => range.end > range.start);
  const pathRank = rankPath(relativePath, query);
  return {
    relativePath,
    kind: "file",
    source: "content",
    score: pathRank?.score ?? 0,
    pathRanges: pathRank?.pathRanges ?? [],
    preview: {
      lineNumber: event.data.line_number,
      text,
      ranges,
    },
  };
}

function decodeRipgrepText(value: RipgrepJsonText): string {
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  return "";
}

function decodeRipgrepBuffer(value: RipgrepJsonText): Buffer {
  if (typeof value.text === "string") return Buffer.from(value.text, "utf8");
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64");
  return Buffer.alloc(0);
}

export function byteSpanToUtf16(buffer: Buffer, start: number, end: number): Utf16Span | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > buffer.length) return null;
  return {
    start: buffer.subarray(0, start).toString("utf8").length,
    end: buffer.subarray(0, end).toString("utf8").length,
  };
}

interface RankedPath {
  readonly relativePath: string;
  readonly score: number;
  readonly pathRanges: readonly Utf16Span[];
  readonly basenameLength: number;
}

export function rankPath(relativePath: string, query: string): RankedPath | null {
  const normalized = normalizeRelativePath(relativePath);
  const basename = normalized.split("/").at(-1) ?? normalized;
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return null;
  const basenameLower = basename.toLocaleLowerCase();
  const pathLower = normalized.toLocaleLowerCase();
  const ranges: Utf16Span[] = [];
  let score = 0;

  for (const token of queryTokens) {
    const basenameDirect = basenameLower.indexOf(token);
    if (basenameDirect >= 0) {
      ranges.push({ start: normalized.length - basename.length + basenameDirect, end: normalized.length - basename.length + basenameDirect + token.length });
      score += 400 - basenameDirect * 2;
      if (basenameDirect === 0) score += 180;
      if (basenameLower === token) score += 1_000;
      continue;
    }
    const pathDirect = pathLower.indexOf(token);
    if (pathDirect >= 0) {
      ranges.push({ start: pathDirect, end: pathDirect + token.length });
      score += 90 - Math.min(60, pathDirect);
      continue;
    }
    // 느슨한 subsequence는 basename 안에서만 허용한다. 전체 경로에 적용하면
    // 짧은 약어가 디렉터리 글자를 주워 거의 모든 파일과 맞는 저품질 결과가 된다.
    const fuzzy = fuzzyRanges(basename, token);
    if (!fuzzy) return null;
    const basenameStart = normalized.length - basename.length;
    ranges.push(...fuzzy.ranges.map((range) => ({ start: range.start + basenameStart, end: range.end + basenameStart })));
    score += fuzzy.score;
  }

  score -= normalized.length * 0.05;
  return { relativePath: normalized, score: Math.round(score * 100) / 100, pathRanges: mergeRanges(ranges), basenameLength: basename.length };
}

function fuzzyRanges(value: string, token: string): { readonly ranges: Utf16Span[]; readonly score: number } | null {
  const low = value.toLocaleLowerCase();
  const ranges: Utf16Span[] = [];
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const character of token) {
    const index = low.indexOf(character, cursor);
    if (index < 0) return null;
    const boundary = index === 0 || "/._- ".includes(value[index - 1] ?? "") || isCamelBoundary(value, index);
    score += 24 + (boundary ? 45 : 0) + (index === previous + 1 ? 18 : 0) - Math.min(12, index - cursor);
    ranges.push({ start: index, end: index + 1 });
    previous = index;
    cursor = index + 1;
  }
  return { ranges, score };
}

function isCamelBoundary(value: string, index: number): boolean {
  const previous = value[index - 1];
  const current = value[index];
  return Boolean(previous && current && /[a-z0-9]/.test(previous) && /[A-Z]/.test(current));
}

function tokenizeQuery(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/[\s/]+/).filter(Boolean);
}

function mergeRanges(ranges: readonly Utf16Span[]): Utf16Span[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Utf16Span[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function compareRankedPaths(left: RankedPath, right: RankedPath): number {
  return right.score - left.score
    || left.basenameLength - right.basenameLength
    || left.relativePath.localeCompare(right.relativePath);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function runRipgrep(root: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const child = spawnRipgrep(root, args);
  const detach = bindAbort(child, signal);
  let stdout = "";
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > RG_MAX_BUFFER_BYTES) {
          child.kill();
          reject(new Error("ripgrep_output_too_large"));
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code, killedSignal) => {
        if (signal?.aborted || killedSignal) { resolve(); return; }
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `ripgrep exited ${code}`));
      });
    });
    return signal?.aborted ? "" : stdout;
  } finally {
    detach();
  }
}

type RipgrepProcess = ChildProcessByStdio<null, Readable, Readable>;

function spawnRipgrep(root: string, args: readonly string[]): RipgrepProcess {
  const { rgPath } = requireFromConsole("@vscode/ripgrep") as { readonly rgPath: string };
  return spawn(rgPath, args, {
    cwd: root,
    env: { ...process.env, RG_CONFIG_PATH: "" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function bindAbort(child: RipgrepProcess, signal?: AbortSignal): () => void {
  const abort = () => { if (!child.killed) child.kill(); };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}
