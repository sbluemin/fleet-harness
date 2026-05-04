import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative as relativePath, resolve as resolvePath } from "node:path";

import { approvePatch, briefingQuery, listQueue, listWiki, parsePatch, readWikiEntry, rejectPatch, showQueue } from "@sbluemin/fleet-wiki";
import { PATCH_FILENAME, PATCH_META_FILENAME } from "@sbluemin/fleet-wiki";
import type { MemoryPaths, PatchMeta, WikiEntry, WikiEntryFrontmatter } from "@sbluemin/fleet-wiki";

import { getBacklinks } from "./backlinks.js";

interface RouteContext {
  cwd: string;
  knowledgeRoot: string;
  paths: MemoryPaths;
  version: string;
  port: number;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "no-store",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// patchId 형식: 2026-05-04T03-15-55-143Z-51756575
const SAFE_PATCH_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$/;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_RAW_REF_LENGTH = 256;
const MAX_POST_BODY_BYTES = 1024;
const MAX_REASON_LENGTH = 256;

// fleet-wiki throw 메시지 → {status, error} 매핑 테이블
const PATCH_ERROR_MAP: ReadonlyArray<[string | ((m: string) => boolean), number, string]> = [
  ["patch is not pending",                          409, "patch_not_pending"],
  [(m) => m.startsWith("Unknown patch ID"),         404, "patch_not_found"],
  [(m) => m.startsWith("Patch ID is required"),     404, "patch_not_found"],
  ["invalid patch op",                              400, "invalid_patch"],
  ["patch frontmatter is incomplete",               400, "invalid_patch"],
  ["patch summary exceeds 120 chars",               400, "invalid_patch"],
  ["patch target escapes wiki root",                400, "invalid_patch"],
  ["wiki patch must target wiki/",                  400, "invalid_patch"],
  ["update_wiki target does not exist",             409, "update_target_missing"],
  ["wiki patch body id must match target filename", 400, "invalid_patch"],
  ["conflicting raw source provenance in wiki patch", 400, "invalid_patch"],
  ["raw source provenance must point into raw/",    400, "invalid_patch"],
];

// patchId → 진행 중인 approve/reject Promise (race 방지)
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
    response.writeHead(405, { ...JSON_HEADERS, allow: "GET, HEAD" });
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
    })));
    return;
  }

  if (url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    const tags = (url.searchParams.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!validSearch(query, tags)) {
      sendJson(response, 400, { error: "invalid search query" });
      return;
    }
    const hits = await briefingQuery(context.paths, {
      topic: query,
      tags,
      limit: 50,
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
      const content = await readFile(absolute, "utf8");
      response.writeHead(200, MARKDOWN_HEADERS);
      response.end(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        sendJson(response, 404, { error: "raw_not_found", ref });
        return;
      }
      throw error;
    }
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
        const patchContent = await readFile(join(entryDir, PATCH_FILENAME), "utf8");
        patch = await parsePatch(patchContent);
        const metaContent = await readFile(join(entryDir, PATCH_META_FILENAME), "utf8");
        meta = JSON.parse(metaContent) as PatchMeta;
      }
      const wikiEntry = JSON.parse(patch.body) as WikiEntry;
      const targetPath = join(context.paths.wikiDir, `${wikiEntry.id}.md`);
      const targetExists = await fileExists(targetPath);
      sendJson(response, 200, { source, patch, meta, wikiEntry, targetExists });
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

  const backlinksMatch = url.pathname.match(/^\/api\/backlinks\/([^/]+)$/);
  if (backlinksMatch) {
    const id = decodePathSegment(backlinksMatch[1] ?? "");
    if (!isSafeEntryId(id)) {
      sendJson(response, 400, { error: "invalid entry id" });
      return;
    }
    sendJson(response, 200, {
      id,
      backlinks: await getBacklinks(id, context.paths),
    });
    return;
  }
  if (url.pathname.startsWith("/api/backlinks/")) {
    sendJson(response, 400, { error: "invalid entry id" });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function routePost(url: URL, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const approveMatch = url.pathname.match(/^\/api\/queue\/([^/]+)\/approve$/);
  const rejectMatch = url.pathname.match(/^\/api\/queue\/([^/]+)\/reject$/);

  if (!approveMatch && !rejectMatch) {
    response.writeHead(405, { ...JSON_HEADERS, allow: "GET, HEAD" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const rawSegment = (approveMatch ?? rejectMatch)![1] ?? "";
  const patchId = decodePathSegment(rawSegment);
  if (!SAFE_PATCH_ID.test(patchId)) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }

  const expectedOrigin = `http://127.0.0.1:${context.port}`;
  if (request.headers.origin !== expectedOrigin) {
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

  const actionPromise = runPatchAction(patchId, !!approveMatch, request, response, context);
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
      const meta = await approvePatch(patchId, context.paths);
      sendJson(response, 200, { ok: true, meta });
    } else {
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!reason) {
        sendJson(response, 400, { error: "reason_required" });
        return;
      }
      if (reason.length > MAX_REASON_LENGTH) {
        sendJson(response, 400, { error: "reason_too_long" });
        return;
      }
      const meta = await rejectPatch(patchId, reason, context.paths);
      sendJson(response, 200, { ok: true, meta });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = mapPatchError(message);
    if (mapped) {
      sendJson(response, mapped.status, { error: mapped.error });
    } else {
      process.stderr.write(`[fleet-wiki-web] patch action error: ${message}\n`);
      sendJson(response, 500, { error: "internal_error" });
    }
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
        // 연결 유지하며 drain — 응답 전송 후 정상 종료
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(exceeded ? BODY_TOO_LARGE : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(body));
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

// resolveSafeRawPath와 동형 — patchId는 SAFE_PATCH_ID 정규식으로 사전 검증됨
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
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
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
        const metaPath = join(paths.archiveDir, id, PATCH_META_FILENAME);
        const metaContent = await readFile(metaPath, "utf8");
        const meta = JSON.parse(metaContent) as PatchMeta;
        results.push({ id, meta });
      } catch {
        // meta.json을 읽을 수 없는 항목은 건너뜀
      }
    }
    return results;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
