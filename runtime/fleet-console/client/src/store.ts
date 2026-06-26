import { applyEvent, createEmptyJob, isTerminalJobStatus, reduceSnapshotJob } from "./reduce.js";
import { sessionDisplayLabel } from "./format.js";
import { buildOperationSearchEntries } from "./operation-search.js";
import { clearStoredShellPanelsForTheater } from "./canvas/shell-panels.js";
import {
  createCuratedTerminalFontSettings,
  createCustomTerminalFontSettings,
  parseStoredTerminalFontSettings,
  serializeTerminalFontSettings,
} from "./terminal-font.js";
import type {
  AttentionReason,
  ConsoleState,
  JobView,
  NotificationKind,
  NotificationPreferences,
  ObservedEvent,
  ObservedTenant,
  ObserverStatus,
  ObserverTruncation,
  OperationNotification,
  ReleaseNotesResponse,
  SessionInfo,
  SnapshotTenantJobs,
  TenantJobsView,
  TerminalFontId,
  TerminalFontSettings,
  TerminalRenderer,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
  TurnState,
} from "./types.js";

type Listener = () => void;

export interface SessionJob {
  readonly job: JobView;
  readonly tenant: TenantJobsView;
}

type SessionInput = Omit<SessionInfo, "resumeAvailable" | "turnState"> & { readonly resumeAvailable?: boolean; readonly turnState?: TurnState };

const TENANT_JOB_LIMIT = 200;
const ACTIVE_THEATER_STORAGE_KEY = "fleet-console.activeTheaterId";
const THEME_STORAGE_KEY = "fleet-console.activeTheme";
const RENDERER_STORAGE_KEY = "fleet-console.terminalRenderer";
const TERMINAL_FONT_STORAGE_KEY = "fleet-console.terminalFont";
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
const WHATS_NEW_SEEN_VERSION_STORAGE_KEY = "fleet-console.whatsNewSeenVersion";
const NOTIFICATION_PREFERENCES_STORAGE_KEY = "fleet-console.notificationPreferences";
const NOTIFICATION_PREFERENCES_VERSION = 1;
const DEFAULT_THEME: ThemeId = "maritime";
const DEFAULT_RENDERER: TerminalRenderer = "webgl";
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  globalMute: false,
  dnd: false,
  mutedTheaterIds: {},
};

const listeners = new Set<Listener>();
// localStorage가 막히거나(privacy/enterprise) 예외를 던지는 환경에서도 같은 세션 내 재팝업을 막는 in-memory 폴백.
let whatsNewSeenVersionMemo: string | null = null;

let state: ConsoleState = {
  connection: "connecting",
  connectionError: null,
  activeTheme: readStoredTheme(),
  terminalRenderer: readStoredRenderer(),
  terminalFont: readStoredTerminalFont(),
  version: "",
  updateAvailable: false,
  latestVersion: null,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  tenants: [],
  theaters: [],
  agentClis: [],
  activeTheaterId: null,
  addingTheater: false,
  theaterError: null,
  sessions: {},
  sessionOrder: [],
  activeTerminalSessionId: null,
  operationsViewActive: false,
  creatingTerminalSession: false,
  terminalSessionError: null,
  tenantJobs: {},
  tenantOrder: [],
  timelineOpen: false,
  operationSearchOpen: false,
  shortcutsOpen: false,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLoading: false,
  releaseNotesError: null,
  releaseNotesSourceRef: null,
  releaseNotesFetchedAt: null,
  releaseNotesStale: false,
  automaticWhatsNewVersion: null,
  selectedReleaseNoteKey: null,
  onboardingOpen: false,
  bootstrapped: false,
  terminalSessionsHydrated: false,
  pendingOperationFocus: null,
  selectedJobId: null,
  operationNotifications: {},
  notificationPreferences: readStoredNotificationPreferences(),
};

let operationNotificationSeq = 0;

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

// 라우트 변경 시 App이 호출해 Operations 뷰(/operations)의 화면 표시 여부를 추적한다.
// 라우팅은 react-router, 관측 데이터는 store로 분리되어 있어 라우트 전이가 store를 직접 갱신하지 않으므로,
// 토스트 억제 판단이 "활성 세션 선택"과 "그 세션 화면 표시"를 구분할 수 있도록 명시적으로 반영한다.
export function setOperationsViewActive(active: boolean): void {
  if (state.operationsViewActive === active) return;
  setState({ operationsViewActive: active });
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

export function setTerminalFont(fontId: TerminalFontId): void {
  const terminalFont = createCuratedTerminalFontSettings(fontId, state.terminalFont.size);
  writeStoredTerminalFont(terminalFont);
  setState({ terminalFont });
}

export function setCustomTerminalFont(customName: string): void {
  const terminalFont = createCustomTerminalFontSettings(customName, state.terminalFont.size);
  writeStoredTerminalFont(terminalFont);
  setState({ terminalFont });
}

export function setTerminalFontSize(size: number): void {
  const terminalFont = state.terminalFont.source === "custom"
    ? createCustomTerminalFontSettings(state.terminalFont.customName, size)
    : createCuratedTerminalFontSettings(state.terminalFont.id, size);
  writeStoredTerminalFont(terminalFont);
  setState({ terminalFont });
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

export function readStoredTerminalFont(): TerminalFontSettings {
  if (typeof window === "undefined") return parseStoredTerminalFontSettings(null);
  try {
    return parseStoredTerminalFontSettings(window.localStorage.getItem(TERMINAL_FONT_STORAGE_KEY));
  } catch {
    return parseStoredTerminalFontSettings(null);
  }
}

export function applyObserverStatus(status: ObserverStatus): void {
  setState({
    version: status.version,
    updateAvailable: status.updateAvailable,
    latestVersion: status.latestVersion ?? null,
    portMode: status.portMode,
    requestedPort: status.requestedPort,
    effectivePort: status.effectivePort,
    portHonored: status.portHonored,
    ...evaluateAutomaticWhatsNew({ ...state, version: status.version }),
  });
}

export function beginReleaseNotesFetch(): void {
  setState({ releaseNotesLoading: true, releaseNotesError: null });
}

export function applyReleaseNotes(response: ReleaseNotesResponse): void {
  const next = {
    ...state,
    releaseNotes: response.notes,
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: response.sourceRef,
    releaseNotesFetchedAt: response.fetchedAt,
    releaseNotesStale: response.stale,
    selectedReleaseNoteKey: state.selectedReleaseNoteKey && releaseNoteKeyExists(response.notes, state.selectedReleaseNoteKey)
      ? state.selectedReleaseNoteKey
      : firstReleaseNoteKey(response.notes),
  };
  setState({
    releaseNotes: next.releaseNotes,
    releaseNotesLoading: next.releaseNotesLoading,
    releaseNotesError: next.releaseNotesError,
    releaseNotesSourceRef: next.releaseNotesSourceRef,
    releaseNotesFetchedAt: next.releaseNotesFetchedAt,
    releaseNotesStale: next.releaseNotesStale,
    ...evaluateAutomaticWhatsNew(next),
  });
}

export function failReleaseNotesFetch(error: string): void {
  setState({ releaseNotesLoading: false, releaseNotesError: error });
}

export function applyThemeToDocument(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  if (theme === "maritime") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }
  document.documentElement.setAttribute("data-theme", theme);
}

export function hydrateTerminalSessions(sessions: readonly SessionInput[]): void {
  const byId: Record<string, SessionInfo> = {};
  for (const session of sessions) byId[session.sessionId] = normalizeSession(session);
  const sessionOrder = [...sessions].sort((a, b) => b.createdAt - a.createdAt).map((session) => session.sessionId);
  const merged = mergeTenantBindings(byId, state.tenants);
  setState({
    sessions: merged,
    sessionOrder,
    activeTerminalSessionId: resolveVisibleSessionId(state.activeTheaterId, merged, sessionOrder, state.activeTerminalSessionId),
    // 첫 스냅샷 적재 완료를 표시한다(단방향). 이후 패널 prune이 빈 sessionOrder를 권위 있는 상태로 신뢰한다.
    terminalSessionsHydrated: true,
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
  setState({
    activeTerminalSessionId: sessionId,
    selectedJobId: null,
    operationNotifications: sessionId ? removeNotificationForSession(state.operationNotifications, sessionId) : state.operationNotifications,
  });
}

export function focusOperation(sessionId: string): void {
  const session = state.sessions[sessionId];
  if (!session) return;
  writeStoredActiveTheaterId(session.theaterId ?? null);
  setState({
    activeTheaterId: session.theaterId ?? null,
    activeTerminalSessionId: sessionId,
    selectedJobId: null,
    pendingOperationFocus: sessionId,
    operationNotifications: removeNotificationForSession(state.operationNotifications, sessionId),
  });
}

// Map 모드가 pendingOperationFocus를 처리한 뒤 호출해 일회성 이동 신호를 비운다.
export function consumeOperationFocus(): void {
  if (state.pendingOperationFocus === null) return;
  setState({ pendingOperationFocus: null });
}

// 포커스 순환(Alt+←/→)용 다음 Operation id 계산. delta>0=다음, delta<0=이전. 끝에서 순환(wrap)한다.
// 현재 선택이 목록에 없으면(또는 null) delta 방향에 따라 첫/마지막 항목을 고른다.
export function nextOperationId(order: readonly string[], currentId: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const current = currentId ? order.indexOf(currentId) : -1;
  const nextIndex = current === -1
    ? (delta > 0 ? 0 : order.length - 1)
    : (current + delta + order.length) % order.length;
  return order[nextIndex] ?? null;
}

export function openOperationSearch(): void {
  setState({ operationSearchOpen: true });
}

export function closeOperationSearch(): void {
  setState({ operationSearchOpen: false });
}

export function toggleOperationSearch(): void {
  setState({ operationSearchOpen: !state.operationSearchOpen });
}

export function beginCreateTerminalSession(): void {
  setState({ creatingTerminalSession: true, terminalSessionError: null });
}

export function completeCreateTerminalSession(session: SessionInput): void {
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

export function applySessionUpdate(session: SessionInput): void {
  const current = state.sessions[session.sessionId];
  const normalized = normalizeSession({ ...(current ?? {}), ...session, label: session.label, accent: session.accent });
  const known = Boolean(current);
  const sessions = { ...state.sessions, [normalized.sessionId]: normalized };
  const sessionOrder = known
    ? state.sessionOrder
    : [normalized.sessionId, ...state.sessionOrder.filter((sessionId) => sessionId !== normalized.sessionId)];
  // 기존 세션의 턴 상태 전이만 알림(신규 세션의 첫 프레임은 전이가 아니므로 제외).
  const nextNotifications = current
    ? mergeTurnTransitionNotification(state.operationNotifications, current, normalized)
    : state.operationNotifications;
  setState({
    sessions,
    sessionOrder,
    activeTerminalSessionId: resolveVisibleSessionId(state.activeTheaterId, sessions, sessionOrder, state.activeTerminalSessionId),
    operationNotifications: nextNotifications,
  });
}

// 입력 대기(AskUserQuestion·권한/유휴/elicitation) 1회성 신호. 세션 상태는 갱신하지 않고,
// Operation 단위 알림 맵에 병합한다. 보이는 세션 제외는 Notification Cluster selector가 담당한다.
export function applySessionAttention(session: SessionInput, reason?: AttentionReason): void {
  const target = state.sessions[session.sessionId] ?? normalizeSession(session);
  // 캐리어 출격 중(미완료 job 존재)의 idle_prompt는 입력 대기가 아니라 비동기 작업 대기다 —
  // ended 경로와 동일 근거로 억제한다. 권한 요청·AskUserQuestion·elicitation
  // (또는 reason 부재)은 출격 중에도 실제 입력 대기이므로 알림을 유지한다.
  if (reason === "idle_prompt" && hasActiveCarrierJob(target)) return;
  setState({ operationNotifications: mergeNotification(state.operationNotifications, makeNotification("input-waiting", target)) });
}

export function dismissNotificationsForSession(sessionId: string): void {
  const operationNotifications = removeNotificationForSession(state.operationNotifications, sessionId);
  if (operationNotifications === state.operationNotifications) return;
  setState({ operationNotifications });
}

export function setGlobalMute(globalMute: boolean): void {
  const notificationPreferences = { ...state.notificationPreferences, globalMute };
  writeStoredNotificationPreferences(notificationPreferences);
  setState({ notificationPreferences });
}

export function setDnd(dnd: boolean): void {
  const notificationPreferences = { ...state.notificationPreferences, dnd };
  writeStoredNotificationPreferences(notificationPreferences);
  setState({ notificationPreferences });
}

export function toggleTheaterMute(theaterId: string): void {
  const mutedTheaterIds = { ...state.notificationPreferences.mutedTheaterIds };
  if (mutedTheaterIds[theaterId]) {
    delete mutedTheaterIds[theaterId];
  } else {
    mutedTheaterIds[theaterId] = true;
  }
  const notificationPreferences = { ...state.notificationPreferences, mutedTheaterIds };
  writeStoredNotificationPreferences(notificationPreferences);
  setState({ notificationPreferences });
}

export function failCreateTerminalSession(error: string): void {
  setState({ creatingTerminalSession: false, terminalSessionError: error });
}

export function toggleTimeline(): void {
  setState({ timelineOpen: !state.timelineOpen });
}

export function openShortcuts(): void {
  if (state.shortcutsOpen) return;
  setState({ shortcutsOpen: true });
}

export function closeShortcuts(): void {
  if (!state.shortcutsOpen) return;
  setState({ shortcutsOpen: false });
}

export function toggleShortcuts(): void {
  setState({ shortcutsOpen: !state.shortcutsOpen });
}

export function openWhatsNew(): void {
  if (state.releaseNotes.length === 0 || state.whatsNewOpen) return;
  setState({ whatsNewOpen: true, selectedReleaseNoteKey: state.selectedReleaseNoteKey ?? firstReleaseNoteKey(state.releaseNotes) });
}

export function closeWhatsNew(): void {
  if (!state.whatsNewOpen) return;
  if (state.automaticWhatsNewVersion) writeStoredWhatsNewSeenVersion(state.automaticWhatsNewVersion);
  setState({ whatsNewOpen: false, automaticWhatsNewVersion: null });
}

export function selectReleaseNote(key: string): void {
  if (!releaseNoteKeyExists(state.releaseNotes, key)) return;
  setState({ selectedReleaseNoteKey: key });
}

export function openOnboarding(): void {
  if (state.onboardingOpen) return;
  setState({ onboardingOpen: true });
}

export function closeOnboarding(): void {
  writeStoredCommissioningSeen(true);
  if (!state.onboardingOpen) return;
  setState({ onboardingOpen: false });
}

export function resolveOnboardingOnBootstrap(): void {
  if (state.bootstrapped) return;
  const shouldOpen = state.theaters.length === 0 && !readStoredCommissioningSeen();
  setState({ bootstrapped: true, onboardingOpen: shouldOpen ? true : state.onboardingOpen });
}

export function failTerminateTerminalSession(error: string): void {
  // 종료 실패 시 카드는 남기고 사이드바 오류 라인에만 사유를 표기한다(살아있는 PTY를 숨기지 않는다).
  setState({ terminalSessionError: error });
}

export function failResumeTerminalSession(error: string): void {
  setState({ terminalSessionError: error });
}

export function failRenameTerminalSession(error: string): void {
  // 이름 변경 실패 시 세션 카드는 그대로 두고 사이드바 오류 라인에만 사유를 표기한다.
  setState({ terminalSessionError: error });
}

export function removeTheater(theaterId: string): void {
  // Theater의 Operations뿐 아니라 영속된 셸 패널 저장도 함께 정리한다 — stale 셸이 같은 폴더 재등록 시 부활하지 않게 한다.
  clearStoredShellPanelsForTheater(theaterId);
  const theaters = state.theaters.filter((theater) => theater.id !== theaterId);
  const sessions: Record<string, SessionInfo> = {};
  const sessionOrder: string[] = [];
  for (const sessionId of state.sessionOrder) {
    const session = state.sessions[sessionId];
    if (!session || session.theaterId === theaterId) continue;
    sessions[sessionId] = session;
    sessionOrder.push(sessionId);
  }
  const activeTheaterId = chooseActiveTheaterId(theaters, state.activeTheaterId === theaterId ? null : state.activeTheaterId);
  // 삭제된 Theater의 Operation 알림도 클러스터에서 정리한다.
  const operationNotifications = pruneNotificationsForTheater(state.operationNotifications, theaterId);
  writeStoredActiveTheaterId(activeTheaterId);
  setState({
    theaters,
    sessions,
    sessionOrder,
    activeTheaterId,
    activeTerminalSessionId: resolveVisibleSessionId(activeTheaterId, sessions, sessionOrder, state.activeTerminalSessionId),
    selectedJobId: null,
    operationNotifications,
  });
}

export function removeTerminalSession(sessionId: string): void {
  if (!state.sessions[sessionId]) return;
  const sessions = { ...state.sessions };
  delete sessions[sessionId];
  const sessionOrder = state.sessionOrder.filter((id) => id !== sessionId);
  const wasActive = state.activeTerminalSessionId === sessionId;
  setState({
    sessions,
    sessionOrder,
    activeTerminalSessionId: wasActive ? resolveVisibleSessionId(state.activeTheaterId, sessions, sessionOrder, null) : state.activeTerminalSessionId,
    selectedJobId: wasActive ? null : state.selectedJobId,
    // 삭제된 세션의 알림이 클러스터에 stale 행으로 남지 않도록 정리한다(이동 액션으로도 해소 불가하므로).
    operationNotifications: removeNotificationForSession(state.operationNotifications, sessionId),
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

export function operationSearchEntries(current: ConsoleState) {
  return buildOperationSearchEntries(current);
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

function normalizeSession(session: SessionInput): SessionInfo {
  return {
    ...session,
    terminalSessionId: session.terminalSessionId ?? session.sessionId,
    status: session.status === "starting" && session.tenantId ? "registered" : session.status,
    turnState: session.turnState ?? "none",
    resumeAvailable: session.resumeAvailable === true,
  };
}

function evaluateAutomaticWhatsNew(current: ConsoleState): Pick<ConsoleState, "whatsNewOpen" | "automaticWhatsNewVersion" | "selectedReleaseNoteKey"> {
  const firstRealIndex = current.releaseNotes.findIndex((note) => note.version !== "Unreleased");
  const firstReal = firstRealIndex >= 0 ? current.releaseNotes[firstRealIndex] : undefined;
  if (!firstReal || !current.version || firstReal.version !== current.version || readStoredWhatsNewSeenVersion() === firstReal.version) {
    return {
      whatsNewOpen: current.whatsNewOpen,
      automaticWhatsNewVersion: current.automaticWhatsNewVersion,
      selectedReleaseNoteKey: current.selectedReleaseNoteKey,
    };
  }
  return {
    whatsNewOpen: true,
    automaticWhatsNewVersion: firstReal.version,
    selectedReleaseNoteKey: releaseNoteKey(firstReal.version, firstRealIndex),
  };
}

function firstReleaseNoteKey(notes: readonly { readonly version: string }[]): string | null {
  return notes[0] ? releaseNoteKey(notes[0].version, 0) : null;
}

function releaseNoteKeyExists(notes: readonly { readonly version: string }[], key: string): boolean {
  return notes.some((note, index) => releaseNoteKey(note.version, index) === key);
}

function releaseNoteKey(version: string, index: number): string {
  return `${version}:${index}`;
}

function theaterLabelFor(theaterId: string | undefined): string {
  if (!theaterId) return "—";
  return state.theaters.find((theater) => theater.id === theaterId)?.label ?? theaterId;
}

function makeNotification(kind: NotificationKind, session: SessionInfo): OperationNotification {
  operationNotificationSeq += 1;
  return {
    kind,
    sessionId: session.sessionId,
    theaterId: session.theaterId ?? null,
    theaterLabel: theaterLabelFor(session.theaterId),
    operationLabel: sessionDisplayLabel(session),
    count: 1,
    lastRaisedSeq: operationNotificationSeq,
  };
}

function mergeTurnTransitionNotification(
  notifications: Readonly<Record<string, OperationNotification>>,
  prev: SessionInfo,
  next: SessionInfo,
): Readonly<Record<string, OperationNotification>> {
  // 작업 재개(running 진입): 이전 입력 대기/완료 알림은 무효이므로 해당 세션 알림을 제거한다.
  // 입력 대기 응답 후 턴이 재개되면, 보이는 패널의 awaiting 신호와 클러스터 행이 stale로 남는 것을 막는다.
  if (prev.turnState !== "running" && next.turnState === "running") {
    return removeNotificationForSession(notifications, next.sessionId);
  }
  // 작업 완료(턴 종료)만 알린다. 턴 진행 시작(running)은 알리지 않는다.
  // 캐리어 출격 중(미완료 job이 있음)에는 ended 알림을 억제한다 — 실제 작업은 계속 진행 중이므로.
  if (prev.turnState !== "ended" && next.turnState === "ended" && !hasActiveCarrierJob(next)) {
    return mergeNotification(notifications, makeNotification("ended", next));
  }
  return notifications;
}

function mergeNotification(
  notifications: Readonly<Record<string, OperationNotification>>,
  notification: OperationNotification,
): Readonly<Record<string, OperationNotification>> {
  const existing = notifications[notification.sessionId];
  return {
    ...notifications,
    [notification.sessionId]: {
      ...notification,
      count: existing?.kind === "input-waiting" && notification.kind === "input-waiting" ? existing.count + 1 : 1,
    },
  };
}

function removeNotificationForSession(
  notifications: Readonly<Record<string, OperationNotification>>,
  sessionId: string,
): Readonly<Record<string, OperationNotification>> {
  if (!notifications[sessionId]) return notifications;
  const next = { ...notifications };
  delete next[sessionId];
  return next;
}

function pruneNotificationsForTheater(
  notifications: Readonly<Record<string, OperationNotification>>,
  theaterId: string,
): Readonly<Record<string, OperationNotification>> {
  let changed = false;
  const next: Record<string, OperationNotification> = {};
  for (const [sessionId, notification] of Object.entries(notifications)) {
    if (notification.theaterId === theaterId) {
      changed = true;
      continue;
    }
    next[sessionId] = notification;
  }
  return changed ? next : notifications;
}

function hasActiveCarrierJob(session: SessionInfo): boolean {
  const tenantId = resolveSessionTenantId(session);
  if (!tenantId) return false;
  return tenantHasActiveJob(state.tenantJobs[tenantId]);
}

function tenantHasActiveJob(tenant: TenantJobsView | undefined): boolean {
  if (!tenant) return false;
  // finalize 이벤트가 보존 한도로 잘려 finishedAt이 비어도, 스냅샷이 신뢰한 종결 상태(done/error/aborted)로
  // 완료를 판정한다 — 그렇지 않으면 복원된 완료 job이 영원히 진행 중으로 오인돼 stop 토스트가 영구 억제된다.
  return tenant.jobOrder.some((jobId) => {
    const job = tenant.jobs[jobId];
    return job ? !job.finishedAt && !isTerminalJobStatus(job.status) : false;
  });
}

function mergeTenantBindings(sessions: Readonly<Record<string, SessionInfo>>, tenants: readonly ObservedTenant[]): Record<string, SessionInfo> {
  const next = { ...sessions };
  for (const tenant of tenants) {
    if (!tenant.terminalSessionId) continue;
    const session = next[tenant.terminalSessionId];
    if (!session) continue;
    next[tenant.terminalSessionId] = {
      ...session,
      status: tenant.status === "closed" ? "closed" : tenant.status === "dormant" ? "dormant" : "registered",
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
  if (!theaterId) {
    if (preferredSessionId && sessions[preferredSessionId] && isAutoSelectableSession(sessions[preferredSessionId])) return preferredSessionId;
    return sessionOrder.find((sessionId) => isAutoSelectableSession(sessions[sessionId])) ?? null;
  }
  if (preferredSessionId && sessionBelongsToTheater(sessions[preferredSessionId], theaterId) && isAutoSelectableSession(sessions[preferredSessionId])) return preferredSessionId;
  return sessionOrder.find((sessionId) => sessionBelongsToTheater(sessions[sessionId], theaterId) && isAutoSelectableSession(sessions[sessionId])) ?? null;
}

function sessionBelongsToTheater(session: SessionInfo | undefined, theaterId: string | null): boolean {
  if (!session || !theaterId) return false;
  return session.theaterId === theaterId;
}

function isAutoSelectableSession(session: SessionInfo | undefined): boolean {
  return Boolean(session && session.status !== "dormant");
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

function readStoredNotificationPreferences(): NotificationPreferences {
  if (typeof window === "undefined") return DEFAULT_NOTIFICATION_PREFERENCES;
  try {
    const stored = window.localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
    if (!stored) return DEFAULT_NOTIFICATION_PREFERENCES;
    const parsed: unknown = JSON.parse(stored);
    if (!isNotificationPreferencesBlob(parsed)) return DEFAULT_NOTIFICATION_PREFERENCES;
    return {
      globalMute: parsed.preferences.globalMute,
      dnd: parsed.preferences.dnd,
      mutedTheaterIds: parsed.preferences.mutedTheaterIds,
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
}

function readStoredCommissioningSeen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COMMISSIONING_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function readStoredWhatsNewSeenVersion(): string | null {
  // localStorage가 막힌 환경에서도 같은 세션 동안 닫힘 상태를 기억하도록 in-memory 폴백을 먼저 확인한다.
  if (whatsNewSeenVersionMemo !== null) return whatsNewSeenVersionMemo;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY);
  } catch {
    return null;
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

function writeStoredTerminalFont(font: ConsoleState["terminalFont"]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, serializeTerminalFontSettings(font));
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function writeStoredNotificationPreferences(preferences: NotificationPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: NOTIFICATION_PREFERENCES_VERSION,
      preferences,
    }));
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function writeStoredCommissioningSeen(seen: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMMISSIONING_SEEN_STORAGE_KEY, seen ? "1" : "0");
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function writeStoredWhatsNewSeenVersion(version: string): void {
  // localStorage 성공 여부와 무관하게 in-memory에 먼저 기록해 같은 세션 내 재팝업을 막는다.
  whatsNewSeenVersionMemo = version;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY, version);
  } catch {
    // 브라우저 저장소가 막힌 환경에서는 in-memory 폴백이 현재 세션 상태를 유지한다.
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

function isNotificationPreferencesBlob(value: unknown): value is {
  readonly version: 1;
  readonly preferences: NotificationPreferences;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    readonly version?: unknown;
    readonly preferences?: {
      readonly globalMute?: unknown;
      readonly dnd?: unknown;
      readonly mutedTheaterIds?: unknown;
    };
  };
  if (candidate.version !== NOTIFICATION_PREFERENCES_VERSION || !candidate.preferences) return false;
  if (typeof candidate.preferences.globalMute !== "boolean" || typeof candidate.preferences.dnd !== "boolean") return false;
  const muted = candidate.preferences.mutedTheaterIds;
  return Boolean(muted) && typeof muted === "object" && !Array.isArray(muted);
}

function emit(): void {
  for (const listener of listeners) listener();
}
