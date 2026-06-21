import type { AgentCliMetadata, ConsoleUpdateApplyAcceptedResponse, ObservedTenant, ObserverStatus, ReleaseNoteItem, ReleaseNoteSection, ReleaseNotes, ReleaseNotesResponse, SessionInfo, SnapshotTenantJobs, TheaterBootstrap, TheaterInfo } from "./types.js";

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

export interface TerminalTicketOptions {
  readonly kind?: "shell";
  // theater-shell(shell:<seq>) 티켓에서만 사용 — 서버가 이 id로 Theater 디렉터리를 cwd로 해석한다(raw 경로는 클라이언트에 없음).
  readonly theaterId?: string;
  readonly signal?: AbortSignal;
}

export interface ReleaseNotesFetchOptions {
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

const FORBIDDEN_BROWSER_PAYLOAD_KEYS = ["canonicalCwd", "cwd", "providerSession", "ticket", "token", "transcriptPath"] as const;

/** HTTP status를 보존하는 API 오류. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function fetchTenants(signal?: AbortSignal): Promise<readonly ObservedTenant[]> {
  const response = await fetch("/observer/tenants", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { tenants?: unknown };
  if (!Array.isArray(payload.tenants)) throw new ApiError(response.status, "Invalid tenants response");
  return payload.tenants.map((tenant) => assertObservedTenant(tenant, response.status));
}

export async function fetchJobs(signal?: AbortSignal): Promise<readonly SnapshotTenantJobs[]> {
  const response = await fetch("/observer/jobs", { signal });
  await assertOk(response);
  return ((await response.json()) as { tenants: readonly SnapshotTenantJobs[] }).tenants;
}

export async function openEventsStream(signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch("/observer/events", { signal });
  await assertOk(response);
  if (!response.body) throw new ApiError(response.status, "Observer stream unavailable");
  return response.body.getReader();
}

export async function fetchTheaters(signal?: AbortSignal): Promise<readonly TheaterInfo[]> {
  return (await fetchTheaterBootstrap(signal)).theaters;
}

export async function fetchTheaterBootstrap(signal?: AbortSignal): Promise<TheaterBootstrap> {
  const response = await fetch("/observer/theaters", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { theaters?: unknown; agentClis?: unknown };
  if (!Array.isArray(payload.theaters)) throw new ApiError(response.status, "Invalid Theater response");
  const agentClis = Array.isArray(payload.agentClis) ? payload.agentClis.map((item) => assertAgentCliMetadata(item, response.status)) : [];
  return { theaters: payload.theaters.map((theater) => assertTheaterInfo(theater, response.status)), agentClis };
}

export async function fetchObserverStatus(theaterId: string | null, signal?: AbortSignal): Promise<ObserverStatus> {
  const suffix = theaterId ? `?theaterId=${encodeURIComponent(theaterId)}` : "";
  const response = await fetch(`/observer/status${suffix}`, { signal });
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
  const response = await fetch("/observer/theaters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId }),
    signal,
  });
  await assertOk(response);
  const payload = await response.json() as unknown;
  return assertTheaterInfo(payload, response.status);
}

export async function createTheaterTerminalSession(theaterId: string, cliId?: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch(`/observer/theaters/${encodeURIComponent(theaterId)}/sessions`, {
    method: "POST",
    ...(cliId ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cliId }) } : {}),
    signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function listTerminalFolders(path: string | null, signal?: AbortSignal): Promise<TerminalFolderListResponse> {
  const response = await fetch("/terminal/folders/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal,
  });
  await assertOk(response);
  return assertTerminalFolderList(await response.json(), response.status);
}

export async function issueTerminalFolderGrant(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch("/terminal/folders/grants", {
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

export async function createTerminalSession(folderGrantId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch("/terminal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderGrantId }),
    signal,
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function terminateTerminalSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/terminal/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function resumeTerminalSession(sessionId: string, signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch(`/terminal/sessions/${encodeURIComponent(sessionId)}/resume`, { method: "POST", signal });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function forgetTheater(theaterId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/observer/theaters/${encodeURIComponent(theaterId)}`, { method: "DELETE", signal });
  await assertOk(response);
}

export async function renameTerminalSession(sessionId: string, label: string): Promise<SessionInfo> {
  const response = await fetch(`/terminal/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  await assertOk(response);
  return assertSessionInfo(await response.json(), response.status);
}

export async function fetchTerminalSessions(signal?: AbortSignal): Promise<readonly SessionInfo[]> {
  const response = await fetch("/terminal/sessions", { signal });
  await assertOk(response);
  const payload = (await response.json()) as { sessions?: unknown };
  if (!Array.isArray(payload.sessions)) throw new ApiError(response.status, "Invalid terminal sessions response");
  return payload.sessions.map((session) => assertSessionInfo(session, response.status));
}

export async function requestTerminalTicket(sessionId: string, options?: AbortSignal | TerminalTicketOptions): Promise<{ readonly ticket: string; readonly ttlMs: number }> {
  const ticketOptions = normalizeTerminalTicketOptions(options);
  const response = await fetch("/terminal/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      ...(ticketOptions.kind ? { kind: ticketOptions.kind } : {}),
      ...(ticketOptions.theaterId ? { theaterId: ticketOptions.theaterId } : {}),
    }),
    signal: ticketOptions.signal,
  });
  await assertOk(response);
  const payload = (await response.json()) as { ticket?: unknown; ttlMs?: unknown };
  if (typeof payload.ticket !== "string" || typeof payload.ttlMs !== "number") {
    throw new ApiError(response.status, "Invalid terminal ticket response");
  }
  return { ticket: payload.ticket, ttlMs: payload.ttlMs };
}

function normalizeTerminalTicketOptions(options: AbortSignal | TerminalTicketOptions | undefined): TerminalTicketOptions {
  if (!options) return {};
  if (options instanceof AbortSignal) return { signal: options };
  return options;
}

function assertSessionInfo(value: unknown, status: number): SessionInfo {
  const payload = value as Partial<SessionInfo>;
  if (
    !payload
    || typeof payload.sessionId !== "string"
    || typeof payload.cwdLabel !== "string"
    || typeof payload.sequence !== "number"
    || typeof payload.status !== "string"
    || typeof payload.createdAt !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(status, "Invalid terminal session response");
  }
  return {
    sessionId: payload.sessionId,
    terminalSessionId: typeof payload.terminalSessionId === "string" ? payload.terminalSessionId : payload.sessionId,
    cwdLabel: payload.cwdLabel,
    sequence: payload.sequence,
    label: typeof payload.label === "string" ? payload.label : undefined,
    cliId: typeof payload.cliId === "string" ? payload.cliId : undefined,
    cliLabel: typeof payload.cliLabel === "string" ? payload.cliLabel : undefined,
    status: payload.status,
    turnState: payload.turnState === "running" || payload.turnState === "ended" ? payload.turnState : "none",
    createdAt: payload.createdAt,
    theaterId: typeof payload.theaterId === "string" ? payload.theaterId : undefined,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
    resumeAvailable: payload.resumeAvailable === true,
  };
}

function assertTerminalFolderList(value: unknown, status: number): TerminalFolderListResponse {
  const payload = value as Partial<TerminalFolderListResponse>;
  if (
    !payload
    || typeof payload.path !== "string"
    || (payload.parentPath !== null && typeof payload.parentPath !== "string")
    || !Array.isArray(payload.roots)
    || !payload.roots.every((root) => typeof root === "string")
    || !Array.isArray(payload.entries)
  ) {
    throw new ApiError(status, "Invalid folder list response");
  }
  return {
    path: payload.path,
    parentPath: payload.parentPath,
    roots: payload.roots,
    entries: payload.entries.map((entry) => assertTerminalFolderListEntry(entry, status)),
    ...(payload.truncated === true ? { truncated: true } : {}),
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
  ) {
    throw new ApiError(status, "Invalid folder list response");
  }
  return { name: payload.name, path: payload.path, kind: "dir", accessible: payload.accessible };
}

function assertAgentCliMetadata(value: unknown, status: number): AgentCliMetadata {
  const payload = value as Partial<AgentCliMetadata>;
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.label !== "string"
    || typeof payload.available !== "boolean"
    || typeof payload.signedIn !== "boolean"
  ) {
    throw new ApiError(status, "Invalid Agent CLI metadata response");
  }
  return { id: payload.id, label: payload.label, available: payload.available, signedIn: payload.signedIn };
}

function assertObservedTenant(value: unknown, status: number): ObservedTenant {
  const payload = value as Partial<ObservedTenant>;
  if (
    !payload
    || typeof payload.tenantId !== "string"
    || typeof payload.tenantLabel !== "string"
    || typeof payload.createdAt !== "number"
    || typeof payload.sessions !== "number"
    || hasForbiddenBrowserPayloadKey(payload)
  ) {
    throw new ApiError(status, "Invalid tenants response");
  }
  return {
    tenantId: payload.tenantId,
    tenantLabel: payload.tenantLabel,
    createdAt: payload.createdAt,
    sessions: payload.sessions,
    status: payload.status,
    cliRunId: typeof payload.cliRunId === "string" ? payload.cliRunId : undefined,
    registrationId: typeof payload.registrationId === "string" ? payload.registrationId : undefined,
    theaterId: typeof payload.theaterId === "string" ? payload.theaterId : undefined,
    terminalSessionId: typeof payload.terminalSessionId === "string" ? payload.terminalSessionId : undefined,
  };
}

function hasForbiddenBrowserPayloadKey(payload: object): boolean {
  return FORBIDDEN_BROWSER_PAYLOAD_KEYS.some((key) => key in payload);
}

function assertObserverStatus(value: unknown, status: number): ObserverStatus {
  const payload = value as Partial<ObserverStatus> & {
    readonly token?: unknown;
    readonly path?: unknown;
    readonly cwd?: unknown;
    readonly knowledgeRoot?: unknown;
  };
  if (
    !payload
    || typeof payload.workspaces !== "number"
    || typeof payload.jobs !== "number"
    || typeof payload.version !== "string"
    || (payload.channel !== "stable" && payload.channel !== "local" && payload.channel !== "unknown")
    || typeof payload.updateAvailable !== "boolean"
    || (payload.latestVersion !== undefined && typeof payload.latestVersion !== "string")
    || typeof payload.port !== "number"
    || (payload.wikiServerStatus !== "available" && payload.wikiServerStatus !== "unavailable" && payload.wikiServerStatus !== "unknown")
    || "token" in payload
    || "path" in payload
    || "cwd" in payload
    || "knowledgeRoot" in payload
  ) {
    throw new ApiError(status, "Invalid observer status response");
  }
  return {
    workspaces: payload.workspaces,
    jobs: payload.jobs,
    version: payload.version,
    channel: payload.channel,
    updateAvailable: payload.updateAvailable,
    ...(payload.latestVersion !== undefined ? { latestVersion: payload.latestVersion } : {}),
    port: payload.port,
    wikiServerStatus: payload.wikiServerStatus,
  };
}

function assertConsoleUpdateApplyAccepted(value: unknown, status: number): ConsoleUpdateApplyAcceptedResponse {
  const payload = value as Partial<ConsoleUpdateApplyAcceptedResponse> & {
    readonly packageName?: unknown;
    readonly packageVersion?: unknown;
    readonly path?: unknown;
    readonly token?: unknown;
  };
  if (
    !payload
    || payload.status !== "accepted"
    || "packageName" in payload
    || "packageVersion" in payload
    || "path" in payload
    || "token" in payload
  ) {
    throw new ApiError(status, "Invalid update apply response");
  }
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

function assertTheaterInfo(value: unknown, status: number): TheaterInfo {
  const payload = value as Partial<TheaterInfo> & { readonly path?: unknown };
  if (
    !payload
    || typeof payload.id !== "string"
    || typeof payload.label !== "string"
    || "path" in payload
    || typeof payload.createdAt !== "string"
    || typeof payload.lastOpenedAt !== "string"
    || typeof payload.hasWiki !== "boolean"
    || typeof payload.activeAdmiralCount !== "number"
  ) {
    throw new ApiError(status, "Invalid Theater response");
  }
  return {
    id: payload.id,
    label: payload.label,
    createdAt: payload.createdAt,
    lastOpenedAt: payload.lastOpenedAt,
    hasWiki: payload.hasWiki,
    activeAdmiralCount: payload.activeAdmiralCount,
  };
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  let detail = response.statusText;
  try {
    detail = ((await response.json()) as { error?: string }).error ?? detail;
  } catch {
    // 오류 본문은 운영자 안내용 best-effort다.
  }
  throw new ApiError(response.status, detail || `HTTP ${response.status}`);
}
