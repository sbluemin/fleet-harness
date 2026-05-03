import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { relative as relativePath, resolve as resolvePath } from "node:path";

import { briefingQuery, listWiki, readWikiEntry } from "@sbluemin/fleet-wiki";
import type { MemoryPaths, WikiEntryFrontmatter } from "@sbluemin/fleet-wiki";

import { getBacklinks } from "./backlinks.js";

interface RouteContext {
  cwd: string;
  knowledgeRoot: string;
  paths: MemoryPaths;
  version: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const MARKDOWN_HEADERS = {
  "content-type": "text/markdown; charset=utf-8",
  "cache-control": "no-store",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_RAW_REF_LENGTH = 256;

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<boolean> {
  if (!request.url) return false;
  const url = new URL(request.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method_not_allowed" });
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
