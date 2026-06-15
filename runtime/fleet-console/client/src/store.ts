import { applyEvent, createEmptyJob, reduceSnapshotJob } from "./reduce.js";
import type {
  ConsoleState,
  JobView,
  ObservedEvent,
  ObservedTenant,
  ObserverStatus,
  ObserverTruncation,
  SessionInfo,
  SnapshotTenantJobs,
  TenantJobsView,
  TerminalRenderer,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
} from "./types.js";

type Listener = () => void;

export interface SessionJob {
  readonly job: JobView;
  readonly tenant: TenantJobsView;
}

const TENANT_JOB_LIMIT = 200;
const ACTIVE_THEATER_STORAGE_KEY = "fleet-console.activeTheaterId";
const THEME_STORAGE_KEY = "fleet-console.activeTheme";
const RENDERER_STORAGE_KEY = "fleet-console.terminalRenderer";
const EXPANDED_SESSIONS_STORAGE_KEY = "fleet-console.expandedSessions";
const DEFAULT_THEME: ThemeId = "maritime";
const DEFAULT_RENDERER: TerminalRenderer = "webgl";
export const SHELL_SESSION_ID = "shell";

const listeners = new Set<Listener>();
let state: ConsoleState = {
  connection: "connecting",
  connectionError: null,
  activeTheme: readStoredTheme(),
  terminalRenderer: readStoredRenderer(),
  updateAvailable: false,
  latestVersion: null,
  tenants: [],
  theaters: [],
  agentClis: [],
  activeTheaterId: null,
  addingTheater: false,
  theaterError: null,
  sessions: {},
  sessionOrder: [],
  activeTerminalSessionId: null,
  creatingTerminalSession: false,
  terminalSessionError: null,
  tenantJobs: {},
  tenantOrder: [],
  timelineOpen: false,
  shellOpen: false,
  selectedJobId: null,
  expandedSessionIds: readStoredExpandedSessions(),
};

export function getState(): ConsoleState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setState(patch: Partial<ConsoleState>): void {
  state = { ...state, ...patch };
  emit();
}

export function initThemeFromStorage(): void {
  applyThemeToDocument(readStoredTheme());
}

export function setActiveTheme(theme: ThemeId): void {
  writeStoredTheme(theme);
  applyThemeToDocument(theme);
  setState({ activeTheme: theme });
}

export function setTerminalRenderer(renderer: TerminalRenderer): void {
  writeStoredRenderer(renderer);
  setState({ terminalRenderer: renderer });
}

export function readStoredRenderer(): TerminalRenderer {
  if (typeof window === "undefined") return DEFAULT_RENDERER;
  try {
    const stored = window.localStorage.getItem(RENDERER_STORAGE_KEY);
    return stored === "webgl" || stored === "dom" ? stored : DEFAULT_RENDERER;
  } catch {
    return DEFAULT_RENDERER;
  }
}

export function applyObserverStatus(status: ObserverStatus): void {
  setState({
    updateAvailable: status.updateAvailable,
    latestVersion: status.latestVersion ?? null,
  });
}

export function applyThemeToDocument(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  if (theme === "maritime") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }
  document.documentElement.setAttribute("data-theme", theme);
}

export function hydrateTerminalSessions(sessions: readonly SessionInfo[]): void {
  const byId: Record<string, SessionInfo> = {};
  for (const session of sessions) byId[session.sessionId] = normalizeSession(session);
  const sessionOrder = [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId);
  const merged = mergeTenantBindings(byId, state.tenants);
  setState({
    sessions: merged,
    sessionOrder,
    activeTerminalSessionId: resolveVisibleSessionId(state.activeTheaterId, merged, sessionOrder, state.activeTerminalSessionId),
  });
}

export function hydrateTheaters(theaters: readonly TheaterInfo[]): void {
  const activeTheaterId = chooseActiveTheaterId(theaters, state.activeTheaterId);
  setState({
    theaters,
    activeTheaterId,
    activeTerminalSessionId: resolveVisibleSessionId(activeTheaterId, state.sessions, state.sessionOrder, state.activeTerminalSessionId),
    selectedJobId: null,
  });
}

export function hydrateTheaterBootstrap(bootstrap: TheaterBootstrap): void {
  const activeTheaterId = chooseActiveTheaterId(bootstrap.theaters, state.activeTheaterId);
  setState({
    theaters: bootstrap.theaters,
    agentClis: bootstrap.agentClis,
    activeTheaterId,
    activeTerminalSessionId: resolveVisibleSessionId(activeTheaterId, state.sessions, state.sessionOrder, state.activeTerminalSessionId),
    selectedJobId: null,
  });
}

export function setActiveTheater(theaterId: string | null): void {
  writeStoredActiveTheaterId(theaterId);
  setState({
    activeTheaterId: theaterId,
    activeTerminalSessionId: resolveVisibleSessionId(theaterId, state.sessions, state.sessionOrder, null),
    selectedJobId: null,
  });
}

export function beginAddTheater(): void {
  setState({ addingTheater: true, theaterError: null });
}

export function completeAddTheater(theater: TheaterInfo): void {
  const theaters = [theater, ...state.theaters.filter((item) => item.id !== theater.id)];
  writeStoredActiveTheaterId(theater.id);
  setState({
    theaters,
    activeTheaterId: theater.id,
    addingTheater: false,
    theaterError: null,
    activeTerminalSessionId: resolveVisibleSessionId(theater.id, state.sessions, state.sessionOrder, null),
    selectedJobId: null,
  });
}

export function cancelAddTheater(): void {
  setState({ addingTheater: false, theaterError: null });
}

export function failAddTheater(error: string): void {
  setState({ addingTheater: false, theaterError: error });
}

export function selectTerminalSession(sessionId: string | null): void {
  setState({ activeTerminalSessionId: sessionId, selectedJobId: null });
}

export function beginCreateTerminalSession(): void {
  setState({ creatingTerminalSession: true, terminalSessionError: null });
}

export function completeCreateTerminalSession(session: SessionInfo): void {
  const normalized = normalizeSession(session);
  setState({
    sessions: { ...state.sessions, [normalized.sessionId]: normalized },
    sessionOrder: [normalized.sessionId, ...state.sessionOrder.filter((sessionId) => sessionId !== normalized.sessionId)],
    activeTerminalSessionId: !state.activeTheaterId || sessionBelongsToTheater(normalized, state.activeTheaterId) ? normalized.sessionId : state.activeTerminalSessionId,
    creatingTerminalSession: false,
    terminalSessionError: null,
    selectedJobId: null,
  });
}

export function applySessionUpdate(session: SessionInfo): void {
  const current = state.sessions[session.sessionId];
  const normalized = normalizeSession({ ...(current ?? {}), ...session });
  const known = Boolean(current);
  const sessions = { ...state.sessions, [normalized.sessionId]: normalized };
  const sessionOrder = known
    ? state.sessionOrder
    : [normalized.sessionId, ...state.sessionOrder.filter((sessionId) => sessionId !== normalized.sessionId)];
  setState({
    sessions,
    sessionOrder,
    activeTerminalSessionId: resolveVisibleSessionId(state.activeTheaterId, sessions, sessionOrder, state.activeTerminalSessionId),
  });
}

export function failCreateTerminalSession(error: string): void {
  setState({ creatingTerminalSession: false, terminalSessionError: error });
}

export function toggleTimeline(): void {
  setState({ timelineOpen: !state.timelineOpen });
}

export function toggleShell(): void {
  if (state.shellOpen) {
    closeShell();
    return;
  }
  setState({ shellOpen: true });
}

export function closeShell(): void {
  if (!state.shellOpen) return;
  // 오버레이를 닫아도(X·Escape·scrim·토글) shell PTY는 종료하지 않는다 — 오버레이는 숨겨질 뿐이고
  // 백엔드 세션은 살아남아, 다시 열 때 기존 셸 프로세스·scrollback·cwd에 그대로 재부착된다.
  // shell PTY는 셸이 스스로 종료(exit)하거나 콘솔 서버가 멈출 때만 사라진다.
  setState({ shellOpen: false });
}

export function toggleTerminalZoom(sessionId: string): void {
  const expandedSessionIds = state.expandedSessionIds.includes(sessionId)
    ? state.expandedSessionIds.filter((id) => id !== sessionId)
    : [...state.expandedSessionIds, sessionId];
  writeStoredExpandedSessions(expandedSessionIds);
  setState({ expandedSessionIds });
}

export function failTerminateTerminalSession(error: string): void {
  // 종료 실패 시 카드는 남기고 사이드바 오류 라인에만 사유를 표기한다(살아있는 PTY를 숨기지 않는다).
  setState({ terminalSessionError: error });
}

export function failRenameTerminalSession(error: string): void {
  // 이름 변경 실패 시 세션 카드는 그대로 두고 사이드바 오류 라인에만 사유를 표기한다.
  setState({ terminalSessionError: error });
}

export function removeTerminalSession(sessionId: string): void {
  if (!state.sessions[sessionId]) return;
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  const sessionOrder = state.sessionOrder.filter((id) => id !== sessionId);
  const expandedSessionIds = state.expandedSessionIds.filter((id) => id !== sessionId);
  const wasActive = state.activeTerminalSessionId === sessionId;
  writeStoredExpandedSessions(expandedSessionIds);
  setState({
    sessions,
    sessionOrder,
    activeTerminalSessionId: wasActive ? sessionOrder[0] ?? null : state.activeTerminalSessionId,
    selectedJobId: wasActive ? null : state.selectedJobId,
    expandedSessionIds,
  });
}

export function selectJob(jobId: string): void {
  setState({ selectedJobId: state.selectedJobId === jobId ? null : jobId });
}

export function clearSelectedJob(): void {
  setState({ selectedJobId: null });
}

export function applyTenantSnapshot(tenants: readonly ObservedTenant[]): void {
  const known = new Set(tenants.map((tenant) => tenant.tenantId));
  const sessions = mergeTenantBindings(state.sessions, tenants);
  const tenantOrder = [
    ...tenants.map((tenant) => tenant.tenantId),
    ...state.tenantOrder.filter((tenantId) => !known.has(tenantId) && state.tenantJobs[tenantId]),
  ];
  setState({
    tenants,
    sessions,
    tenantOrder,
    activeTerminalSessionId: resolveVisibleSessionId(state.activeTheaterId, sessions, state.sessionOrder, state.activeTerminalSessionId),
  });
}

export function applyJobsSnapshot(snapshot: readonly SnapshotTenantJobs[]): void {
  const tenantJobs: Record<string, TenantJobsView> = {};
  const tenantOrder: string[] = [];
  for (const tenant of snapshot) {
    const jobs: Record<string, JobView> = {};
    for (const job of tenant.jobs) {
      jobs[job.jobId] = reduceSnapshotJob(tenant.tenantId, job);
    }
    const jobOrder = Object.values(jobs)
      .sort((a, b) => (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt))
      .map((job) => job.jobId);
    tenantJobs[tenant.tenantId] = {
      tenantId: tenant.tenantId,
      tenantLabel: tenant.tenantLabel,
      jobOrder,
      jobs,
      truncation: tenant.truncation,
    };
    tenantOrder.push(tenant.tenantId);
  }
  const mergedOrder = [
    ...state.tenantOrder.filter((tenantId) => tenantJobs[tenantId]),
    ...tenantOrder.filter((tenantId) => !state.tenantOrder.includes(tenantId)),
  ];
  setState({
    tenantJobs,
    tenantOrder: mergedOrder.length > 0 ? mergedOrder : tenantOrder,
  });
}

export function applyObservedEvent(event: ObservedEvent, tenantLabel?: string): { readonly unknownTenant: boolean } {
  const existingTenant = state.tenantJobs[event.tenantId];
  const unknownTenant = !existingTenant && !state.tenants.some((tenant) => tenant.tenantId === event.tenantId);
  const tenant: TenantJobsView = existingTenant ?? {
    tenantId: event.tenantId,
    tenantLabel,
    jobOrder: [],
    jobs: {},
    truncation: { droppedCount: 0 },
  };
  let nextTenant = tenantLabel && tenant.tenantLabel !== tenantLabel ? { ...tenant, tenantLabel } : tenant;
  if (event.jobId) {
    const existingJob = nextTenant.jobs[event.jobId];
    const job = applyEvent(existingJob ?? createEmptyJob(event.tenantId, event.jobId, event.at), event);
    const jobOrder = existingJob ? nextTenant.jobOrder : [...nextTenant.jobOrder, event.jobId];
    nextTenant = {
      ...nextTenant,
      jobs: pruneJobs({ ...nextTenant.jobs, [event.jobId]: job }, jobOrder),
      jobOrder: jobOrder.slice(-TENANT_JOB_LIMIT),
    };
  }
  const nextTenantJobs = { ...state.tenantJobs, [event.tenantId]: nextTenant };
  state = {
    ...state,
    connection: "live",
    connectionError: null,
    tenantJobs: nextTenantJobs,
    tenantOrder: state.tenantOrder.includes(event.tenantId) ? state.tenantOrder : [...state.tenantOrder, event.tenantId],
  };
  emit();
  return { unknownTenant };
}

export function applyTruncation(tenantId: string, tenantLabel: string | undefined, truncation: ObserverTruncation): void {
  const existing = state.tenantJobs[tenantId] ?? {
    tenantId,
    tenantLabel,
    jobOrder: [],
    jobs: {},
    truncation: { droppedCount: 0 },
  };
  setState({
    tenantJobs: { ...state.tenantJobs, [tenantId]: { ...existing, truncation } },
    tenantOrder: state.tenantOrder.includes(tenantId) ? state.tenantOrder : [...state.tenantOrder, tenantId],
  });
}

export function selectedJob(current: ConsoleState): JobView | null {
  if (!current.selectedJobId) return null;
  if (current.activeTheaterId && current.activeTerminalSessionId && !theaterSessionOrder(current).includes(current.activeTerminalSessionId)) return null;
  const tenantId = activeSessionTenantId(current);
  if (!tenantId) return null;
  return current.tenantJobs[tenantId]?.jobs[current.selectedJobId] ?? null;
}

export function activeSessionTenantId(current: ConsoleState): string | null {
  if (!current.activeTerminalSessionId) return null;
  return resolveSessionTenantId(current.sessions[current.activeTerminalSessionId]);
}

export function activeTheater(current: ConsoleState): TheaterInfo | null {
  return current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
}

export function theaterSessions(current: ConsoleState): readonly SessionInfo[] {
  return theaterSessionOrder(current).map((sessionId) => current.sessions[sessionId]).filter((session): session is SessionInfo => Boolean(session));
}

export function theaterSessionOrder(current: ConsoleState): readonly string[] {
  if (!current.activeTheaterId) return [];
  return current.sessionOrder.filter((sessionId) => sessionBelongsToTheater(current.sessions[sessionId], current.activeTheaterId));
}

export function sessionJobs(current: ConsoleState, session: SessionInfo): readonly SessionJob[] {
  const tenantId = resolveSessionTenantId(session);
  if (!tenantId) return [];
  const tenant = current.tenantJobs[tenantId];
  if (!tenant) return [];
  const jobs: SessionJob[] = [];
  for (const jobId of tenant.jobOrder) {
    const job = tenant.jobs[jobId];
    if (job) jobs.push({ job, tenant });
  }
  return jobs;
}

export function isSessionExpanded(current: ConsoleState, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return current.expandedSessionIds.includes(sessionId);
}

export function resolveSessionTenantId(session: SessionInfo | undefined): string | null {
  return session?.tenantId ?? session?.sessionId ?? null;
}

export function collectSessionTenantIds(sessions: Readonly<Record<string, SessionInfo>>, sessionOrder: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const sessionId of sessionOrder) {
    const tenantId = resolveSessionTenantId(sessions[sessionId]);
    if (tenantId) ids.add(tenantId);
  }
  return ids;
}

function normalizeSession(session: SessionInfo): SessionInfo {
  return {
    ...session,
    terminalSessionId: session.terminalSessionId ?? session.sessionId,
    status: session.status === "starting" && session.tenantId ? "registered" : session.status,
  };
}

function mergeTenantBindings(sessions: Readonly<Record<string, SessionInfo>>, tenants: readonly ObservedTenant[]): Record<string, SessionInfo> {
  const next = { ...sessions };
  for (const tenant of tenants) {
    if (!tenant.terminalSessionId) continue;
    const session = next[tenant.terminalSessionId];
    if (!session) continue;
    next[tenant.terminalSessionId] = {
      ...session,
      status: tenant.status === "closed" ? "closed" : "registered",
      tenantId: tenant.tenantId,
      registrationId: tenant.registrationId,
      theaterId: tenant.theaterId ?? session.theaterId,
    };
  }
  return next;
}

function chooseActiveTheaterId(theaters: readonly TheaterInfo[], currentActiveId: string | null): string | null {
  const ids = new Set(theaters.map((theater) => theater.id));
  const stored = readStoredActiveTheaterId();
  if (stored && ids.has(stored)) return stored;
  if (currentActiveId && ids.has(currentActiveId)) return currentActiveId;
  return theaters[0]?.id ?? null;
}

function resolveVisibleSessionId(
  theaterId: string | null,
  sessions: Readonly<Record<string, SessionInfo>>,
  sessionOrder: readonly string[],
  preferredSessionId: string | null,
): string | null {
  if (!theaterId) return preferredSessionId && sessions[preferredSessionId] ? preferredSessionId : sessionOrder[0] ?? null;
  if (preferredSessionId && sessionBelongsToTheater(sessions[preferredSessionId], theaterId)) return preferredSessionId;
  return sessionOrder.find((sessionId) => sessionBelongsToTheater(sessions[sessionId], theaterId)) ?? null;
}

function sessionBelongsToTheater(session: SessionInfo | undefined, theaterId: string | null): boolean {
  if (!session || !theaterId) return false;
  return session.theaterId === theaterId;
}

function readStoredActiveTheaterId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_THEATER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredActiveTheaterId(theaterId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (theaterId) {
      window.localStorage.setItem(ACTIVE_THEATER_STORAGE_KEY, theaterId);
    } else {
      window.localStorage.removeItem(ACTIVE_THEATER_STORAGE_KEY);
    }
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function readStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "maritime" || stored === "carbon" ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function readStoredExpandedSessions(): readonly string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(EXPANDED_SESSIONS_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeStoredTheme(theme: ThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function writeStoredRenderer(renderer: TerminalRenderer): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RENDERER_STORAGE_KEY, renderer);
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function writeStoredExpandedSessions(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EXPANDED_SESSIONS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function pruneJobs(jobs: Record<string, JobView>, order: readonly string[]): Record<string, JobView> {
  if (order.length <= TENANT_JOB_LIMIT) return jobs;
  const keep = new Set(order.slice(-TENANT_JOB_LIMIT));
  const pruned: Record<string, JobView> = {};
  for (const jobId of Object.keys(jobs)) {
    if (keep.has(jobId)) pruned[jobId] = jobs[jobId]!;
  }
  return pruned;
}

function emit(): void {
  for (const listener of listeners) listener();
}
