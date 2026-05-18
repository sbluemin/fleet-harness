import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import net from "node:net";
import { join, relative as relativePath, resolve as resolvePath } from "node:path";

import {
  approvePatch,
  briefingQuery,
  getIndexMarkdownFile,
  getLogFile,
  listQueue,
  listWiki,
  loadIndex,
  parsePatch,
  readPatchSet,
  readWikiEntry,
  rejectPatch,
  showQueue,
} from "@sbluemin/fleet-wiki";
import { PATCH_FILENAME, PATCH_META_FILENAME } from "@sbluemin/fleet-wiki";
import type { MemoryPaths, PatchMeta, PatchSet, WikiEntry, WikiEntryFrontmatter } from "@sbluemin/fleet-wiki";

import { withSecurityHeaders } from "./security-headers.js";

interface RouteContext {
  cwd: string;
  knowledgeRoot: string;
  paths: MemoryPaths;
  version: string;
  port: number;
  host: string;
}

interface ConflictListItem {
  id: string;
  title: string;
  updated: string;
  status: "open" | "resolved" | "unknown";
  path: string;
}

interface ConflictDetailResponse {
  id: string;
  meta: Record<string, unknown>;
  current: string | null;
  proposed: string | null;
  rawSource: string | null;
}

interface LogResponse {
  limit: number;
  entries: string[];
  totalEntries: number;
  truncated: boolean;
}

interface QueuePatchSetMember {
  id: string;
  status?: string;
  target?: string;
  summary?: string;
  source: "queue" | "archive" | "missing";
}

interface QueuePatchSetResponse {
  id: string;
  sourceRef: string;
  createdAt: string;
  members: QueuePatchSetMember[];
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATCH_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$/;
const SAFE_CONFLICT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_RAW_REF_LENGTH = 256;
const MAX_POST_BODY_BYTES = 1024;
const MAX_REASON_LENGTH = 256;
const MAX_LOG_LIMIT = 100;
const DEFAULT_LOG_LIMIT = 20;

const PATCH_ERROR_MAP: ReadonlyArray<[string | ((m: string) => boolean), number, string]> = [
  ["patch is not pending", 409, "patch_not_pending"],
  [(m) => m.startsWith("Unknown patch ID"), 404, "patch_not_found"],
  [(m) => m.startsWith("Patch ID is required"), 404, "patch_not_found"],
  ["invalid patch op", 400, "invalid_patch"],
  ["patch frontmatter is incomplete", 400, "invalid_patch"],
  ["patch summary exceeds 120 chars", 400, "invalid_patch"],
  ["patch target escapes wiki root", 400, "invalid_patch"],
  ["wiki patch must target wiki/", 400, "invalid_patch"],
  ["update_wiki target does not exist", 409, "update_target_missing"],
  [(m) => m.includes("create_wiki target already exists"), 409, "create_target_exists"],
  ["wiki patch body id must match target filename", 400, "invalid_patch"],
  ["conflicting raw source provenance in wiki patch", 400, "invalid_patch"],
  ["raw source provenance must point into raw/", 400, "invalid_patch"],
];

const patchActionLocks = new Map<string, Promise<unknown>>();

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<boolean> {
  if (!request.url) return false;
  const url = new URL(request.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) return false;

  if (request.method === "POST") {
    try {
      await routePost(url, request, response, context);
    } catch (error) {
      if (error instanceof URIError) {
        sendJson(response, 400, { error: "bad request" });
        return true;
      }
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, withSecurityHeaders({ ...JSON_HEADERS, allow: "GET, HEAD" }));
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  try {
    await routeGet(url, response, context);
  } catch (error) {
    if (error instanceof URIError) {
      sendJson(response, 400, { error: "bad request" });
      return true;
    }
    sendJson(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

async function routeGet(url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      version: context.version,
      cwd: context.cwd,
      knowledgeRoot: context.knowledgeRoot,
    });
    return;
  }

  if (url.pathname === "/api/index") {
    const entries = await listWiki(context.paths);
    sendJson(response, 200, entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      tags: entry.tags,
      updated: entry.updated,
      path: `wiki/${entry.id}.md`,
      status: entry.status,
      revalidateAfter: entry.revalidateAfter,
      rawSourceRef: entry.rawSourceRef,
      rawSourceRefs: entry.rawSourceRefs?.map((item) => item.ref),
    })));
    return;
  }

  if (url.pathname === "/api/index-md") {
    try {
      const content = await readIndexMarkdown(context.paths);
      sendMarkdown(response, 200, content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, { error: "index_md_not_found" });
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/log") {
    const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LOG_LIMIT);
    const limit = Number.isInteger(rawLimit) ? rawLimit : DEFAULT_LOG_LIMIT;
    sendJson(response, 200, await readLogTail(context.paths, limit));
    return;
  }

  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    const tags = (url.searchParams.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const enhanced = url.searchParams.get("enhanced") === "true";
    if (!validSearch(query, tags)) {
      sendJson(response, 400, { error: "invalid search query" });
      return;
    }
    const hits = await briefingQuery(context.paths, {
      topic: query,
      tags,
      limit: 50,
      enhanced,
    });
    sendJson(response, 200, hits);
    return;
  }

  if (url.pathname === "/api/raw") {
    const ref = url.searchParams.get("ref") ?? "";
    const absolute = resolveSafeRawPath(ref, context.paths);
    if (!absolute) {
      sendJson(response, 400, { error: "invalid_raw_ref" });
      return;
    }
    try {
      sendMarkdown(response, 200, await readFile(absolute, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, { error: "raw_not_found", ref });
        return;
      }
      throw error;
    }
    return;
  }

  if (url.pathname === "/api/conflicts") {
    sendJson(response, 200, await listConflictSummaries(context.paths));
    return;
  }

  const conflictMatch = url.pathname.match(/^\/api\/conflicts\/([^/]+)$/);
  if (conflictMatch) {
    const rawSegment = conflictMatch[1] ?? "";
    const conflictId = decodePathSegment(rawSegment);
    const detail = await readConflictDetail(conflictId, context.paths);
    if (!detail) {
      sendJson(response, isSafeConflictId(conflictId) ? 404 : 400, { error: isSafeConflictId(conflictId) ? "not_found" : "invalid_conflict_id" });
      return;
    }
    sendJson(response, 200, detail);
    return;
  }
  if (url.pathname.startsWith("/api/conflicts/")) {
    sendJson(response, 400, { error: "invalid_conflict_id" });
    return;
  }

  if (url.pathname === "/api/queue") {
    const status = url.searchParams.get("status") ?? "pending";
    if (!["pending", "archived", "all"].includes(status)) {
      sendJson(response, 400, { error: "invalid_status" });
      return;
    }
    const [pendingRaw, archivedRaw] = await Promise.all([
      listQueue(context.paths),
      listArchive(context.paths),
    ]);
    const pendingItems = pendingRaw.map((item) => ({ ...item, source: "queue" as const }));
    const archivedItems = archivedRaw.map((item) => ({ ...item, source: "archive" as const }));
    let items: Array<{ id: string; meta: PatchMeta; source: "queue" | "archive" }>;
    if (status === "all") {
      items = [...pendingItems, ...archivedItems].sort(
        (a, b) => new Date(b.meta.createdAt).getTime() - new Date(a.meta.createdAt).getTime(),
      );
    } else if (status === "pending") {
      items = pendingItems;
    } else {
      items = archivedItems;
    }
    sendJson(response, 200, {
      items,
      pendingCount: pendingItems.length,
      archivedCount: archivedItems.length,
    });
    return;
  }

  const queueDetailMatch = url.pathname.match(/^\/api\/queue\/([^/]+)$/);
  if (queueDetailMatch) {
    const rawSegment = queueDetailMatch[1] ?? "";
    const patchId = decodePathSegment(rawSegment);
    if (!SAFE_PATCH_ID.test(patchId)) {
      sendJson(response, 400, { error: "invalid_patch_id" });
      return;
    }
    const queueEntryDir = resolveSafeQueuePath(patchId, context.paths.queueDir);
    const archiveEntryDir = resolveSafeQueuePath(patchId, context.paths.archiveDir);
    let source: "queue" | "archive" | null = null;
    if (queueEntryDir && await dirExists(queueEntryDir)) {
      source = "queue";
    } else if (archiveEntryDir && await dirExists(archiveEntryDir)) {
      source = "archive";
    }
    if (!source) {
      sendJson(response, 404, { error: "patch_not_found" });
      return;
    }
    try {
      let patch: Awaited<ReturnType<typeof parsePatch>>;
      let meta: PatchMeta;
      if (source === "queue") {
        const result = await showQueue(patchId, context.paths);
        patch = result.patch;
        meta = result.meta;
      } else {
        const entryDir = archiveEntryDir!;
        patch = await parsePatch(await readFile(join(entryDir, PATCH_FILENAME), "utf8"));
        meta = JSON.parse(await readFile(join(entryDir, PATCH_META_FILENAME), "utf8")) as PatchMeta;
      }
      const wikiEntry = parsePatchWikiEntry(patch);
      const targetPath = resolvePatchTargetPath(patch.frontmatter.target, context.paths);
      const targetExists = await fileExists(targetPath);
      const patchSet = meta.patch_set_id ? await readPatchSetResponse(meta.patch_set_id, context.paths) : null;
      sendJson(response, 200, { source, patch, meta, wikiEntry, targetExists, patchSet });
    } catch {
      sendJson(response, 400, { error: "malformed_patch" });
    }
    return;
  }
  if (url.pathname.startsWith("/api/queue/")) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }

  const entryMatch = url.pathname.match(/^\/api\/entry\/([^/]+)$/);
  if (entryMatch) {
    const id = decodePathSegment(entryMatch[1] ?? "");
    if (!isSafeEntryId(id)) {
      sendJson(response, 400, { error: "invalid entry id" });
      return;
    }
    const entry = await readWikiEntry(id, context.paths);
    if (!entry) {
      sendJson(response, 404, { error: "not_found", id });
      return;
    }
    const { body, ...frontmatter } = entry;
    sendJson(response, 200, { frontmatter: frontmatter satisfies WikiEntryFrontmatter, body });
    return;
  }
  if (url.pathname.startsWith("/api/entry/")) {
    sendJson(response, 400, { error: "invalid entry id" });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function routePost(url: URL, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const approveMatch = url.pathname.match(/^\/api\/queue\/([^/]+)\/approve$/);
  const rejectMatch = url.pathname.match(/^\/api\/queue\/([^/]+)\/reject$/);

  if (!approveMatch && !rejectMatch) {
    response.writeHead(405, withSecurityHeaders({ ...JSON_HEADERS, allow: "GET, HEAD" }));
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const rawSegment = (approveMatch ?? rejectMatch)?.[1] ?? "";
  const patchId = decodePathSegment(rawSegment);
  if (!SAFE_PATCH_ID.test(patchId)) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }

  const originHeader = request.headers.origin;
  if (!originHeader || !isOriginAllowed(originHeader, context.host, context.port)) {
    sendJson(response, 403, { error: "origin_mismatch" });
    return;
  }

  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendJson(response, 415, { error: "unsupported_media_type" });
    return;
  }

  if (patchActionLocks.has(patchId)) {
    sendJson(response, 409, { error: "patch_busy" });
    return;
  }

  const actionPromise = runPatchAction(patchId, Boolean(approveMatch), request, response, context);
  patchActionLocks.set(patchId, actionPromise);
  try {
    await actionPromise;
  } finally {
    patchActionLocks.delete(patchId);
  }
}

async function runPatchAction(
  patchId: string,
  isApprove: boolean,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const bodyResult = await readRequestBody(request);
  if (bodyResult === BODY_TOO_LARGE) {
    sendJson(response, 413, { error: "payload_too_large" });
    return;
  }
  if (bodyResult === null) {
    sendJson(response, 400, { error: "invalid_body" });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyResult) as Record<string, unknown>;
  } catch {
    sendJson(response, 400, { error: "invalid_body" });
    return;
  }

  try {
    if (isApprove) {
      sendJson(response, 200, { ok: true, meta: await approvePatch(patchId, context.paths) });
      return;
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      sendJson(response, 400, { error: "reason_required" });
      return;
    }
    if (reason.length > MAX_REASON_LENGTH) {
      sendJson(response, 400, { error: "reason_too_long" });
      return;
    }
    sendJson(response, 200, { ok: true, meta: await rejectPatch(patchId, reason, context.paths) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = mapPatchError(message);
    if (mapped) {
      sendJson(response, mapped.status, { error: mapped.error });
      return;
    }
    process.stderr.write(`[fleet-wiki-web] patch action error: ${message}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

function mapPatchError(message: string): { status: number; error: string } | null {
  for (const [matcher, status, error] of PATCH_ERROR_MAP) {
    const matches = typeof matcher === "string" ? message === matcher : matcher(message);
    if (matches) return { status, error };
  }
  return null;
}

const BODY_TOO_LARGE = Symbol("too_large");

async function readRequestBody(request: IncomingMessage): Promise<string | null | typeof BODY_TOO_LARGE> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_POST_BODY_BYTES) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(exceeded ? BODY_TOO_LARGE : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

function isOriginAllowed(origin: string, serverHost: string, serverPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (Number(parsed.port) !== serverPort) return false;
  if (isWildcardHost(serverHost)) return true;
  const hostForCompare = net.isIPv6(serverHost) ? `[${serverHost}]` : serverHost;
  return parsed.hostname === hostForCompare || parsed.host === hostForCompare;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, withSecurityHeaders(JSON_HEADERS));
  response.end(JSON.stringify(body));
}

function sendMarkdown(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, withSecurityHeaders(MARKDOWN_HEADERS));
  response.end(body);
}

function decodePathSegment(segment: string): string {
  return decodeURIComponent(segment);
}

function isSafeEntryId(id: string): boolean {
  return SAFE_ENTRY_ID.test(id);
}

function validSearch(query: string, tags: string[]): boolean {
  return query.length <= MAX_SEARCH_QUERY_LENGTH
    && tags.length <= MAX_SEARCH_TAGS
    && tags.every((tag) => tag.length <= MAX_SEARCH_TAG_LENGTH);
}

function isSafeConflictId(id: string): boolean {
  return SAFE_CONFLICT_ID.test(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..") && !id.includes("\0");
}

function resolveSafeConflictDir(id: string, paths: MemoryPaths): string | null {
  if (!isSafeConflictId(id)) return null;
  const absolute = resolvePath(paths.conflictsDir, id);
  const relative = relativePath(paths.conflictsDir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  return absolute;
}

async function listConflictSummaries(paths: MemoryPaths): Promise<ConflictListItem[]> {
  const items: ConflictListItem[] = [];
  for (const entry of await readdir(paths.conflictsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const conflictDir = resolveSafeConflictDir(id, paths);
    if (!conflictDir) continue;
    try {
      const meta = JSON.parse(await readFile(join(conflictDir, "meta.json"), "utf8")) as Record<string, unknown>;
      const status = meta.status === "resolved" ? "resolved" : meta.status === "unresolved" ? "open" : "unknown";
      const updated = typeof meta.resolvedAt === "string"
        ? meta.resolvedAt
        : typeof meta.createdAt === "string"
          ? meta.createdAt
          : "";
      const title = typeof meta.title === "string"
        ? meta.title
        : typeof meta.wikiId === "string"
          ? meta.wikiId
          : typeof meta.target === "string"
            ? meta.target
            : id;
      items.push({
        id,
        title,
        updated,
        status,
        path: `conflicts/${id}`,
      });
    } catch {
      continue;
    }
  }
  return items.sort((left, right) =>
    statusRank(left.status) - statusRank(right.status)
    || right.updated.localeCompare(left.updated)
    || left.id.localeCompare(right.id),
  );
}

async function readConflictDetail(id: string, paths: MemoryPaths): Promise<ConflictDetailResponse | null> {
  const conflictDir = resolveSafeConflictDir(id, paths);
  if (!conflictDir) return null;
  try {
    const meta = JSON.parse(await readFile(join(conflictDir, "meta.json"), "utf8")) as Record<string, unknown>;
    const current = await readOptionalFile(join(conflictDir, "current.md"));
    const proposed = await readOptionalFile(join(conflictDir, "proposed.md"));
    const rawSource = await readOptionalFile(join(conflictDir, "raw-source.md"));
    return {
      id,
      meta,
      current,
      proposed,
      rawSource,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readIndexMarkdown(paths: MemoryPaths): Promise<string> {
  return readFile(getIndexMarkdownFile(paths), "utf8");
}

async function readLogTail(paths: MemoryPaths, limitInput: number): Promise<LogResponse> {
  const limit = clampLogLimit(limitInput);
  const logFile = getLogFile(paths);
  try {
    const content = await readFile(logFile, "utf8");
    const entries = splitLogEntries(content);
    const latestFirst = [...entries].reverse();
    return {
      limit,
      entries: latestFirst.slice(0, limit),
      totalEntries: entries.length,
      truncated: entries.length > limit,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        limit,
        entries: [],
        totalEntries: 0,
        truncated: false,
      };
    }
    throw error;
  }
}

function splitLogEntries(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const entries = normalized.split(/^## /m).filter(Boolean).map((entry) => `## ${entry}`.trim());
  return entries.filter((entry) => entry.length > 0);
}

function clampLogLimit(value: number): number {
  if (!Number.isInteger(value)) return DEFAULT_LOG_LIMIT;
  if (value < 1) return 1;
  if (value > MAX_LOG_LIMIT) return MAX_LOG_LIMIT;
  return value;
}

function resolveSafeRawPath(ref: string, paths: MemoryPaths): string | null {
  if (!ref || ref.length > MAX_RAW_REF_LENGTH) return null;
  if (ref.includes("\0") || ref.includes("\\")) return null;
  if (!ref.startsWith("raw/")) return null;
  if (ref.includes("/../") || ref.endsWith("/..") || ref === "raw/..") return null;
  const absolute = resolvePath(paths.root, ref);
  const relative = relativePath(paths.rawDir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  return absolute;
}

function resolveSafeQueuePath(patchId: string, dir: string): string | null {
  if (!SAFE_PATCH_ID.test(patchId)) return null;
  const absolute = resolvePath(dir, patchId);
  const relative = relativePath(dir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  return absolute;
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function listArchive(paths: MemoryPaths): Promise<Array<{ id: string; meta: PatchMeta }>> {
  try {
    const entries = await readdir(paths.archiveDir, { withFileTypes: true });
    const results: Array<{ id: string; meta: PatchMeta }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (!SAFE_PATCH_ID.test(id)) continue;
      try {
        const meta = JSON.parse(await readFile(join(paths.archiveDir, id, PATCH_META_FILENAME), "utf8")) as PatchMeta;
        results.push({ id, meta });
      } catch {
        continue;
      }
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readPatchSetResponse(patchSetId: string, paths: MemoryPaths): Promise<QueuePatchSetResponse | null> {
  try {
    const patchSet = await readPatchSet(paths, patchSetId);
    return {
      id: patchSet.id,
      sourceRef: patchSet.sourceRef,
      createdAt: patchSet.createdAt,
      members: await Promise.all(patchSet.patchIds.map((patchId) => readPatchSetMember(paths, patchId))),
    };
  } catch {
    return null;
  }
}

async function readPatchSetMember(paths: MemoryPaths, patchId: string): Promise<QueuePatchSetMember> {
  const queueDir = resolveSafeQueuePath(patchId, paths.queueDir);
  const archiveDir = resolveSafeQueuePath(patchId, paths.archiveDir);
  if (queueDir && await dirExists(queueDir)) {
    return readPatchSetMemberFromDir(queueDir, patchId, "queue");
  }
  if (archiveDir && await dirExists(archiveDir)) {
    return readPatchSetMemberFromDir(archiveDir, patchId, "archive");
  }
  return { id: patchId, source: "missing" };
}

async function readPatchSetMemberFromDir(
  dir: string,
  patchId: string,
  source: "queue" | "archive",
): Promise<QueuePatchSetMember> {
  try {
    const meta = JSON.parse(await readFile(join(dir, PATCH_META_FILENAME), "utf8")) as PatchMeta;
    const patch = await parsePatch(await readFile(join(dir, PATCH_FILENAME), "utf8"));
    return {
      id: patchId,
      status: meta.status,
      target: patch.frontmatter.target,
      summary: patch.frontmatter.summary,
      source,
    };
  } catch {
    return { id: patchId, source };
  }
}

function parsePatchWikiEntry(patch: Awaited<ReturnType<typeof parsePatch>>): WikiEntry {
  try {
    const parsed = JSON.parse(patch.body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && typeof parsed.id === "string" && typeof parsed.body === "string") {
      return parsed as WikiEntry;
    }
  } catch {
    // not valid JSON — fall through to raw preview
  }
  const id = derivePatchTargetId(patch.frontmatter.target);
  return {
    id,
    title: patch.frontmatter.summary || id,
    tags: [],
    created: patch.frontmatter.created,
    updated: patch.frontmatter.created,
    version: 0,
    body: patch.body,
  };
}

function derivePatchTargetId(target: string): string {
  const fileName = target.split(/[\\/]/).pop() ?? "patch";
  const id = fileName.replace(/\.md$/i, "");
  return id || "patch";
}

function resolvePatchTargetPath(target: string, paths: MemoryPaths): string {
  const absolute = resolvePath(paths.root, target);
  const relative = relativePath(paths.wikiDir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) {
    return join(paths.wikiDir, "__invalid_patch_target__.md");
  }
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) {
    return join(paths.wikiDir, "__invalid_patch_target__.md");
  }
  return absolute;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function statusRank(status: ConflictListItem["status"]): number {
  switch (status) {
    case "open": return 0;
    case "unknown": return 1;
    case "resolved": return 2;
  }
}
