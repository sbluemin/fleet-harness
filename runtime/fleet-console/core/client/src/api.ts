import type { ConsoleUpdateApplyAcceptedResponse, OperationNode, ObserverStatus, ReleaseNoteItem, ReleaseNoteSection, ReleaseNotes, ReleaseNotesResponse, TheaterBootstrap, TheaterInfo } from "./types.js";

export interface TerminalFolderListEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir";
  readonly accessible: boolean;
}

export interface TerminalFolderListResponse {
  readonly path: string;
  readonly parentPath: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly TerminalFolderListEntry[];
  readonly truncated?: true;
}

export interface ReleaseNotesFetchOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export interface OperationPatchClientInput {
  readonly title?: string;
  readonly accent?: string | null;
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
  const response = await fetch("/theaters", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { theaters?: unknown };
  if (!Array.isArray(payload.theaters)) throw new ApiError(response.status, "Invalid Theater response");
  return { theaters: payload.theaters.map((theater) => assertTheaterInfo(theater, response.status)) };
}

export async function fetchObserverStatus(theaterId: string | null, signal?: AbortSignal): Promise<ObserverStatus> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/health${suffix}`, { signal });
  await assertOk(response);
  return assertObserverStatus(await response.json(), response.status);
}

export async function fetchReleaseNotes(options: ReleaseNotesFetchOptions = {}): Promise<ReleaseNotesResponse> {
  const suffix = options.force ? "?force=true" : "";
  const response = await fetch(`/observer/release-notes${suffix}`, { signal: options.signal });
  await assertOk(response);
  return assertReleaseNotesResponse(await response.json(), response.status);
}

export async function applyConsoleUpdate(signal?: AbortSignal): Promise<ConsoleUpdateApplyAcceptedResponse> {
  const response = await fetch("/update/apply", { method: "POST", signal });
  await assertOk(response);
  return assertConsoleUpdateApplyAccepted(await response.json(), response.status);
}

export async function addTheater(folderGrantId: string, signal?: AbortSignal): Promise<TheaterInfo> {
  const response = await fetch("/theaters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId }),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as unknown;
  return assertTheaterInfo(payload, response.status);
}

export async function listTerminalFolders(path: string | null, signal?: AbortSignal): Promise<TerminalFolderListResponse> {
  const response = await fetch("/plugins/terminal/shell/folders/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
  await assertOk(response);
  return assertTerminalFolderList(await response.json(), response.status);
}

export async function issueTerminalFolderGrant(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch("/plugins/terminal/shell/folders/grants", {
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

export async function forgetTheater(theaterId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/theaters/${encodeURIComponent(theaterId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function fetchOperations(theaterId?: string | null, signal?: AbortSignal): Promise<readonly OperationNode[]> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/operations${suffix}`, { signal });
  await assertOk(response);
  const payload = await response.json() as { readonly operations?: unknown };
  if (!Array.isArray(payload.operations)) throw new ApiError(response.status, "Invalid operations response");
  return payload.operations.map((operation) => assertOperationNode(operation, response.status));
}

export async function renameOperation(operationId: string, title: string, signal?: AbortSignal): Promise<OperationNode> {
  return patchOperation(operationId, { title }, signal);
}

export async function patchOperation(operationId: string, input: OperationPatchClientInput, signal?: AbortSignal): Promise<OperationNode> {
  const response = await fetch(`/operations/${encodeURIComponent(operationId)}`, {
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
  const response = await fetch("/operations", {
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
    || (payload.parentId !== null && typeof payload.parentId !== "string")
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
    parentId: payload.parentId ?? null,
    type: payload.type,
    pluginId: payload.pluginId,
    title: payload.title,
    renamedTitle: typeof payload.renamedTitle === "string" ? payload.renamedTitle : undefined,
    payload: payload.payload,
    geometry: payload.geometry ?? null,
    state: payload.state && typeof payload.state === "object" && !Array.isArray(payload.state) ? payload.state : {},
    ts: payload.ts,
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
    || typeof payload.jobs !== "number"
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
    jobs: payload.jobs,
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
  ) {
    throw new ApiError(status, "Invalid release notes response");
  }
  return {
    version: payload.version,
    date: payload.date,
    sections: payload.sections.map((section) => assertReleaseNoteSection(section, status)),
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

function assertTerminalFolderList(value: unknown, status: number): TerminalFolderListResponse {
  const payload = value as Partial<TerminalFolderListResponse>;
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
    entries: payload.entries.map((entry) => assertTerminalFolderListEntry(entry, status)),
    truncated: payload.truncated === true ? true : undefined,
  };
}

function assertTerminalFolderListEntry(value: unknown, status: number): TerminalFolderListEntry {
  const payload = value as Partial<TerminalFolderListEntry>;
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
