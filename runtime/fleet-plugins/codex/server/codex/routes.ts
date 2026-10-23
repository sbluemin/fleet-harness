import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import net from "node:net";
import { join, relative as relativePath, resolve as resolvePath, sep } from "node:path";


import { briefingQuery, extractWikiLinks, listWiki, parseLog, readSchemaCatalog, readSchemaDocument, readCurrentEntry, withWikiWriteLock, deleteEntry, restoreEntry, StaleEntryBaseError, validateHistoryRef } from "../wiki/index.js";
import type { BriefingHit, MemoryPaths } from "../wiki/index.js";
import type { CodexHealthResponse, EntryBacklink, EntryFrontmatter, EntryResponse, RawSourceItem, SearchEntry, SearchResponse, SchemaCatalogResponse, SchemaDocumentResponse, EntryDeleteResponse, EntryRestoreResponse } from "./contracts.js";
import { withSecurityHeaders } from "./contracts.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteContext {
  knowledgeRoot: string;
  paths: MemoryPaths;
  port: number;
  host: string;
  workspaceId: string;
  allowedOrigins: Set<string>;
  externalMode: boolean;
  /** 이 요청이 통과한 리스너가 쓰기를 허락하는가. 게이트웨이가 리스너로 판정해 넘긴다. */
  admitted: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_RAW_REF_LENGTH = 256;
const MAX_POST_BODY_BYTES = 1024;
const MAX_REASON_LENGTH = 256;
const BODY_TOO_LARGE = Symbol("too_large");

// ─── Public API ───────────────────────────────────────────────────────────────

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
      process.stderr.write(`[fleet-console-codex] request error: ${error instanceof Error ? error.message : String(error)}\n`);
      sendJson(response, 500, { error: "internal_error" });
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
    process.stderr.write(`[fleet-console-codex] request error: ${error instanceof Error ? error.message : String(error)}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
  return true;
}


// ─── Route dispatchers ────────────────────────────────────────────────────────

async function routeGet(url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
  if (url.pathname === "/api/schema") {
    sendJson(response, 200, await readSchemaCatalog(context.paths) satisfies SchemaCatalogResponse);
    return;
  }
  if (url.pathname === "/api/schema/wiki-schema") {
    try {
      sendJson(response, 200, await readSchemaDocument(context.paths, "schema") satisfies SchemaDocumentResponse);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) sendJson(response, 404, { error: "schema_not_found" });
      else {
        process.stderr.write(`[fleet-console-codex] schema read error: ${error instanceof Error ? error.message : String(error)}\n`);
        sendJson(response, 400, { error: "invalid_schema_resource" });
      }
    }
    return;
  }
  const schemaTemplateMatch = url.pathname.match(/^\/api\/schema\/templates\/([^/]+)$/);
  if (schemaTemplateMatch) {
    try {
      sendJson(response, 200, await readSchemaDocument(context.paths, "template", decodePathSegment(schemaTemplateMatch[1] ?? "")) satisfies SchemaDocumentResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message.includes("template_id must match") ? 400 : 404, {
        error: message.includes("template_id must match") ? "invalid_template_id" : "template_not_found",
      });
    }
    return;
  }
  if (url.pathname === "/api/search") {
    return handleSearch(url, response, context);
  }
  if (url.pathname === "/api/health") {
    return handleHealth(response, context);
  }
  const entryMatch = url.pathname.match(/^\/api\/entry\/([^/]+)$/);
  if (entryMatch) {
    return handleEntry(entryMatch[1] ?? "", url, response, context);
  }
  if (url.pathname.startsWith("/api/entry/")) {
    sendJson(response, 400, { error: "invalid entry id" });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

async function routePost(url: URL, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const match = url.pathname.match(/^\/api\/entry\/([^/]+)\/(delete|restore)$/);
  if (!match) {
    response.writeHead(405, withSecurityHeaders({ ...JSON_HEADERS, allow: "GET, HEAD" }));
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  const id = decodePathSegment(match[1] ?? "");
  if (!isSafeEntryId(id)) return sendJson(response, 400, { error: "invalid_entry_id" });
  if (!context.admitted) return sendJson(response, 403, { error: "write_loopback_only" });
  const origin = request.headers.origin;
  if (!origin || !isOriginAllowed(origin, context.allowedOrigins, context.port)) return sendJson(response, 403, { error: "origin_mismatch" });
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return sendJson(response, 415, { error: "unsupported_media_type" });
  const body = await readRequestBody(request);
  if (body === BODY_TOO_LARGE) return sendJson(response, 413, { error: "payload_too_large" });
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(body ?? "");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
    parsed = value as Record<string, unknown>;
  } catch { return sendJson(response, 400, { error: "invalid_body" }); }
  const options = { actor: "console:codex-reader", tool: "console:codex-reader" };
  if (match[2] === "delete") {
    if (typeof parsed.expectedHash !== "string" || !parsed.expectedHash || (parsed.reason !== undefined && typeof parsed.reason !== "string")) return sendJson(response, 400, { error: "invalid_body" });
    if (typeof parsed.reason === "string" && parsed.reason.length > MAX_REASON_LENGTH) return sendJson(response, 400, { error: "reason_too_long" });
    try {
      const result = await withWikiWriteLock(context.paths, () => deleteEntry(id, context.paths, { ...options, base_hash: parsed.expectedHash as string, reason: parsed.reason as string | undefined }));
      return sendJson(response, 200, { ok: true, historyRef: result.history_ref } satisfies EntryDeleteResponse);
    } catch (error) {
      if (error instanceof StaleEntryBaseError) return sendJson(response, 409, { error: "entry_changed", currentHash: error.currentHash });
      if (error instanceof Error && error.message === "entry_not_found") return sendJson(response, 404, { error: "entry_not_found" });
      throw error;
    }
  }
  if (typeof parsed.historyRef !== "string") return sendJson(response, 400, { error: "invalid_history_ref" });
  try { validateHistoryRef(id, parsed.historyRef); }
  catch { return sendJson(response, 400, { error: "invalid_history_ref" }); }
  try {
    const result = await withWikiWriteLock(context.paths, () => restoreEntry(id, parsed.historyRef as string, context.paths, { ...options, requireAbsent: true }));
    return sendJson(response, 200, { ok: true, version: result.version } satisfies EntryRestoreResponse);
  } catch (error) {
    if (error instanceof Error && error.message === "entry_exists") return sendJson(response, 409, { error: "entry_exists" });
    if (isErrorCode(error, "ENOENT")) return sendJson(response, 404, { error: "history_not_found" });
    return sendJson(response, 400, { error: "invalid_history_ref" });
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleSearch(url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
  const query = url.searchParams.get("q") ?? "";
  const tags = (url.searchParams.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_SEARCH_LIMIT);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;

  if (!validSearch(query, tags)) {
    sendJson(response, 400, { error: "invalid search query" });
    return;
  }

  let entries: SearchEntry[];
  if (!query && tags.length === 0) {
    const all = await listWiki(context.paths);
    entries = all.map((entry) => ({
      id: entry.id,
      title: entry.title,
      tags: entry.tags,
      updated: entry.updated,
      path: `wiki/${entry.id}.md`,
      status: entry.status,
      revalidateAfter: entry.revalidateAfter,
      rawSourceRef: entry.rawSourceRef,
      rawSourceRefs: entry.rawSourceRefs?.map((item) => item.ref),
    }));
  } else {
    const hits = await briefingQuery(context.paths, { topic: query, tags, limit, enhanced: false });
    entries = hits.map((hit) => ({
      id: hit.id,
      title: hit.title,
      tags: hit.tags,
      updated: hit.updated,
      path: `wiki/${hit.id}.md`,
      status: hit.status,
      revalidateAfter: hit.revalidateAfter,
      rawSourceRef: hit.rawSourceRef,
      rawSourceRefs: hit.rawSourceRefs,
      score: hit.score,
      excerpt: buildSearchExcerpt(hit, query),
      reason: hit.reason,
      aliases: hit.aliases,
      type: hit.type,
      matchedFields: hit.matchedFields,
      whyThisMatched: hit.whyThisMatched,
    }));
  }

  sendJson(response, 200, { entries, total: entries.length } satisfies SearchResponse);
}

async function handleEntry(rawSegment: string, url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
  const id = decodePathSegment(rawSegment);
  if (!isSafeEntryId(id)) {
    sendJson(response, 400, { error: "invalid entry id" });
    return;
  }
  const current = await readCurrentEntry(context.paths, id);
  if (!current) {
    sendJson(response, 404, { error: "not_found", id });
    return;
  }
  const { body, ...frontmatter } = current.entry;

  let raw: RawSourceItem[] | undefined;
  if (url.searchParams.get("include") === "raw") {
    const refs = [
      ...(frontmatter.rawSourceRef ? [frontmatter.rawSourceRef] : []),
      ...(frontmatter.rawSourceRefs?.map((item) => item.ref) ?? []),
    ];
    if (refs.length > 0) {
      const resolved = await Promise.all(refs.map(async (ref) => {
        const absolute = await resolveSafeRawPath(ref, context.paths);
        if (!absolute) return null;
        try {
          return { ref, content: await readFile(absolute, "utf8") } satisfies RawSourceItem;
        } catch {
          return null;
        }
      }));
      raw = resolved.filter((item): item is RawSourceItem => item !== null);
    }
  }

  const backlinks = await collectEntryBacklinks(id, context.paths);
  const responseBody: EntryResponse = {
    frontmatter: {
      id: frontmatter.id,
      title: frontmatter.title,
      tags: frontmatter.tags,
      created: frontmatter.created,
      updated: frontmatter.updated,
      version: frontmatter.version,
      rawSourceRef: frontmatter.rawSourceRef,
      rawSourceRefs: frontmatter.rawSourceRefs?.map((item) => item.ref),
      aliases: frontmatter.aliases,
      status: frontmatter.status,
      confidence: frontmatter.confidence,
      type: frontmatter.type,
      revalidateAfter: frontmatter.revalidateAfter,
      related: frontmatter.related,
      supersedes: frontmatter.supersedes,
    } satisfies EntryFrontmatter,
    body,
    hash: current.hash,
    ...(raw !== undefined ? { raw } : {}),
    ...(backlinks.length > 0 ? { backlinks } : {}),
  };
  sendJson(response, 200, responseBody);
}

/**
 * [[wiki:id]]로 이 엔트리를 참조하는 다른 엔트리들. 위키 전량을 다시 읽지만
 * 인덱스 규모(수십~수백 문서)에서 엔트리 열람 빈도로는 충분히 저렴하다.
 */
async function collectEntryBacklinks(id: string, paths: MemoryPaths): Promise<EntryBacklink[]> {
  try {
    const all = await listWiki(paths);
    return all
      .filter((entry) => entry.id !== id && extractWikiLinks(entry.body).includes(id))
      .map((entry) => ({ id: entry.id, title: entry.title, updated: entry.updated }))
      .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
  } catch {
    return [];
  }
}

async function handleHealth(response: ServerResponse, context: RouteContext): Promise<void> {
  let logUnreadable = false;
  const logEntries = await parseLog(context.paths).catch(() => { logUnreadable = true; return []; });
  const latest = logEntries.findLast((entry) => entry.event === "drydock run") ?? null;
  const numberPayload = (key: string): number => {
    const value = latest?.payload[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const lastDrydock = latest ? {
    at: latest.timestamp,
    ok: latest.payload.ok === true,
    errorCount: numberPayload("error_count"),
    warningCount: numberPayload("warning_count"),
    infoCount: numberPayload("info_count"),
    issueCount: numberPayload("issue_count"),
  } : null;
  sendJson(response, 200, {
    lastDrydock,
    ...(logUnreadable ? { logUnreadable: true as const } : {}),
  } satisfies CodexHealthResponse);
}

function buildSearchExcerpt(hit: BriefingHit, query: string): string {
  const candidates = [
    ...(hit.matchedSnippets?.map((match) => match.snippet) ?? []),
    hit.excerpt,
  ].map(sanitizeSearchExcerpt).filter(Boolean);
  const normalizedQuery = query.trim().toLowerCase();
  const matched = normalizedQuery
    ? candidates.find((candidate) => candidate.toLowerCase().includes(normalizedQuery))
    : undefined;
  return centerSearchExcerpt(matched ?? candidates[0] ?? "", query);
}

function sanitizeSearchExcerpt(value: string): string {
  return value
    .replace(/^<<<FLEET_WIKI_[A-Z0-9_]+(?:\s[^\r\n]*)?>>>\s*$/gm, "")
    .replace(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
    .trim();
}

function centerSearchExcerpt(value: string, query: string): string {
  const maxLength = 180;
  if (value.length <= maxLength) return value;
  const matchIndex = value.toLowerCase().indexOf(query.trim().toLowerCase());
  if (matchIndex === -1) return trimExcerptWindow(value, 0, maxLength).text;
  const start = Math.max(0, Math.min(matchIndex - 50, value.length - maxLength));
  const window = trimExcerptWindow(value, start, maxLength);
  return `${window.leadingEllipsis ? "\u2026" : ""}${window.text}`;
}

// 창을 단어 경계로 정렬한다 — 단어 중간에서 시작하는 스니펫("tion\n\nLexical…")은
// 판독 소음이라, 잘린 앞 단어는 버리고 말줄임으로 잘림을 정직하게 표시한다.
function trimExcerptWindow(value: string, start: number, maxLength: number): { text: string; leadingEllipsis: boolean } {
  let from = start;
  let leadingEllipsis = false;
  if (from > 0 && /\S/.test(value[from - 1] ?? "")) {
    const nextBreak = value.slice(from, from + maxLength).search(/\s/);
    if (nextBreak >= 0 && nextBreak < maxLength / 2) {
      from += nextBreak + 1;
      leadingEllipsis = true;
    }
  }
  let text = value.slice(from, from + maxLength);
  if (from + maxLength < value.length) {
    const lastBreak = text.search(/\s\S*$/);
    if (lastBreak > maxLength / 2) text = text.slice(0, lastBreak);
  }
  return { text: text.replace(/\s+/g, " ").trim(), leadingEllipsis };
}

async function readRequestBody(request: IncomingMessage, maxBytes = MAX_POST_BODY_BYTES): Promise<string | null | typeof BODY_TOO_LARGE> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(exceeded ? BODY_TOO_LARGE : Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function isOriginAllowed(origin: string, allowedOrigins: Set<string>, serverPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // 원격 리스너는 TLS라 Origin이 https로 온다. 스킴을 http로 못 박으면 그 Origin은 어떤 집합과도
  // 일치할 수 없다 — 허용 집합이 스킴까지 들고 있으므로 비교는 Origin의 스킴 그대로 한다.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (Number(parsed.port) !== serverPort) return false;
  const normalizedHost = normalizeOriginHostname(parsed.hostname);
  if (!normalizedHost) return false;
  return allowedOrigins.has(`${parsed.protocol}//${net.isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost}:${serverPort}`);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, withSecurityHeaders(JSON_HEADERS));
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

function normalizeOriginHostname(hostname: string): string | null {
  const unbracketed = stripIpv6Brackets(hostname).toLowerCase();
  if (unbracketed.includes("%")) return null;
  if (unbracketed.startsWith("::ffff:")) return null;
  if (net.isIP(unbracketed) === 6) {
    try {
      return stripIpv6Brackets(new URL(`http://[${unbracketed}]:1`).hostname).toLowerCase();
    } catch {
      return null;
    }
  }
  return unbracketed;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function resolveSafeRawPath(ref: string, paths: MemoryPaths): Promise<string | null> {
  if (!ref || ref.length > MAX_RAW_REF_LENGTH) return null;
  if (ref.includes("\0") || ref.includes("\\")) return null;
  if (!ref.startsWith("raw/")) return null;
  if (ref.includes("/../") || ref.endsWith("/..") || ref === "raw/..") return null;
  const absolute = resolvePath(paths.root, ref);
  const relative = relativePath(paths.rawDir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  try {
    const real = await realpath(absolute);
    const realRoot = await realpath(paths.rawDir);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return absolute;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
