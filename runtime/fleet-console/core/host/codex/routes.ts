import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import { join, relative as relativePath, resolve as resolvePath, sep } from "node:path";

import {
  approvePatch,
  approvePatchSet,
  briefingQuery,
  buildBacklinksIndex,
  enqueuePatch,
  extractWikiLinks,
  listQueue,
  listWiki,
  parseLog,
  parsePatch,
  readSchemaCatalog,
  readSchemaDocument,
  readPatchSet,
  readWikiEntry,
  rejectPatch,
  resolveConflict,
  resolveWikiContext,
  runDryDock,
  showQueue,
} from "@dotobokuri/fleet-wiki";
import { PATCH_FILENAME, PATCH_META_FILENAME } from "@dotobokuri/fleet-wiki";
import type { BriefingHit, MemoryPaths, PatchMeta, WikiEntry, WikiEntryFrontmatter } from "@dotobokuri/fleet-wiki";
import type { CoworkService } from "@dotobokuri/fleet-wiki/cowork";

import type {
  CodexHealthResponse,
  ConflictDetailMeta,
  DrydockIssueDto,
  DrydockRunResponse,
  EntryBacklink,
  EntryWriteResponse,
  QueryAnswerResponse,
  ConflictDetailResponse,
  ConflictListItem,
  ConflictResolveResponse,
  DrydockDetailResponse,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  DrydockPatch,
  DrydockPatchSetMember,
  DrydockPatchSetResponse,
  DrydockSetDecisionResponse,
  DrydockWikiEntry,
  EntryFrontmatter,
  EntryResponse,
  RawSourceItem,
  SearchEntry,
  SearchResponse,
  SchemaCatalogResponse,
  SchemaDocumentResponse,
} from "./contracts.js";
import { withSecurityHeaders } from "./contracts.js";
import { handleCoworkRequest } from "./cowork/routes.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteContext {
  cwd: string;
  knowledgeRoot: string;
  paths: MemoryPaths;
  port: number;
  host: string;
  workspaceId: string;
  allowedOrigins: Set<string>;
  externalMode: boolean;
  /** 이 요청이 통과한 리스너가 쓰기를 허락하는가. 게이트웨이가 리스너로 판정해 넘긴다. */
  admitted: boolean;
  coworkService?: CoworkService;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATCH_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$/;
const SAFE_PATCH_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CONFLICT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 충돌 해결 조작 → fleet-wiki resolution 값. UI가 보낼 수 있는 값은 이 셋뿐이다. */
const CONFLICT_RESOLUTIONS = new Set(["queued", "rejected", "manual"]);
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_RAW_REF_LENGTH = 256;
const MAX_POST_BODY_BYTES = 1024;
const MAX_REASON_LENGTH = 256;
/** 문서 본문은 결정 payload와 자릿수가 다르다 — 1MB는 Cowork 초안 상한과 같다. */
const MAX_ENTRY_BODY_BYTES = 1_048_576;
const MAX_PATCH_SUMMARY_LENGTH = 120;
const ENTRY_EDIT_PROPOSER = "console_editor";
const BODY_TOO_LARGE = Symbol("too_large");

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

// ─── Public API ───────────────────────────────────────────────────────────────

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<boolean> {
  if (!request.url) return false;
  const url = new URL(request.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) return false;

  const coworkService = context.coworkService;
  if (coworkService && await handleCoworkRequest(request, response, { ...context, coworkService })) return true;

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

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  const normalized = normalizeRemoteAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1";
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
  if (url.pathname === "/api/query") {
    return handleQuery(url, response, context);
  }
  const entryMatch = url.pathname.match(/^\/api\/entry\/([^/]+)$/);
  if (entryMatch) {
    return handleEntry(entryMatch[1] ?? "", url, response, context);
  }
  if (url.pathname.startsWith("/api/entry/")) {
    sendJson(response, 400, { error: "invalid entry id" });
    return;
  }
  if (url.pathname === "/api/drydock") {
    return handleDrydockList(url, response, context);
  }
  const drydockMatch = url.pathname.match(/^\/api\/drydock\/([^/]+)$/);
  if (drydockMatch) {
    return handleDrydockDetail(drydockMatch[1] ?? "", response, context);
  }
  if (url.pathname.startsWith("/api/drydock/")) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }
  if (url.pathname === "/api/conflicts") {
    return handleConflictList(response, context);
  }
  const conflictMatch = url.pathname.match(/^\/api\/conflicts\/([^/]+)$/);
  if (conflictMatch) {
    return handleConflictDetail(conflictMatch[1] ?? "", response, context);
  }
  if (url.pathname.startsWith("/api/conflicts/")) {
    sendJson(response, 400, { error: "invalid_conflict_id" });
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

async function routePost(url: URL, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  // 패치 셋 경로가 단일 패치 경로보다 먼저 판정되어야 한다 — `sets`가 patch id로 해석되면
  // SAFE_PATCH_ID에서 400으로 죽는다.
  const setDecisionMatch = url.pathname.match(/^\/api\/drydock\/sets\/([^/]+)\/decision$/);
  const decisionMatch = url.pathname.match(/^\/api\/drydock\/([^/]+)\/decision$/);
  const conflictResolveMatch = url.pathname.match(/^\/api\/conflicts\/([^/]+)\/resolve$/);
  const entryEditMatch = url.pathname.match(/^\/api\/entry\/([^/]+)\/edit$/);
  const isEntryCreate = url.pathname === "/api/entry";
  const isDrydockRun = url.pathname === "/api/drydock/run";

  if (!setDecisionMatch && !decisionMatch && !conflictResolveMatch
      && !entryEditMatch && !isEntryCreate && !isDrydockRun) {
    response.writeHead(405, withSecurityHeaders({ ...JSON_HEADERS, allow: "GET, HEAD" }));
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  // 모든 쓰기 경로가 같은 관문을 지난다: 리스너 허용 → Origin → content-type.
  if (!passesWriteGate(request, response, context)) return;

  if (isDrydockRun) {
    await withActionLock(`${context.workspaceId}:drydock`, response, "drydock_busy", () =>
      runDrydockAction(response, context));
    return;
  }

  if (isEntryCreate) {
    await withActionLock(`${context.workspaceId}:entry:create`, response, "entry_busy", () =>
      runEntryCreateAction(request, response, context));
    return;
  }

  if (entryEditMatch) {
    const entryId = decodePathSegment(entryEditMatch[1] ?? "");
    if (!isSafeEntryId(entryId)) {
      sendJson(response, 400, { error: "invalid entry id" });
      return;
    }
    await withActionLock(`${context.workspaceId}:entry:${entryId}`, response, "entry_busy", () =>
      runEntryEditAction(entryId, request, response, context));
    return;
  }

  if (setDecisionMatch) {
    const patchSetId = decodePathSegment(setDecisionMatch[1] ?? "");
    if (!SAFE_PATCH_SET_ID.test(patchSetId)) {
      sendJson(response, 400, { error: "invalid_patch_set_id" });
      return;
    }
    await withActionLock(`${context.workspaceId}:set:${patchSetId}`, response, "patch_busy", () =>
      runSetDecisionAction(patchSetId, request, response, context));
    return;
  }

  if (conflictResolveMatch) {
    const conflictId = decodePathSegment(conflictResolveMatch[1] ?? "");
    if (!SAFE_CONFLICT_ID.test(conflictId)) {
      sendJson(response, 400, { error: "invalid_conflict_id" });
      return;
    }
    await withActionLock(`${context.workspaceId}:conflict:${conflictId}`, response, "conflict_busy", () =>
      runConflictResolveAction(conflictId, request, response, context));
    return;
  }

  const patchId = decodePathSegment(decisionMatch![1] ?? "");
  if (!SAFE_PATCH_ID.test(patchId)) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }
  await withActionLock(`${context.workspaceId}:${patchId}`, response, "patch_busy", () =>
    runDecisionAction(patchId, request, response, context));
}

/** 쓰기 관문 — 통과하지 못하면 이 함수가 이미 응답을 보낸 뒤 false를 돌려준다. */
function passesWriteGate(request: IncomingMessage, response: ServerResponse, context: RouteContext): boolean {
  if (!context.admitted) {
    sendJson(response, 403, { error: "write_loopback_only" });
    return false;
  }
  const originHeader = request.headers.origin;
  if (!originHeader || !isOriginAllowed(originHeader, context.allowedOrigins, context.port)) {
    sendJson(response, 403, { error: "origin_mismatch" });
    return false;
  }
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendJson(response, 415, { error: "unsupported_media_type" });
    return false;
  }
  return true;
}

async function withActionLock(
  lockKey: string,
  response: ServerResponse,
  busyError: string,
  run: () => Promise<void>,
): Promise<void> {
  if (patchActionLocks.has(lockKey)) {
    sendJson(response, 409, { error: busyError });
    return;
  }
  const actionPromise = run();
  patchActionLocks.set(lockKey, actionPromise);
  try {
    await actionPromise;
  } finally {
    patchActionLocks.delete(lockKey);
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
      // type은 UI가 패싯을 그리기 위해 필요하다 — 검색 경로에는 있었지만 목록 경로에는 없었다.
      type: entry.type,
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
  const entry = await readWikiEntry(id, context.paths);
  if (!entry) {
    sendJson(response, 404, { error: "not_found", id });
    return;
  }
  const { body, ...frontmatter } = entry;

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
    ...(raw !== undefined ? { raw } : {}),
    ...(await buildEntryGraph(id, body, context.paths)),
  };
  sendJson(response, 200, responseBody);
}

/**
 * 작성자가 실제로 그은 간선. 백링크는 `buildBacklinksIndex`가 이미 계산할 수 있었지만
 * 콘솔이 한 번도 호출하지 않아 화면에 없었다. 본문 링크 제목도 여기서 함께 해석한다 —
 * 슬러그로 그리면 읽는 사람이 그 링크가 무엇인지 알 수 없다.
 */
async function buildEntryGraph(
  id: string,
  body: string,
  paths: MemoryPaths,
): Promise<{ backlinks?: EntryBacklink[]; linkTitles?: Record<string, string> }> {
  try {
    const entries = await listWiki(paths);
    const titleById = new Map(entries.map((entry) => [entry.id, entry.title]));

    const backlinkIds = buildBacklinksIndex(entries).get(id);
    const backlinks = [...(backlinkIds ?? [])]
      .filter((refId) => refId !== id)
      .map((refId) => ({ id: refId, title: titleById.get(refId) ?? refId }))
      .sort((left, right) => left.title.localeCompare(right.title));

    const linkTitles: Record<string, string> = {};
    for (const linkedId of extractWikiLinks(body)) {
      const title = titleById.get(linkedId);
      if (title) linkTitles[linkedId] = title;
    }

    return {
      ...(backlinks.length > 0 ? { backlinks } : {}),
      ...(Object.keys(linkTitles).length > 0 ? { linkTitles } : {}),
    };
  } catch {
    // 그래프는 부가 정보다 — 못 만들어도 문서 자체는 열려야 한다.
    return {};
  }
}

async function handleHealth(response: ServerResponse, context: RouteContext): Promise<void> {
  let logUnreadable = false;
  const [logEntries, conflicts, pending] = await Promise.all([
    parseLog(context.paths).catch(() => {
      logUnreadable = true;
      return [];
    }),
    listConflictSummaries(context.paths),
    listQueue(context.paths),
  ]);
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
    conflictCount: conflicts.filter((item) => item.status === "open").length,
    pendingCount: pending.length,
    ...(logUnreadable ? { logUnreadable: true as const } : {}),
  } satisfies CodexHealthResponse);
}

async function handleDrydockList(url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
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
  const enriched = await Promise.all(items.map(async (item): Promise<DrydockListItem> => {
    if (!SAFE_PATCH_ID.test(item.id)) return { ...item, meta: item.meta as DrydockMeta };
    try {
      const dir = item.source === "queue" ? context.paths.queueDir : context.paths.archiveDir;
      const patch = await parsePatch(await readFile(join(dir, item.id, PATCH_FILENAME), "utf8"));
      return {
        ...item,
        meta: item.meta as DrydockMeta,
        summary: patch.frontmatter.summary,
        op: patch.frontmatter.op as "create_wiki" | "update_wiki",
        target: patch.frontmatter.target,
        proposer: patch.frontmatter.proposer,
      };
    } catch {
      return { ...item, meta: item.meta as DrydockMeta };
    }
  }));
  sendJson(response, 200, {
    items: enriched,
    pendingCount: pendingItems.length,
    archivedCount: archivedItems.length,
  } satisfies DrydockListResponse);
}

async function handleDrydockDetail(rawSegment: string, response: ServerResponse, context: RouteContext): Promise<void> {
  const patchId = decodePathSegment(rawSegment);
  if (!SAFE_PATCH_ID.test(patchId)) {
    sendJson(response, 400, { error: "invalid_patch_id" });
    return;
  }
  const queueEntryDir = await resolveSafeQueuePath(patchId, context.paths.queueDir);
  const archiveEntryDir = await resolveSafeQueuePath(patchId, context.paths.archiveDir);
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
    // 승인 화면의 diff 기준선. 현재 문서를 못 읽어도 승인 자체는 막지 않는다 —
    // diff 없이 제안본만 보여주던 기존 동작으로 조용히 강등된다.
    const current = targetExists ? await readCurrentEntry(wikiEntry.id, context.paths) : null;
    sendJson(response, 200, {
      source,
      patch: patch as DrydockPatch,
      meta: meta as DrydockMeta,
      wikiEntry,
      targetExists,
      patchSet,
      currentBody: current?.body ?? null,
      currentVersion: current?.version ?? null,
    } satisfies DrydockDetailResponse);
  } catch {
    sendJson(response, 400, { error: "malformed_patch" });
  }
}

async function handleConflictList(response: ServerResponse, context: RouteContext): Promise<void> {
  sendJson(response, 200, await listConflictSummaries(context.paths));
}

async function handleConflictDetail(rawSegment: string, response: ServerResponse, context: RouteContext): Promise<void> {
  const conflictId = decodePathSegment(rawSegment);
  const detail = await readConflictDetail(conflictId, context.paths);
  if (!detail) {
    sendJson(
      response,
      isSafeConflictId(conflictId) ? 404 : 400,
      { error: isSafeConflictId(conflictId) ? "not_found" : "invalid_conflict_id" },
    );
    return;
  }
  sendJson(response, 200, detail);
}

async function runDecisionAction(
  patchId: string,
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

  const action = body.action;
  if (action !== "approve" && action !== "reject") {
    sendJson(response, 400, { error: "invalid_action" });
    return;
  }

  try {
    if (action === "approve") {
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
    process.stderr.write(`[fleet-console-codex] patch action error: ${message}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

/**
 * 패치 셋 일괄 승인. 부분 실패는 실패가 아니다 — `approvePatchSet`가 accepted/failed/missing을
 * 모두 돌려주므로 200으로 싣고, UI가 무엇이 남았는지 그대로 보여준다.
 */
async function runSetDecisionAction(
  patchSetId: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readJsonBody(request, response);
  if (body === null) return;

  if (body.action !== "approve") {
    // 일괄 반려는 의도적으로 없다 — 반려는 사유가 패치마다 다르므로 개별 경로로만 받는다.
    sendJson(response, 400, { error: "invalid_action" });
    return;
  }

  try {
    const result = await approvePatchSet(patchSetId, context.paths);
    sendJson(response, 200, {
      ok: true,
      patchSetId: result.patch_set_id,
      status: result.status,
      acceptedIds: result.accepted.map((meta) => meta.id),
      failed: result.failed.map((entry) => ({ id: entry.patch_id, error: entry.error })),
      missing: result.missing,
    } satisfies DrydockSetDecisionResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isErrorCode(error, "ENOENT") || message.includes("patch set")) {
      sendJson(response, 404, { error: "patch_set_not_found" });
      return;
    }
    process.stderr.write(`[fleet-console-codex] patch set action error: ${message}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

/**
 * 충돌 해결. 본문을 다시 쓰지는 않는다 — 충돌 레코드의 상태만 닫고, 실제 반영은
 * 기존 패치 큐 경로가 맡는다(그래서 `take_proposed`가 queued로 기록된다).
 */
async function runConflictResolveAction(
  conflictId: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readJsonBody(request, response);
  if (body === null) return;

  const resolution = typeof body.resolution === "string" ? body.resolution : "";
  if (!CONFLICT_RESOLUTIONS.has(resolution)) {
    sendJson(response, 400, { error: "invalid_resolution" });
    return;
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MAX_REASON_LENGTH) {
    sendJson(response, 400, { error: "note_too_long" });
    return;
  }

  // 경로 조립 전에 컨테인먼트를 다시 확인한다 — id 정규식만으로는 심링크 탈출을 막지 못한다.
  const conflictDir = await resolveSafeConflictDir(conflictId, context.paths);
  if (!conflictDir) {
    sendJson(response, 404, { error: "conflict_not_found" });
    return;
  }

  try {
    const meta = await resolveConflict(
      conflictId,
      { resolution: resolution as "queued" | "rejected" | "manual", ...(note ? { note } : {}) },
      context.paths,
    );
    sendJson(response, 200, {
      ok: true,
      id: meta.id,
      status: meta.status,
      resolution: meta.resolution ?? resolution,
      ...(meta.resolvedAt ? { resolvedAt: meta.resolvedAt } : {}),
    } satisfies ConflictResolveResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isErrorCode(error, "ENOENT")) {
      sendJson(response, 404, { error: "conflict_not_found" });
      return;
    }
    process.stderr.write(`[fleet-console-codex] conflict resolve error: ${message}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

/**
 * 승인 diff의 기준선이 될 현재 문서. 읽기 실패는 치명적이지 않다 — null을 돌려주면
 * 화면이 diff 없는 제안본 뷰로 강등될 뿐 승인 경로는 그대로 살아 있다.
 */
async function readCurrentEntry(
  entryId: string,
  paths: MemoryPaths,
): Promise<{ body: string; version: number } | null> {
  if (!SAFE_ENTRY_ID.test(entryId)) return null;
  try {
    const entry = await readWikiEntry(entryId, paths);
    if (!entry) return null;
    return { body: entry.body, version: entry.version };
  } catch {
    return null;
  }
}

/**
 * 사람이 직접 쓴 편집. Cowork가 이미 세운 선례를 따른다 — stage 후 같은 호출에서 승인한다.
 * 패치 큐는 *기계가* 제안한 변경을 사람이 검토하기 위한 관문이고, 사람이 직접 쓴 글에서는
 * 그 사람이 곧 검토자다. 감사 흔적(패치 + 로그)은 그대로 남는다.
 */
async function runEntryEditAction(
  entryId: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readJsonBody(request, response, MAX_ENTRY_BODY_BYTES);
  if (body === null) return;

  const nextBody = typeof body.body === "string" ? body.body : null;
  if (nextBody === null) {
    sendJson(response, 400, { error: "invalid_body" });
    return;
  }
  if (nextBody.length > MAX_ENTRY_BODY_BYTES) {
    sendJson(response, 413, { error: "payload_too_large" });
    return;
  }

  const existing = await readWikiEntry(entryId, context.paths);
  if (!existing) {
    sendJson(response, 404, { error: "not_found", id: entryId });
    return;
  }
  // 낙관적 동시성 — 편집 중 다른 경로가 같은 문서를 바꿨으면 덮어쓰지 않는다.
  const expectedVersion = typeof body.expectedVersion === "number" ? body.expectedVersion : null;
  if (expectedVersion !== null && expectedVersion !== existing.version) {
    sendJson(response, 409, { error: "entry_stale", currentVersion: existing.version });
    return;
  }

  const { body: _previousBody, ...frontmatter } = existing;
  const now = new Date().toISOString();
  const nextEntry = {
    ...frontmatter,
    ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
    body: nextBody,
    updated: now,
    version: existing.version + 1,
  };

  await commitEntryPatch(response, context, {
    op: "update_wiki",
    target: `wiki/${entryId}.md`,
    summary: clampSummary(typeof body.summary === "string" && body.summary.trim()
      ? body.summary.trim()
      : `Edit ${nextEntry.title}`),
    entry: nextEntry,
    entryId,
    now,
  });
}

/** 템플릿 기반 신규 항목. 템플릿 본문은 그대로 초안이 된다. */
async function runEntryCreateAction(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<void> {
  const body = await readJsonBody(request, response, MAX_ENTRY_BODY_BYTES);
  if (body === null) return;

  const entryId = typeof body.id === "string" ? body.id.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!isSafeEntryId(entryId) || !title) {
    sendJson(response, 400, { error: "invalid_entry" });
    return;
  }
  if (await readWikiEntry(entryId, context.paths)) {
    sendJson(response, 409, { error: "entry_exists", id: entryId });
    return;
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0).slice(0, MAX_SEARCH_TAGS)
    : [];
  const entryBody = typeof body.body === "string" ? body.body : "";
  if (entryBody.length > MAX_ENTRY_BODY_BYTES) {
    sendJson(response, 413, { error: "payload_too_large" });
    return;
  }

  const now = new Date().toISOString();
  const entry: Record<string, unknown> = {
    id: entryId,
    title,
    tags,
    created: now,
    updated: now,
    version: 1,
    body: entryBody,
  };
  if (typeof body.type === "string" && body.type) entry.type = body.type;
  if (typeof body.status === "string" && body.status) entry.status = body.status;
  if (typeof body.templateId === "string" && body.templateId) entry.template_id = body.templateId;

  await commitEntryPatch(response, context, {
    op: "create_wiki",
    target: `wiki/${entryId}.md`,
    summary: clampSummary(`Create ${title}`),
    entry,
    entryId,
    now,
  });
}

/** stage + 즉시 승인. 두 단계를 한 호출로 묶되 감사 흔적은 둘 다 남긴다. */
async function commitEntryPatch(
  response: ServerResponse,
  context: RouteContext,
  input: {
    op: "create_wiki" | "update_wiki";
    target: string;
    summary: string;
    entry: unknown;
    entryId: string;
    now: string;
  },
): Promise<void> {
  try {
    const patchId = await enqueuePatch({
      frontmatter: {
        op: input.op,
        target: input.target,
        summary: input.summary,
        proposer: ENTRY_EDIT_PROPOSER,
        created: input.now,
      },
      body: JSON.stringify(input.entry),
    }, context.paths);
    await approvePatch(patchId, context.paths);
    sendJson(response, 200, { ok: true, entryId: input.entryId, patchId } satisfies EntryWriteResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const mapped = mapPatchError(message);
    if (mapped) {
      sendJson(response, mapped.status, { error: mapped.error });
      return;
    }
    process.stderr.write(`[fleet-console-codex] entry write error: ${message}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

/**
 * Drydock을 실제로 돌린다. 지금까지 헬스 칩은 에이전트가 우연히 남긴 로그를 재생할 뿐이었고,
 * 사용자가 검사를 촉발할 방법이 없었다. `fix`는 노출하지 않는다 — 자동 수정은 사람이 결과를
 * 본 뒤에 고를 일이지 검사 버튼에 딸려 오면 안 된다.
 */
async function runDrydockAction(response: ServerResponse, context: RouteContext): Promise<void> {
  try {
    const report = await runDryDock(context.paths);
    const issues: DrydockIssueDto[] = report.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      path: issue.path,
    }));
    sendJson(response, 200, {
      ok: report.ok,
      ranAt: new Date().toISOString(),
      issues,
      errorCount: issues.filter((issue) => issue.severity === "error").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      infoCount: issues.filter((issue) => issue.severity === "info").length,
    } satisfies DrydockRunResponse);
  } catch (error) {
    process.stderr.write(`[fleet-console-codex] drydock run error: ${error instanceof Error ? error.message : String(error)}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

/** 말뭉치에 묻는다. `wiki_resolve`의 컨텍스트 팩을 그대로 전송용으로 옮긴다. */
async function handleQuery(url: URL, response: ServerResponse, context: RouteContext): Promise<void> {
  const question = (url.searchParams.get("q") ?? "").trim();
  if (!question) {
    sendJson(response, 400, { error: "question_required" });
    return;
  }
  if (question.length > MAX_SEARCH_QUERY_LENGTH) {
    sendJson(response, 400, { error: "question_too_long" });
    return;
  }
  try {
    const payload = await resolveWikiContext({ query: question }, context.paths);
    const pack = payload.context_pack;
    sendJson(response, 200, {
      question,
      tokenEstimate: pack.token_estimate,
      missingOrUncertain: pack.missing_or_uncertain,
      entries: pack.entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        whenToUse: entry.when_to_use,
        updated: entry.staleness.updated,
        status: entry.staleness.status,
        related: entry.related,
        facts: entry.facts.map((fact) => ({
          claim: fact.claim,
          sourceRefs: fact.source_refs,
          confidence: fact.confidence,
        })),
      })),
    } satisfies QueryAnswerResponse);
  } catch (error) {
    process.stderr.write(`[fleet-console-codex] query error: ${error instanceof Error ? error.message : String(error)}\n`);
    sendJson(response, 500, { error: "internal_error" });
  }
}

function clampSummary(value: string): string {
  return value.length > MAX_PATCH_SUMMARY_LENGTH ? `${value.slice(0, MAX_PATCH_SUMMARY_LENGTH - 1)}\u2026` : value;
}

/** POST 본문 파싱 공통부 — 실패 시 응답을 보내고 null을 돌려준다. */
async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes = MAX_POST_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  const bodyResult = await readRequestBody(request, maxBytes);
  if (bodyResult === BODY_TOO_LARGE) {
    sendJson(response, 413, { error: "payload_too_large" });
    return null;
  }
  if (bodyResult === null) {
    sendJson(response, 400, { error: "invalid_body" });
    return null;
  }
  try {
    const parsed = JSON.parse(bodyResult) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(response, 400, { error: "invalid_body" });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(response, 400, { error: "invalid_body" });
    return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
  if (matchIndex === -1) return value.slice(0, maxLength).trim();
  const start = Math.max(0, Math.min(matchIndex - 50, value.length - maxLength));
  return value.slice(start, start + maxLength).trim();
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes = MAX_POST_BODY_BYTES,
): Promise<string | null | typeof BODY_TOO_LARGE> {
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

function mapPatchError(message: string): { status: number; error: string } | null {
  for (const [matcher, status, error] of PATCH_ERROR_MAP) {
    const matches = typeof matcher === "string" ? message === matcher : matcher(message);
    if (matches) return { status, error };
  }
  return null;
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

function isSafeConflictId(id: string): boolean {
  return SAFE_CONFLICT_ID.test(id) && !id.includes("/") && !id.includes("\\") && !id.includes("..") && !id.includes("\0");
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

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const normalized = stripIpv6Brackets(address).toLowerCase();
  if (normalized === "::ffff:127.0.0.1") return "127.0.0.1";
  return normalized;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

async function resolveSafeConflictDir(id: string, paths: MemoryPaths): Promise<string | null> {
  if (!isSafeConflictId(id)) return null;
  const absolute = resolvePath(paths.conflictsDir, id);
  const relative = relativePath(paths.conflictsDir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  try {
    const real = await realpath(absolute);
    const realRoot = await realpath(paths.conflictsDir);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return absolute;
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

async function resolveSafeQueuePath(patchId: string, dir: string): Promise<string | null> {
  if (!SAFE_PATCH_ID.test(patchId)) return null;
  const absolute = resolvePath(dir, patchId);
  const relative = relativePath(dir, absolute);
  if (relative === "" || relative.startsWith("..") || relative.includes("\0")) return null;
  if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  try {
    const real = await realpath(absolute);
    const realRoot = await realpath(dir);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
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

async function readPatchSetResponse(patchSetId: string, paths: MemoryPaths): Promise<DrydockPatchSetResponse | null> {
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

async function readPatchSetMember(paths: MemoryPaths, patchId: string): Promise<DrydockPatchSetMember> {
  const queueDir = await resolveSafeQueuePath(patchId, paths.queueDir);
  const archiveDir = await resolveSafeQueuePath(patchId, paths.archiveDir);
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
): Promise<DrydockPatchSetMember> {
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

async function listConflictSummaries(paths: MemoryPaths): Promise<ConflictListItem[]> {
  const items: ConflictListItem[] = [];
  for (const entry of await readdir(paths.conflictsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const conflictDir = await resolveSafeConflictDir(id, paths);
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
      items.push({ id, title, updated, status, path: `conflicts/${id}` });
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
  const conflictDir = await resolveSafeConflictDir(id, paths);
  if (!conflictDir) return null;
  try {
    const meta = JSON.parse(await readFile(join(conflictDir, "meta.json"), "utf8")) as ConflictDetailMeta;
    const current = await readOptionalFile(join(conflictDir, "current.md"));
    const proposed = await readOptionalFile(join(conflictDir, "proposed.md"));
    const rawSource = await readOptionalFile(join(conflictDir, "raw-source.md"));
    return { id, meta, current, proposed, rawSource };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parsePatchWikiEntry(patch: Awaited<ReturnType<typeof parsePatch>>): DrydockWikiEntry {
  try {
    const parsed = JSON.parse(patch.body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && typeof parsed.id === "string" && typeof parsed.body === "string") {
      return parsed as DrydockWikiEntry;
    }
  } catch {
    // JSON이 아니면 raw preview로 fallback
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function statusRank(status: ConflictListItem["status"]): number {
  switch (status) {
    case "open": return 0;
    case "unknown": return 1;
    case "resolved": return 2;
  }
}
