import type { ClientNotification } from "@fleet-console/sdk/notifications";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { buildOperationSearchEntries } from "./operation-search.js";
import { uiFontFamily } from "./ui-font.js";
import type {
  CodexReaderRequest,
  ConsoleState,
  NotificationKind,
  NotificationPreferences,
  OperationGroup,
  OperationNotification,
  OperationNode,
  ObserverStatus,
  ReleaseNotesResponse,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
  UiFontSettings,
} from "./types.js";

type Listener = () => void;

const ACTIVE_THEATER_STORAGE_KEY = "fleet-console.activeTheaterId";
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
const WHATS_NEW_SEEN_VERSION_STORAGE_KEY = "fleet-console.whatsNewSeenVersion";
const NOTIFICATION_PREFERENCES_STORAGE_KEY = "fleet-console.notificationPreferences";
const NOTIFICATION_PREFERENCES_VERSION = 1;
const DEFAULT_THEME: ThemeId = "instrument";
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  globalMute: false,
  dnd: false,
  mutedTheaterIds: {},
};

const listeners = new Set<Listener>();

let notificationSeq = 0;
let whatsNewSeenVersionMemo: string | null = null;

let state: ConsoleState = {
  connection: "connecting",
  connectionError: null,
  channel: "unknown",
  // The SDK ConsoleTheme union matches ThemeId; the selected theme passes
  // through to the plugin context unchanged.
  activeTheme: DEFAULT_THEME,
  version: "",
  updateAvailable: false,
  latestVersion: null,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  theaters: [],
  operations: [],
  operationsHydrated: false,
  groups: [],
  activeTheaterId: null,
  activeOperationId: null,
  operationStatus: {},
  addingTheater: false,
  theaterError: null,
  operationsViewActive: false,
  operationSearchOpen: false,
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
  pendingOperationFocus: null,
  keyboardFocusRequest: null,
  pendingSideBarAddTheater: false,
  pendingSideBarTheaterLaunch: null,
  launchMenuRequest: null,
  keyboardShortcutsOpen: false,
  operationNotifications: {},
  notificationPreferences: readStoredNotificationPreferences(),
  codexReader: null,
  codexReaderExpanded: false,
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

export function setOperationsViewActive(active: boolean): void {
  if (state.operationsViewActive === active) return;
  setState({ operationsViewActive: active });
}

export function setActiveTheme(theme: ThemeId): void {
  applyThemeToDocument(theme);
  setState({ activeTheme: theme });
}

export function setActiveUiFont(uiFont: UiFontSettings): void {
  applyUiFontToDocument(uiFont);
}

export function applyObserverStatus(status: ObserverStatus): void {
  setState({
    channel: status.channel,
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
    // selectedReleaseNoteKey는 evaluateAutomaticWhatsNew(next)가 함께 산출하므로 여기서 따로 지정하지 않는다(중복 지정 방지).
    ...evaluateAutomaticWhatsNew(next),
  });
}

export function failReleaseNotesFetch(error: string): void {
  setState({ releaseNotesLoading: false, releaseNotesError: error });
}

export function applyThemeToDocument(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
}

// Electron 데스크톱 셸에서만 `data-desktop-shell` 마커를 심는다 — 브라우저에는 마커가 없어
// `-webkit-app-region` 드래그 규칙이 적용되지 않는다. channel status는 첫 페인트 이후 도착하므로,
// 초기 렌더부터 창 드래그가 필요한 이 마커는 즉시 확인 가능한 userAgent로 판별한다.
export function applyDesktopShellMarker(): void {
  if (typeof document === "undefined" || typeof navigator === "undefined") return;
  if (navigator.userAgent.includes("Electron")) {
    document.documentElement.setAttribute("data-desktop-shell", "true");
    const platform = navigator.userAgent.includes("Windows")
      ? "win32"
      : navigator.userAgent.includes("Mac OS X")
        ? "darwin"
        : "linux";
    document.documentElement.setAttribute("data-desktop-platform", platform);
  }
}

export function applyUiFontToDocument(uiFont: UiFontSettings): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-ui-font", uiFont.source);
  document.documentElement.style.setProperty("--font-body", uiFontFamily(uiFont));
  document.documentElement.style.setProperty("--font-body-size", `${uiFont.size}px`);
}

export function hydrateTheaters(theaters: readonly TheaterInfo[]): void {
  const activeTheaterId = chooseActiveTheaterId(theaters, state.activeTheaterId);
  setState({ theaters, activeTheaterId });
}

export function hydrateTheaterBootstrap(bootstrap: TheaterBootstrap): void {
  hydrateTheaters(bootstrap.theaters);
}

export function hydrateOperations(operations: readonly OperationNode[]): void {
  setState({ operations, operationsHydrated: true });
}

// 초기 요청 응답이 늦는 동안 launch 수화가 먼저 도착할 수 있다. 그 패널을 초기 응답이 덮어쓰지 않게 합친다.
export function hydrateInitialOperations(operations: readonly OperationNode[]): void {
  const initialIds = new Set(operations.map((operation) => operation.id));
  const launchedBeforeInitialHydration = state.operations.filter((operation) => !initialIds.has(operation.id));
  setState({ operations: [...operations, ...launchedBeforeInitialHydration], operationsHydrated: true });
}

export function applyOperationUpdate(operation: OperationNode): void {
  const index = state.operations.findIndex((op) => op.id === operation.id);
  if (index === -1) return;
  const operations = [...state.operations];
  operations[index] = operation;
  setState({ operations });
}

export function hydrateGroups(groups: readonly OperationGroup[]): void {
  setState({ groups });
}

export function setActiveTheater(theaterId: string | null): void {
  writeStoredActiveTheaterId(theaterId);
  setState({ activeTheaterId: theaterId });
}

export function setActiveOperation(operationId: string | null): void {
  if (state.activeOperationId === operationId) return;
  setState({ activeOperationId: operationId });
}

export function setOperationStatus(operationId: string, status: OperationActivity): void {
  if (status === "idle") {
    clearOperationStatus(operationId);
    return;
  }
  if (state.operationStatus[operationId] === status) return;
  setState({ operationStatus: { ...state.operationStatus, [operationId]: status } });
}

export function clearOperationStatus(operationId: string): void {
  if (!(operationId in state.operationStatus)) return;
  const operationStatus = { ...state.operationStatus };
  delete operationStatus[operationId];
  setState({ operationStatus });
}

export function raiseOperationNotification(input: ClientNotification): void {
  if (!input.operationId) return;
  const operation = state.operations.find((item) => item.id === input.operationId);
  if (!operation) return;
  const theaterId = operation.theaterId ?? null;
  const theaterLabel = state.theaters.find((theater) => theater.id === theaterId)?.label ?? theaterId ?? "Unknown";
  const operationLabel = operation.title;
  const kind = mapNotificationKind(input.kind);
  notificationSeq += 1;
  // 같은 패널의 알림은 누적하지 않고 최신 것으로 교체한다(last-writer-wins).
  setState({
    operationNotifications: {
      ...state.operationNotifications,
      [input.operationId]: {
        kind,
        operationId: input.operationId,
        theaterId,
        theaterLabel,
        operationLabel,
        lastRaisedSeq: notificationSeq,
      },
    },
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
  });
}

export function cancelAddTheater(): void {
  setState({ addingTheater: false, theaterError: null });
}

export function failAddTheater(error: string): void {
  setState({ addingTheater: false, theaterError: error });
}

export function focusOperation(operationId: string): void {
  const operation = state.operations.find((item) => item.id === operationId);
  if (!operation) return;
  writeStoredActiveTheaterId(operation.theaterId);
  setState({
    activeTheaterId: operation.theaterId,
    activeOperationId: operationId,
    pendingOperationFocus: operationId,
    operationNotifications: removeNotificationForOperation(state.operationNotifications, operationId),
  });
}

export function consumeOperationFocus(): void {
  if (state.pendingOperationFocus === null) return;
  setState({ pendingOperationFocus: null });
}

// 커맨드 밴드 → 사이드바 단방향 요청 신호 — 사이드바가 effect로 소비(consume)한다.
// pendingOperationFocus/consumeOperationFocus와 같은 request/consume 계약.
export function requestSideBarAddTheater(): void {
  setState({ pendingSideBarAddTheater: true });
}

export function consumeSideBarAddTheater(): void {
  if (!state.pendingSideBarAddTheater) return;
  setState({ pendingSideBarAddTheater: false });
}

export function requestSideBarTheaterLaunch(theaterId: string): void {
  setState({ pendingSideBarTheaterLaunch: theaterId });
}

export function consumeSideBarTheaterLaunch(): void {
  if (state.pendingSideBarTheaterLaunch === null) return;
  setState({ pendingSideBarTheaterLaunch: null });
}

export function requestOperationKeyboardFocus(operationId: string): void {
  setState({
    keyboardFocusRequest: {
      operationId,
      requestId: (state.keyboardFocusRequest?.requestId ?? 0) + 1,
    },
  });
}

// 팔레트 "New Operation" 커맨드가 사이드바의 ＋New launch 오버레이를 열도록 요청한다(keyboardFocusRequest 패턴 미러).
export function requestOperationLaunchMenu(): void {
  setState({ launchMenuRequest: { requestId: (state.launchMenuRequest?.requestId ?? 0) + 1 } });
}

export function consumeOperationLaunchMenu(): void {
  if (state.launchMenuRequest === null) return;
  setState({ launchMenuRequest: null });
}

export function openKeyboardShortcuts(): void {
  if (state.keyboardShortcutsOpen) return;
  setState({ keyboardShortcutsOpen: true });
}

export function closeKeyboardShortcuts(): void {
  if (!state.keyboardShortcutsOpen) return;
  setState({ keyboardShortcutsOpen: false });
}

export function nextOperationId(order: readonly string[], currentId: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const current = currentId ? order.indexOf(currentId) : -1;
  const nextIndex = current === -1
    ? (delta > 0 ? 0 : order.length - 1)
    : (current + delta + order.length) % order.length;
  return order[nextIndex] ?? null;
}

// SideBar 표시 순서와 Alt+←/→ 순환 순서가 갈라지지 않도록 Operation 정렬을 이 한 함수로 단일화한다.
// operationOrder(드래그 재정렬 SSoT)에 있는 항목은 그 순서를 따르고, 없는 항목은 createdAt 순으로 뒤에 붙인다.
export function sortOperationsByOrder(
  operations: readonly OperationNode[],
  operationOrder: readonly string[],
): readonly OperationNode[] {
  if (operationOrder.length === 0) return [...operations].sort(compareOperationCreatedAt);
  const explicitOrder = new Map(operationOrder.map((id, index) => [id, index]));
  return [...operations].sort((left, right) => {
    const leftIndex = explicitOrder.get(left.id);
    const rightIndex = explicitOrder.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return compareOperationCreatedAt(left, right);
  });
}

// 그룹 적용 visible 순서(비-collapsed 그룹 order → 그룹 내 operationOrder → ungrouped)로 flatten한 배열을 반환.
// SideBar visible 순서와 Alt+←/→ cycling 순서의 공유 SSoT.
// collapsedGroups: 접힌 그룹 id 목록 — 해당 그룹의 멤버는 결과에서 제외한다.
export function flattenGroupedOrder(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[],
  operationOrder: readonly string[],
  collapsedGroups: readonly string[] = [],
): readonly OperationNode[] {
  const sorted = sortOperationsByOrder(operations, operationOrder);
  const collapsedSet = new Set(collapsedGroups);
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const buckets = new Map<string | null, OperationNode[]>();
  for (const group of sortedGroups) buckets.set(group.id, []);
  buckets.set(null, []);
  for (const op of sorted) {
    const gid = op.groupId ?? null;
    if (gid !== null && buckets.has(gid)) {
      buckets.get(gid)!.push(op);
    } else {
      buckets.get(null)!.push(op);
    }
  }
  return [
    ...sortedGroups
      .filter((g) => !collapsedSet.has(g.id))
      .flatMap((g) => buckets.get(g.id) ?? []),
    ...(buckets.get(null) ?? []),
  ];
}

// Alt+←/→는 SideBar 가시 순서를 따르되, 캔버스에서 최소화된 Operation은 순환 대상에서 제외한다.
export function focusCycleOperationIds(
  operations: readonly OperationNode[],
  groups: readonly OperationGroup[],
  operationOrder: readonly string[],
  collapsedGroups: readonly string[],
  minimized: readonly string[],
): readonly string[] {
  const minimizedIds = new Set(minimized);
  return flattenGroupedOrder(operations, groups, operationOrder, collapsedGroups)
    .filter((operation) => !minimizedIds.has(operation.id))
    .map((operation) => operation.id);
}

// STATUS 축의 Alt+←/→ 순환 순서: 사이드바 STATUS 섹션의 가시 순서와 동일하게
// awaiting → running → idle → dormant 랭크로 안정 정렬한다(랭크 내부는 operationOrder 순서 유지).
// 그룹 접힘은 적용하지 않되, 상태 섹션 접힘 predicate로 사이드바에서 숨은 Operation을 제외한다.
const STATUS_CYCLE_RANK: Readonly<Record<OperationActivity, number>> = { awaiting: 0, running: 1, idle: 2, dormant: 3 };

export function statusCycleOperationIds(
  operations: readonly OperationNode[],
  operationOrder: readonly string[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
  minimized: readonly string[],
  isStatusSectionCollapsed: (status: OperationActivity) => boolean,
): readonly string[] {
  const minimizedIds = new Set(minimized);
  const status = (operation: OperationNode): OperationActivity => operationStatus[operation.id] ?? "idle";
  const rank = (operation: OperationNode): number => STATUS_CYCLE_RANK[status(operation)];
  return [...sortOperationsByOrder(operations, operationOrder)]
    .sort((left, right) => rank(left) - rank(right))
    .filter((operation) => !minimizedIds.has(operation.id) && !isStatusSectionCollapsed(status(operation)))
    .map((operation) => operation.id);
}

export function compareOperationCreatedAt(left: OperationNode, right: OperationNode): number {
  return left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);
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

export function openCodexReader(req: CodexReaderRequest): void {
  setState({ codexReader: req, codexReaderExpanded: false });
}

export function expandCodexReader(): void {
  if (state.codexReader === null) return;
  setState({ codexReaderExpanded: true });
}

export function collapseCodexReader(): void {
  setState({ codexReaderExpanded: false });
}

export function closeCodexReader(): void {
  setState({ codexReader: null, codexReaderExpanded: false });
}

export function resolveOnboardingOnBootstrap(): void {
  if (state.bootstrapped) return;
  const shouldOpen = state.theaters.length === 0 && !readStoredCommissioningSeen();
  setState({ bootstrapped: true, onboardingOpen: shouldOpen ? true : state.onboardingOpen });
}

export function removeTheater(theaterId: string): void {
  const theaters = state.theaters.filter((theater) => theater.id !== theaterId);
  const activeTheaterId = chooseActiveTheaterId(theaters, state.activeTheaterId === theaterId ? null : state.activeTheaterId);
  const operationNotifications = pruneNotificationsForTheater(state.operationNotifications, theaterId);
  const removedOperationIds = new Set(state.operations.filter((operation) => operation.theaterId === theaterId).map((operation) => operation.id));
  const activeOperationId = state.activeOperationId && removedOperationIds.has(state.activeOperationId) ? null : state.activeOperationId;
  writeStoredActiveTheaterId(activeTheaterId);
  setState({ theaters, activeTheaterId, activeOperationId, operationNotifications });
}

export function dismissNotificationsForOperation(operationId: string): void {
  const operationNotifications = removeNotificationForOperation(state.operationNotifications, operationId);
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

export function activeTheater(current: ConsoleState): TheaterInfo | null {
  return current.theaters.find((theater) => theater.id === current.activeTheaterId) ?? null;
}

export function operationSearchEntries(current: ConsoleState) {
  return buildOperationSearchEntries(current);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function removeNotificationForOperation(
  notifications: Readonly<Record<string, OperationNotification>>,
  operationId: string,
): Readonly<Record<string, OperationNotification>> {
  if (!notifications[operationId]) return notifications;
  const next = { ...notifications };
  delete next[operationId];
  return next;
}

function pruneNotificationsForTheater(
  notifications: Readonly<Record<string, OperationNotification>>,
  theaterId: string,
): Readonly<Record<string, OperationNotification>> {
  let changed = false;
  const next: Record<string, OperationNotification> = {};
  for (const [operationId, notification] of Object.entries(notifications)) {
    if (notification.theaterId === theaterId) {
      changed = true;
      continue;
    }
    next[operationId] = notification;
  }
  return changed ? next : notifications;
}

function chooseActiveTheaterId(theaters: readonly TheaterInfo[], currentActiveId: string | null): string | null {
  const ids = new Set(theaters.map((theater) => theater.id));
  const stored = readStoredActiveTheaterId();
  if (stored && ids.has(stored)) return stored;
  if (currentActiveId && ids.has(currentActiveId)) return currentActiveId;
  return theaters[0]?.id ?? null;
}

function mapNotificationKind(kind: string): NotificationKind {
  const normalized = kind.toLowerCase();
  if (normalized === "ended" || normalized.includes(".end") || normalized.includes("done")) return "ended";
  return "input-waiting";
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

function writeStoredCommissioningSeen(seen: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (seen) {
      window.localStorage.setItem(COMMISSIONING_SEEN_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(COMMISSIONING_SEEN_STORAGE_KEY);
    }
  } catch {
    // 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function readStoredWhatsNewSeenVersion(): string | null {
  if (whatsNewSeenVersionMemo !== null) return whatsNewSeenVersionMemo;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredWhatsNewSeenVersion(version: string): void {
  whatsNewSeenVersionMemo = version;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_VERSION_STORAGE_KEY, version);
  } catch {
    // 저장소가 막힌 환경에서는 in-memory watermark만 유지한다.
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
    // 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function isNotificationPreferencesBlob(value: unknown): value is {
  readonly version: number;
  readonly preferences: NotificationPreferences;
} {
  if (!value || typeof value !== "object") return false;
  const blob = value as { readonly version?: unknown; readonly preferences?: unknown };
  if (blob.version !== NOTIFICATION_PREFERENCES_VERSION || !blob.preferences || typeof blob.preferences !== "object") return false;
  const prefs = blob.preferences as Partial<NotificationPreferences>;
  return typeof prefs.globalMute === "boolean"
    && typeof prefs.dnd === "boolean"
    && Boolean(prefs.mutedTheaterIds)
    && typeof prefs.mutedTheaterIds === "object";
}
