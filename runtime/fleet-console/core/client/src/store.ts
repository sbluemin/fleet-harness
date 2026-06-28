import type { ClientNotification } from "@fleet-console/sdk/notifications";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { applyChannelAnimationDefaults } from "./canvas/canvas-store.js";
import { buildOperationSearchEntries } from "./operation-search.js";
import type {
  CodexReaderRequest,
  ConsoleState,
  NotificationKind,
  NotificationPreferences,
  OperationNotification,
  OperationNode,
  ObserverStatus,
  ReleaseNotesResponse,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
} from "./types.js";

type Listener = () => void;

const ACTIVE_THEATER_STORAGE_KEY = "fleet-console.activeTheaterId";
const THEME_STORAGE_KEY = "fleet-console.activeTheme";
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
const WHATS_NEW_SEEN_VERSION_STORAGE_KEY = "fleet-console.whatsNewSeenVersion";
const NOTIFICATION_PREFERENCES_STORAGE_KEY = "fleet-console.notificationPreferences";
const NOTIFICATION_PREFERENCES_VERSION = 1;
const DEFAULT_THEME: ThemeId = "maritime";
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
  activeTheme: readStoredTheme(),
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

export function initThemeFromStorage(): void {
  applyThemeToDocument(readStoredTheme());
}

export function setActiveTheme(theme: ThemeId): void {
  writeStoredTheme(theme);
  applyThemeToDocument(theme);
  setState({ activeTheme: theme });
}

export function applyObserverStatus(status: ObserverStatus): void {
  // 채널은 status로만 도착한다. local 채널이면 ambient 애니메이션 기본값을 끔으로 reconcile한다(사용자 선호는 존중).
  applyChannelAnimationDefaults(status.channel);
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
    // selectedReleaseNoteKey는 evaluateAutomaticWhatsNew(next)가 함께 산출하므로 여기서 따로 지정하지 않는다(중복 지정 방지).
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
  const operationLabel = operation.renamedTitle ?? operation.title;
  const kind = mapNotificationKind(input.kind);
  notificationSeq += 1;
  const existing = state.operationNotifications[input.operationId];
  const count = existing ? existing.count + 1 : 1;
  setState({
    operationNotifications: {
      ...state.operationNotifications,
      [input.operationId]: {
        kind,
        operationId: input.operationId,
        theaterId,
        theaterLabel,
        operationLabel,
        count,
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
  window.dispatchEvent(new CustomEvent("fleet-console:focus-operation", { detail: { operationId } }));
}

export function consumeOperationFocus(): void {
  if (state.pendingOperationFocus === null) return;
  setState({ pendingOperationFocus: null });
}

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

function writeStoredTheme(theme: ThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
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
