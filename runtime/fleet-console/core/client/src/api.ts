import type { ConsoleUpdateApplyAcceptedResponse, OperationGroup, OperationNode, ObserverStatus, ReleaseNoteItem, ReleaseNoteSection, ReleaseNotes, ReleaseNotesLocale, ReleaseNotesResponse, TheaterBootstrap, TheaterInfo } from "./types.js";

export interface TheaterFolderListEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir";
  readonly accessible: boolean;
}

export interface TheaterFolderListResponse {
  readonly path: string;
  readonly parentPath: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly TheaterFolderListEntry[];
  readonly truncated?: true;
}

export interface PlanListItem {
  readonly name: string;
  readonly title: string;
  readonly executionMode: "sequential" | "parallel" | null;
  readonly waveCount: number;
  readonly tasksDone: number;
  readonly tasksTotal: number;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

export interface PlanLane {
  readonly id: string | null;
  readonly heading: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface PlanWave {
  readonly index: number;
  readonly heading: string;
  readonly lanes: readonly PlanLane[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface PlanReadResult {
  readonly name: string;
  readonly title: string;
  readonly executionMode: "sequential" | "parallel" | null;
  readonly updatedAt: string;
  readonly content: string;
  readonly waves: readonly PlanWave[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface PlansListResult {
  readonly plans: readonly PlanListItem[];
}

export interface ReleaseNotesFetchOptions {
  readonly force?: boolean;
  readonly locale?: ReleaseNotesLocale;
  readonly signal?: AbortSignal;
}

export interface OperationPatchClientInput {
  readonly title?: string;
  readonly accent?: string | null;
  readonly groupId?: string | null;
}

export interface OperationGroupCreateInput {
  readonly theaterId: string;
  readonly name: string;
  readonly color: string;
}

export interface OperationGroupPatchInput {
  readonly name?: string;
  readonly color?: string;
  readonly order?: number;
}

const FORBIDDEN_BROWSER_PAYLOAD_KEYS = ["canonicalCwd", "cwd", "providerSession", "ticket", "token", "transcriptPath"] as const;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function fetchTheaters(signal?: AbortSignal): Promise<readonly TheaterInfo[]> {
  return (await fetchTheaterBootstrap(signal)).theaters;
}

export async function fetchTheaterBootstrap(signal?: AbortSignal): Promise<TheaterBootstrap> {
  const response = await fetch("/api/v1/theaters", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { theaters?: unknown };
  if (!Array.isArray(payload.theaters)) throw new ApiError(response.status, "Invalid Theater response");
  return { theaters: payload.theaters.map((theater) => assertTheaterInfo(theater, response.status)) };
}

export async function fetchObserverStatus(theaterId: string | null, signal?: AbortSignal): Promise<ObserverStatus> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/api/v1/status${suffix}`, { signal });
  await assertOk(response);
  return assertObserverStatus(await response.json(), response.status);
}

export async function fetchReleaseNotes(options: ReleaseNotesFetchOptions = {}): Promise<ReleaseNotesResponse> {
  const query = new URLSearchParams();
  if (options.locale) query.set("locale", options.locale);
  if (options.force) query.set("force", "true");
  const suffix = query.size > 0 ? `?${query}` : "";
  const response = await fetch(`/api/v1/updates/release-notes${suffix}`, { signal: options.signal });
  await assertOk(response);
  return assertReleaseNotesResponse(await response.json(), response.status);
}

export async function applyConsoleUpdate(signal?: AbortSignal): Promise<ConsoleUpdateApplyAcceptedResponse> {
  const response = await fetch("/api/v1/updates/apply", { method: "POST", signal });
  await assertOk(response);
  return assertConsoleUpdateApplyAccepted(await response.json(), response.status);
}

export async function addTheater(folderGrantId: string, signal?: AbortSignal): Promise<TheaterInfo> {
  const response = await fetch("/api/v1/theaters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId }),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as unknown;
  return assertTheaterInfo(payload, response.status);
}

export async function listTheaterFolders(path: string | null, signal?: AbortSignal): Promise<TheaterFolderListResponse> {
  const response = await fetch("/api/v1/theaters/folder-listings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
  await assertOk(response);
  return assertTheaterFolderList(await response.json(), response.status);
}

export async function issueTheaterFolderGrant(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/v1/theaters/folder-grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
  await assertOk(response);
  const payload = (await response.json()) as { folderGrantId?: unknown };
  if (typeof payload.folderGrantId !== "string") throw new ApiError(response.status, "Invalid folder grant response");
  return payload.folderGrantId;
}

export async function fetchPlansList(theaterId: string, signal?: AbortSignal): Promise<PlansListResult> {
  const response = await fetch("/api/v1/plans/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId }),
    signal,
  });
  await assertOk(response);
  return await response.json() as PlansListResult;
}

export async function fetchPlanRead(theaterId: string, name: string, signal?: AbortSignal): Promise<PlanReadResult> {
  const response = await fetch("/api/v1/plans/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId, name }),
    signal,
  });
  await assertOk(response);
  return await response.json() as PlanReadResult;
}

export async function forgetTheater(theaterId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function fetchOperations(theaterId?: string | null, signal?: AbortSignal): Promise<readonly OperationNode[]> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/api/v1/operations${suffix}`, { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly operations?: unknown };
  if (!Array.isArray(payload.operations)) throw new ApiError(response.status, "Invalid operations response");
  return payload.operations.map((operation) => assertOperationNode(operation, response.status));
}

export async function fetchGroups(theaterId?: string | null, signal?: AbortSignal): Promise<readonly OperationGroup[]> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/api/v1/operations/groups${suffix}`, { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly groups?: unknown };
  if (!Array.isArray(payload.groups)) throw new ApiError(response.status, "Invalid groups response");
  return payload.groups.map((group) => assertOperationGroup(group, response.status));
}

export async function createGroup(input: OperationGroupCreateInput, signal?: AbortSignal): Promise<OperationGroup> {
  const response = await fetch("/api/v1/operations/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly group?: unknown };
  return assertOperationGroup(payload.group, response.status);
}

export async function updateGroup(groupId: string, patch: OperationGroupPatchInput, signal?: AbortSignal): Promise<OperationGroup> {
  const response = await fetch(`/api/v1/operations/groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly group?: unknown };
  return assertOperationGroup(payload.group, response.status);
}

export async function deleteGroup(groupId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/v1/operations/groups/${encodeURIComponent(groupId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function renameOperation(operationId: string, title: string, signal?: AbortSignal): Promise<OperationNode> {
  return patchOperation(operationId, { title }, signal);
}

export async function patchOperation(operationId: string, input: OperationPatchClientInput, signal?: AbortSignal): Promise<OperationNode> {
  const response = await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly operation?: unknown };
  return assertOperationNode(payload.operation, response.status);
}

export async function createOperation(input: {
  readonly id?: string;
  readonly theaterId: string;
  readonly type: string;
  readonly pluginId: string;
  readonly title: string;
  readonly payload?: Record<string, unknown>;
  readonly geometry?: OperationNode["geometry"];
}, signal?: AbortSignal): Promise<OperationNode> {
  const response = await fetch("/api/v1/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as { readonly operation?: unknown };
  return assertOperationNode(payload.operation, response.status);
}

export async function requestTerminalTicket(sessionId: string, signal?: AbortSignal): Promise<{ readonly ticket: string; readonly ttlMs: number }> {
  const response = await fetch("/terminal/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
    signal,
  });
  await assertOk(response);
  const payload = (await response.json()) as { ticket?: unknown; ttlMs?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new ApiError(response.status, "Invalid terminal ticket response");
  }
  return { ticket: payload.ticket, ttlMs: payload.ttlMs };
}

function assertOperationNode(value: unknown, status: number): OperationNode {
  const payload = value as Partial<OperationNode>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.type !== "string"
    || typeof payload.pluginId !== "string"
    || typeof payload.title !== "string"
    || !payload.payload
    || typeof payload.payload !== "object"
    || Array.isArray(payload.payload)
    || !payload.ts
    || typeof payload.ts.createdAt !== "number"
    || typeof payload.ts.updatedAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
    || hasForbiddenBrowserPayloadKey(payload.payload)
  ) {
    throw new ApiError(status, "Invalid operation response");
  }
  return {
    id: payload.id,
    theaterId: payload.theaterId,
    type: payload.type,
    pluginId: payload.pluginId,
    title: payload.title,
    payload: payload.payload,
    geometry: payload.geometry ?? null,
    // 서버가 영속한 accent를 노드에 보존한다. 누락 시 server→store 동기화가 사용자 accent를 null로 덮어쓴다.
    accent: typeof payload.accent === "string" ? payload.accent : null,
    // 서버가 영속한 groupId를 보존한다. null = Ungrouped 명시, undefined = 미설정(Ungrouped와 동일 취급).
    groupId: payload.groupId === null ? null : typeof payload.groupId === "string" ? payload.groupId : undefined,
    ts: payload.ts,
  };
}

function assertOperationGroup(value: unknown, status: number): OperationGroup {
  const payload = value as Partial<OperationGroup>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.theaterId !== "string"
    || typeof payload.name !== "string"
    || typeof payload.color !== "string"
    || typeof payload.order !== "number"
    || typeof payload.createdAt !== "number"
  ) {
    throw new ApiError(status, "Invalid group response");
  }
  return {
    id: payload.id,
    theaterId: payload.theaterId,
    name: payload.name,
    color: payload.color,
    order: payload.order,
    createdAt: payload.createdAt,
  };
}

function assertTheaterInfo(value: unknown, status: number): TheaterInfo {
  const payload = value as Partial<TheaterInfo>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.label !== "string"
    || typeof payload.createdAt !== "string"
    || typeof payload.lastOpenedAt !== "string"
    || typeof payload.hasWiki !== "boolean"
    || typeof payload.activeAdmiralCount !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(status, "Invalid Theater response");
  }
  return payload as TheaterInfo;
}

function assertObserverStatus(value: unknown, status: number): ObserverStatus {
  const payload = value as Partial<ObserverStatus>;
  if (
    !payload
    || typeof payload.workspaces !== "number"
    || typeof payload.version !== "string"
    || (payload.channel !== "stable" && payload.channel !== "local" && payload.channel !== "unknown")
    || typeof payload.updateAvailable !== "boolean"
    || typeof payload.port !== "number"
    || (payload.portMode !== "dynamic" && payload.portMode !== "static")
    || (payload.requestedPort !== null && typeof payload.requestedPort !== "number")
    || typeof payload.effectivePort !== "number"
    || typeof payload.portHonored !== "boolean"
    || (payload.wikiServerStatus !== "available" && payload.wikiServerStatus !== "unavailable" && payload.wikiServerStatus !== "unknown")
  ) {
    throw new ApiError(status, "Invalid status response");
  }
  return {
    workspaces: payload.workspaces,
    version: payload.version,
    channel: payload.channel,
    updateAvailable: payload.updateAvailable,
    latestVersion: typeof payload.latestVersion === "string" ? payload.latestVersion : undefined,
    port: payload.port,
    portMode: payload.portMode,
    requestedPort: payload.requestedPort,
    effectivePort: payload.effectivePort,
    portHonored: payload.portHonored,
    wikiServerStatus: payload.wikiServerStatus,
  };
}

function assertConsoleUpdateApplyAccepted(value: unknown, status: number): ConsoleUpdateApplyAcceptedResponse {
  const payload = value as Partial<ConsoleUpdateApplyAcceptedResponse>;
  if (!payload || payload.status !== "accepted") throw new ApiError(status, "Invalid update response");
  return { status: "accepted" };
}

function assertReleaseNotesResponse(value: unknown, status: number): ReleaseNotesResponse {
  const payload = value as Partial<ReleaseNotesResponse> & { readonly url?: unknown; readonly token?: unknown; readonly path?: unknown };
  if (
    !payload
    || !Array.isArray(payload.notes)
    || payload.sourceRef !== "main"
    || typeof payload.fetchedAt !== "number"
    || typeof payload.stale !== "boolean"
    || "url" in payload
    || "token" in payload
    || "path" in payload
  ) {
    throw new ApiError(status, "Invalid release notes response");
  }
  return {
    notes: payload.notes.map((note) => assertReleaseNotes(note, status)),
    sourceRef: "main",
    fetchedAt: payload.fetchedAt,
    stale: payload.stale,
  };
}

function assertReleaseNotes(value: unknown, status: number): ReleaseNotes {
  const payload = value as Partial<ReleaseNotes>;
  if (
    !payload
    || typeof payload.version !== "string"
    || (payload.date !== null && typeof payload.date !== "string")
    || !Array.isArray(payload.sections)
    || typeof payload.localizationFallback !== "boolean"
  ) {
    throw new ApiError(status, "Invalid release notes response");
  }
  return {
    version: payload.version,
    date: payload.date,
    sections: payload.sections.map((section) => assertReleaseNoteSection(section, status)),
    localizationFallback: payload.localizationFallback,
  };
}

function assertReleaseNoteSection(value: unknown, status: number): ReleaseNoteSection {
  const payload = value as Partial<ReleaseNoteSection>;
  if (
    !payload
    || (payload.heading !== "Added" && payload.heading !== "Changed" && payload.heading !== "Fixed" && payload.heading !== "Removed" && payload.heading !== "Breaking Changes")
    || !Array.isArray(payload.items)
  ) {
    throw new ApiError(status, "Invalid release notes response");
  }
  return { heading: payload.heading, items: payload.items.map((item) => assertReleaseNoteItem(item, status)) };
}

function assertReleaseNoteItem(value: unknown, status: number): ReleaseNoteItem {
  const payload = value as Partial<ReleaseNoteItem>;
  if (!payload || !Array.isArray(payload.packageTags) || !payload.packageTags.every((tag) => typeof tag === "string") || typeof payload.text !== "string") {
    throw new ApiError(status, "Invalid release notes response");
  }
  return { packageTags: payload.packageTags, text: payload.text };
}

function assertTheaterFolderList(value: unknown, status: number): TheaterFolderListResponse {
  const payload = value as Partial<TheaterFolderListResponse>;
  if (
    !payload
    || typeof payload.path !== "string"
    || (payload.parentPath !== null && typeof payload.parentPath !== "string")
    || !Array.isArray(payload.roots)
    || !Array.isArray(payload.entries)
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(status, "Invalid folder list response");
  }
  return {
    path: payload.path,
    parentPath: payload.parentPath ?? null,
    roots: payload.roots.filter((entry): entry is string => typeof entry === "string"),
    entries: payload.entries.map((entry) => assertTheaterFolderListEntry(entry, status)),
    truncated: payload.truncated === true ? true : undefined,
  };
}

function assertTheaterFolderListEntry(value: unknown, status: number): TheaterFolderListEntry {
  const payload = value as Partial<TheaterFolderListEntry>;
  if (
    !payload
    || typeof payload.name !== "string"
    || typeof payload.path !== "string"
    || payload.kind !== "dir"
    || typeof payload.accessible !== "boolean"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(status, "Invalid folder entry response");
  }
  return {
    name: payload.name,
    path: payload.path,
    kind: "dir",
    accessible: payload.accessible,
  };
}

function hasForbiddenBrowserPayloadKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return FORBIDDEN_BROWSER_PAYLOAD_KEYS.some((key) => key in payload);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let message = `${response.status} ${response.statusText}`;
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown };
    if (typeof payload.error === "string") message = payload.error;
    else if (typeof payload.message === "string") message = payload.message;
  } catch {
    // non-json 오류 본문은 상태 텍스트를 사용한다.
  }
  throw new ApiError(response.status, message);
}
