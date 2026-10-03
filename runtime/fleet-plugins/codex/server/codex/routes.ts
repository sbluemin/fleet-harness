import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import { join, relative as relativePath, resolve as resolvePath, sep } from "node:path";

import { diffDraftBlocks } from "@fleet-console/markdown/diff";

import {
  approvePatch,
  readPatchBaseConflict,
  readPatchBaseSnapshot,
  readWikiCurrentSnapshot,
  decideWikiConflict,
  computeContentHash,
  serializeWikiEntry,
  StalePatchBaseError,
  currentDeletionImpact,
  stageWikiDeletions,
  briefingQuery,
  extractWikiLinks,
  listQueue,
  listWiki,
  parseLog,
  parsePatch,
  parseWikiEntry,
  readSchemaCatalog,
  readSchemaDocument,
  readPatchSet,
  readWikiEntry,
  rejectPatch,
  showQueue,
} from "../wiki/index.js";
import { PATCH_FILENAME, PATCH_META_FILENAME } from "../wiki/index.js";
import type { BriefingHit, MemoryPaths, PatchMeta, WikiEntry, WikiEntryFrontmatter } from "../wiki/index.js";
import type { CoworkService } from "./cowork/index.js";

import type {
  CodexHealthResponse,
  ConflictDetailResponse,
  ConflictListItem,
  DrydockDetailResponse,
  DrydockBatchResponse,
  DrydockBatchResult,
  DrydockDiffStat,
  DrydockListItem,
  DrydockListResponse,
  DrydockMeta,
  DrydockPatch,
  DrydockPatchSetMember,
  DrydockPatchSetResponse,
  DrydockWikiEntry,
  EntryBacklink,
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
import type { GatewayModel } from "@fleet-console/ai-gateway";
import type { ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

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
  /** 사용자가 Settings › AI Gateway에서 켠 카탈로그 모델. Cowork가 받을 수 있는 모델 목록의 근거다. */
  enabledGatewayModels?: readonly GatewayModel[];
  /** Settings › 실험 기능 읽기 — Cowork 좌표(모델·강도)가 여기서 온다. 요청마다 읽는다. */
  readExperiments?: () => ConsoleExperimentSettings;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};
const SAFE_ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATCH_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z-[0-9a-f]{8}$/;
const SAFE_CONFLICT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_SEARCH_TAGS = 16;
const MAX_SEARCH_TAG_LENGTH = 64;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_RAW_REF_LENGTH = 256;
const MAX_POST_BODY_BYTES = 1024;
const MAX_REASON_LENGTH = 256;
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
  [(m) => m.includes("delete_wiki target does not exist"), 409, "delete_target_missing"],
  [(m) => m.includes("approve stale base_hash") || m.includes("approve stale base_version"), 409, "stale_base"],
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
  const stageMatch = url.pathname.match(/^\/api\/entry\/([^/]+)\/stage-delete$/);
  const decisionMatch = url.pathname.match(/^\/api\/drydock\/([^/]+)\/decision$/);
  const conflictMatch = url.pathname.match(/^\/api\/conflicts\/([^/]+)\/decision$/);
  const batch = url.pathname === "/api/drydock/batch-decision";
  if (!decisionMatch && !stageMatch && !conflictMatch && !batch) {
    response.writeHead(405, withSecurityHeaders({ ...JSON_HEADERS, allow: "GET, HEAD" }));
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const id = batch ? "" : decodePathSegment((decisionMatch ?? stageMatch ?? conflictMatch)![1] ?? "");
  if (!batch && !(stageMatch ? isSafeEntryId(id) : conflictMatch ? isSafeConflictId(id) : SAFE_PATCH_ID.test(id))) {
    sendJson(response, 400, { error: stageMatch ? "invalid_entry_id" : conflictMatch ? "invalid_conflict_id" : "invalid_patch_id" });
    return;
  }

  if (!context.admitted) {
    sendJson(response, 403, { error: "write_loopback_only" });
    return;
  }

  const originHeader = request.headers.origin;
  if (!originHeader || !isOriginAllowed(originHeader, context.allowedOrigins, context.port)) {
    sendJson(response, 403, { error: "origin_mismatch" });
    return;
  }

  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendJson(response, 415, { error: "unsupported_media_type" });
    return;
  }

  if (batch) return runBatchDecision(request, response, context);
  if (conflictMatch) return runConflictDecision(id, request, response, context);

  if (stageMatch) {
    const body = await readRequestBody(request);
    if (body === BODY_TOO_LARGE) return sendJson(response, 413, { error: "payload_too_large" });
    let reason = "";
    try {
      const parsed = JSON.parse(body ?? "") as { reason?: unknown };
      if (parsed.reason !== undefined && typeof parsed.reason !== "string") throw new Error("invalid reason");
      reason = (parsed.reason ?? "") as string;
    } catch {
      return sendJson(response, 400, { error: "invalid_body" });
    }
    if (reason.length > MAX_REASON_LENGTH) return sendJson(response, 400, { error: "reason_too_long" });
    try {
      const result = await stageWikiDeletions([id], reason, context.paths, "Codex reader");
      return sendJson(response, 200, { ok: true, patchId: result.patchIds[0] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("target does not exist")) return sendJson(response, 404, { error: "entry_not_found" });
      process.stderr.write(`[fleet-console-codex] delete staging error: ${message}\n`);
      return sendJson(response, 500, { error: "internal_error" });
    }
  }

  const patchId = id;
  const lockKey = `${context.workspaceId}:${patchId}`;
  if (patchActionLocks.has(lockKey)) {
    sendJson(response, 409, { error: "patch_busy" });
    return;
  }

  const actionPromise = runDecisionAction(patchId, request, response, context);
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

  const backlinks = await collectEntryBacklinks(id, context.paths);
  let pendingPatchCount = 0;
  for (const item of await listQueue(context.paths)) {
    if (item.meta.status !== "pending" || !SAFE_PATCH_ID.test(item.id)) continue;
    try { if (!(await resolveSafeQueuePath(item.id, context.paths.queueDir))) continue; const { patch } = await showQueue(item.id, context.paths); if (derivePatchTargetId(patch.frontmatter.target) === id) pendingPatchCount++; } catch { /* 손상된 항목은 검사 화면이 보고한다. */ }
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
    pendingPatchCount,
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

/**
 * 렌더 블록 diff 기준 라인 가감 집계. update는 현행 본문과, create는 빈 본문과
 * 비교한다 — 큐 목록 행이 "무엇이 얼마나 바뀌는가"를 열람 전에 말하게 한다.
 */
async function computeDrydockDiffStat(
  patch: Awaited<ReturnType<typeof parsePatch>>,
  paths: MemoryPaths,
): Promise<DrydockDiffStat | undefined> {
  try {
    const proposed = patch.frontmatter.op === "delete_wiki" ? "" : parsePatchWikiEntry(patch).body;
    const targetId = derivePatchTargetId(patch.frontmatter.target);
    const current = patch.frontmatter.op === "update_wiki" || patch.frontmatter.op === "delete_wiki"
      ? (await readWikiEntry(targetId, paths))?.body ?? ""
      : "";
    let added = 0;
    let removed = 0;
    for (const block of diffDraftBlocks(current, proposed)) {
      if (block.kind === "same") continue;
      const lines = block.markdown.split("\n").length;
      if (block.kind === "added") added += lines;
      else removed += lines;
    }
    return { added, removed };
  } catch {
    return undefined;
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
      // diffstat은 pending에만 — 결정된 패치를 현행 문서와 비교하는 것은 의미가 없다.
      const diffstat = item.source === "queue"
        ? await computeDrydockDiffStat(patch, context.paths)
        : undefined;
      const baseConflict = item.source === "queue" && item.meta.status === "pending" ? await readPatchBaseConflict(patch, item.meta, context.paths) : null;
      return {
        ...item,
        meta: item.meta as DrydockMeta,
        summary: patch.frontmatter.summary,
        op: patch.frontmatter.op,
        target: patch.frontmatter.target,
        proposer: patch.frontmatter.proposer,
        ...(diffstat ? { diffstat } : {}),
        ...(baseConflict ? { baseConflict } : {}),
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
    const deletionSnapshot = patch.frontmatter.op === "delete_wiki"
      ? JSON.parse(patch.body) as { id: string; snapshot: string; claims?: string; rawSources: Array<{ ref: string }>; sharedRawSources: string[] }
      : null;
    const wikiEntry = deletionSnapshot
      ? (() => { const entry = parseWikiEntry(deletionSnapshot.snapshot); return { ...entry, rawSourceRefs: entry.rawSourceRefs?.map(item => item.ref) }; })()
      : parsePatchWikiEntry(patch);
    const targetPath = resolvePatchTargetPath(patch.frontmatter.target, context.paths);
    const targetExists = await fileExists(targetPath);
    const patchSet = meta.patch_set_id ? await readPatchSetResponse(meta.patch_set_id, context.paths) : null;
    const baseConflict = source === "queue" && meta.status === "pending"
      ? await readPatchBaseConflict(patch, meta, context.paths)
      : null;
    const impact = deletionSnapshot && source === "queue"
      ? await currentDeletionImpact(patch.body, context.paths, meta.patch_set_id)
      : null;
    sendJson(response, 200, {
      source,
      patch: patch as DrydockPatch,
      meta: meta as DrydockMeta,
      wikiEntry,
      targetExists,
      patchSet,
      ...(baseConflict ? { baseConflict } : {}),
      ...(deletionSnapshot ? { deletion: {
        snapshot: deletionSnapshot.snapshot,
        claims: deletionSnapshot.claims,
        ...(source === "queue" && !impact ? { targetMissing: true } : {}),
        backlinks: impact?.backlinks ?? [],
        rawSources: impact?.rawSources ?? deletionSnapshot.rawSources.map(item => item.ref),
        sharedRawSources: impact?.sharedRawSources ?? deletionSnapshot.sharedRawSources,
      } } : {}),
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

async function runConflictDecision(id: string, request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const raw = await readRequestBody(request);
  if (raw === BODY_TOO_LARGE) return sendJson(response, 413, { error: "payload_too_large" });
  let body: { action?: unknown; note?: unknown; expectedCurrentHash?: unknown };
  try { body = JSON.parse(raw ?? ""); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); }
  catch { return sendJson(response, 400, { error: "invalid_body" }); }
  if (body.action !== "reject" && body.action !== "repropose" && body.action !== "resolve") return sendJson(response, 400, { error: "invalid_action" });
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > MAX_REASON_LENGTH) return sendJson(response, 400, { error: "reason_required" });
  if (!(await resolveSafeConflictDir(id, context.paths))) return sendJson(response, 404, { error: "not_found" });
  try {
    const result = await decideWikiConflict(id, body.action, note, context.paths, typeof body.expectedCurrentHash === "string" ? body.expectedCurrentHash : undefined);
    sendJson(response, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal_error";
    const allowed = ["conflict_not_open", "conflict_reapply_unavailable", "conflict_current_changed", "conflict_patch_mismatch", "reapply_conflict", "reapply_limit", "patch is not pending"];
    if (allowed.includes(message)) return sendJson(response, 409, { error: message === "patch is not pending" ? "patch_not_pending" : message });
    sendJson(response, 400, { error: "invalid_conflict" });
  }
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
    if (error instanceof StalePatchBaseError) {
      sendJson(response, 409, {
        error: "stale_base",
        message: "The entry changed since this proposal was created. Review the current entry and revise or reject the proposal.",
        baseConflict: error.conflict,
      });
      return;
    }
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

async function runBatchDecision(request: IncomingMessage, response: ServerResponse, context: RouteContext): Promise<void> {
  const raw = await readRequestBody(request, 8192);
  if (raw === BODY_TOO_LARGE) return sendJson(response, 413, { error: "payload_too_large" });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw ?? "");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_body");
  } catch { return sendJson(response, 400, { error: "invalid_body" }); }
  const { action, patchIds } = body;
  if (action !== "approve" && action !== "reject") return sendJson(response, 400, { error: "invalid_action" });
  if (!Array.isArray(patchIds) || patchIds.length < 1 || patchIds.length > 100 || patchIds.some(id => typeof id !== "string" || !SAFE_PATCH_ID.test(id))) return sendJson(response, 400, { error: "invalid_patch_ids" });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (action === "reject" && !reason) return sendJson(response, 400, { error: "reason_required" });
  if (reason.length > MAX_REASON_LENGTH) return sendJson(response, 400, { error: "reason_too_long" });
  const results: DrydockBatchResult[] = [];
  const conflictLink = async (id: string): Promise<{ conflictId?: string }> => {
    try {
      if (!await resolveSafeQueuePath(id, context.paths.queueDir)) return {};
      const linked = (await showQueue(id, context.paths)).meta.conflictId;
      if (typeof linked === "string" && isSafeConflictId(linked) && await resolveSafeConflictDir(linked, context.paths)) return { conflictId: linked };
    } catch { /* 충돌 조회 실패는 원래 항목의 실패 사유를 바꾸지 않는다. */ }
    return {};
  };
  for (const id of new Set<string>(patchIds)) {
    const key = `${context.workspaceId}:${id}`;
    if (patchActionLocks.has(key)) { results.push({ id, outcome: "skipped", error: "patch_busy" }); continue; }
    const operation = (async (): Promise<DrydockBatchResult> => {
      try {
        if (!await resolveSafeQueuePath(id, context.paths.queueDir)) return { id, outcome: "skipped", error: "patch_not_pending" };
        const { patch, meta } = await showQueue(id, context.paths);
        if (meta.status !== "pending") return { id, outcome: "skipped", error: "patch_not_pending" };
        // 낡은 제안은 승인 호출 전에 제외한다. 실패한 승인이 충돌을 새로 만들지 않는다.
        if (action === "approve" && await readPatchBaseConflict(patch, meta, context.paths)) return { id, outcome: "skipped", error: "stale_base", ...await conflictLink(id) };
        if (action === "approve") await approvePatch(id, context.paths);
        else await rejectPatch(id, reason, context.paths);
        return { id, outcome: action === "approve" ? "approved" : "rejected" };
      } catch (error) {
        if (error instanceof StalePatchBaseError) return { id, outcome: "skipped", error: "stale_base", ...await conflictLink(id) };
        const mapped = mapPatchError(error instanceof Error ? error.message : "");
        if (mapped?.error === "patch_not_found" || mapped?.error === "patch_not_pending") return { id, outcome: "skipped", error: "patch_not_pending" };
        return { id, outcome: "failed", error: mapped?.error ?? "internal_error", ...await conflictLink(id) };
      }
    })();
    patchActionLocks.set(key, operation);
    try { results.push(await operation); } finally { patchActionLocks.delete(key); }
  }
  // 일괄 결정은 비트랜잭션이다. 항목별 결과를 숨기거나 모두 성공이라고 단정하지 않는다.
  sendJson(response, 200, { ok: true, results } satisfies DrydockBatchResponse);
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
      items.push({ id, title, updated, ...(typeof meta.createdAt === "string" ? { createdAt: meta.createdAt } : {}), status, path: `conflicts/${id}` });
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
    const meta = JSON.parse(await readFile(join(conflictDir, "meta.json"), "utf8")) as Record<string, unknown>;
    const current = await readOptionalFile(join(conflictDir, "current.md"));
    let proposed = await readOptionalFile(join(conflictDir, "proposed.md"));
    const rawSource = await readOptionalFile(join(conflictDir, "raw-source.md"));
    const liveCurrent = typeof meta.target === "string" ? await readWikiCurrentSnapshot(meta.target, paths).catch(() => null) : null;
    let base: string | null = null;
    let pendingPatch = false;
    let canRepropose = false;
    if (typeof meta.patchId === "string" && SAFE_PATCH_ID.test(meta.patchId)) {
      for (const root of [paths.queueDir, paths.archiveDir]) {
        const patchDir = await resolveSafeQueuePath(meta.patchId, root);
        if (!patchDir) continue;
        try {
          const patch = await parsePatch(await readFile(join(patchDir, PATCH_FILENAME), "utf8"));
          const patchMeta = JSON.parse(await readFile(join(patchDir, PATCH_META_FILENAME), "utf8")) as PatchMeta;
          if (patch.frontmatter.target !== meta.target) continue;
          base = await readPatchBaseSnapshot(meta.patchId, patchMeta, paths);
          pendingPatch = root === paths.queueDir && patchMeta.status === "pending";
          // 대기 제안은 충돌 기록 뒤에도 수정할 수 있다. 다시 제안이 실제로 소비할
          // 최신 큐 본문을 보여 주고, 오래된 충돌 당시 제안을 현재 제안처럼 표시하지 않는다.
          if (patch.frontmatter.op === "update_wiki") proposed = serializeWikiEntry(JSON.parse(patch.body) as WikiEntry);
          canRepropose = pendingPatch && patch.frontmatter.op === "update_wiki" && base !== null && liveCurrent !== null;
          break;
        } catch { /* 오래된 고아 충돌은 읽기와 정리만 허용한다. */ }
      }
    }
    const title = typeof meta.title === "string" ? meta.title : liveCurrent ? parseWikiEntry(liveCurrent).title : typeof meta.wikiId === "string" ? meta.wikiId : id;
    return { id, title, status: meta.status === "resolved" ? "resolved" : meta.status === "unresolved" ? "open" : "unknown", meta, base, current: liveCurrent, currentAtConflict: current, ...(liveCurrent ? { currentHash: computeContentHash(liveCurrent) } : {}), proposed, rawSource, pendingPatch, canRepropose };
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
