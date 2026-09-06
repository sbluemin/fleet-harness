import type { ClientNotification } from "@fleet-console/sdk/notifications";
import type { OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { buildOperationSearchEntries } from "./operation-search.js";
import { readQuickLaunchSelection, writeQuickLaunchPinned } from "./quick-launch-preferences.js";
import { getGlobalSettingsStoreState, setGlobalSettingsField } from "./global-settings-store.js";
import { acknowledgeIdleArrival } from "./operation-marks.js";
import { closeExpandedSurface, getExpandedSurfaceState, openExpandedSurface } from "./expanded-surface/store.js";
import { uiFontFamily } from "./ui-font.js";
import type {
  CodexReaderRequest,
  ConnectionState,
  ConsoleState,
  ControlHolder,
  NotificationKind,
  NotificationPreferences,
  OperationGroup,
  OperationNotification,
  OperationNode,
  ObserverStatus,
  QuickLaunchDraftAttachment,
  QuickLaunchRequest,
  ReleaseNotesLocale,
  ReleaseNotesResponse,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
  UiFontSettings,
} from "./types.js";

type Listener = () => void;

const ACTIVE_THEATER_STORAGE_KEY = "fleet-console.activeTheaterId";
const THEME_HINT_STORAGE_KEY = "fleet-console.theme-hint";
const LAST_DARK_THEME_STORAGE_KEY = "fleet-console.last-dark-theme";
const GLASS_HINT_STORAGE_KEY = "fleet-console.glass-hint";
// 서버 seenFeatureTours로 일방향 승격하기 위한 legacy migration 읽기·삭제 전용 키다. 새 값은 쓰지 않는다.
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
// "화면 안내 다시 보기"가 온보딩 전체를 초기화할 때 함께 지우는 최초 설정 가이드 시청 키.
export const COMMISSIONING_SEEN_KEY = "commissioning";
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
let commissioningMigrationAttempted = false;

let state: ConsoleState = {
  connection: "connecting",
  connectionLostAt: null,
  controlHolder: null,
  controlCurtainDismissed: false,
  consoleName: "",
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
  activeOperationAcknowledged: true,
  operationRuntime: {},
  // 기본은 ready 다. 런타임 축을 보고하는 플러그인이 스스로 pending 을 선언하고 시작하며,
  // 그런 플러그인이 하나도 없는 Console 은 기다릴 권위가 없으므로 처음부터 신뢰 가능한 상태다 —
  // 기본을 pending 으로 두면 아무도 보고하지 않는 설치에서 재개가 영구히 막힌다.
  operationRuntimeHydration: "ready",
  operationRuntimeError: null,
  addingTheater: false,
  theaterError: null,
  operationsViewActive: false,
  operationSearchOpen: false,
  operationSearchSeed: null,
  quickLaunchOpen: false,
  quickLaunchPinned: readQuickLaunchSelection().pinned,
  quickLaunchFocusToggle: 0,
  quickLaunchExpandRequest: 0,
  quickLaunchMentionSeed: null,
  quickLaunchDockSuppressed: false,
  quickLaunchDraft: null,
  quickLaunchDraftAttachments: null,
  quickLaunchError: null,
  quickLaunchErrorShortenBy: null,
  pendingQuickLaunch: null,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLocale: null,
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

export function setConnectionState(next: ConnectionState): void {
  if (next === "offline") {
    setState({
      connection: next,
      connectionLostAt: state.connectionLostAt ?? Date.now(),
    });
    return;
  }
  if (next === "live") {
    setState({ connection: next, connectionLostAt: null });
    return;
  }
  setState({ connection: next });
}

export function applyControlHolder(holder: ControlHolder | null): void {
  const handleChanged = state.controlHolder?.handle !== holder?.handle;
  setState({
    controlHolder: holder,
    ...(handleChanged ? { controlCurtainDismissed: false } : {}),
  });
}

export function dismissControlCurtain(): void {
  setState({ controlCurtainDismissed: true });
}

export function setOperationsViewActive(active: boolean): void {
  if (state.operationsViewActive === active) return;
  setState({ operationsViewActive: active });
}

export function setActiveTheme(theme: ThemeId): void {
  applyThemeToDocument(theme);
  setState({ activeTheme: theme });
}

/** 리퀴드 글래스는 기본 옵트인 — 속성 부재가 켜짐이고 "off"만 의미를 가진다.
    힌트는 theme-hint와 동형: 미주입 서빙 경로의 첫 페인트 플래시 방지 전용이다. */
export function setLiquidGlass(enabled: boolean): void {
  if (typeof document !== "undefined") {
    if (enabled) {
      document.documentElement.removeAttribute("data-glass");
    } else {
      document.documentElement.setAttribute("data-glass", "off");
    }
  }
  try {
    if (enabled) {
      globalThis.localStorage?.removeItem(GLASS_HINT_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(GLASS_HINT_STORAGE_KEY, "off");
    }
  } catch {
    // localStorage 접근 불가 환경에서는 DOM 속성만 적용한다.
  }
}

/**
 * 포커스하지 않은 패널 본문이 물러나는 세기 — 화면은 백분율로 말하고 CSS는 불투명도로 그린다.
 * 0%는 물러나지 않음(1.0), 클수록 더 흐리다. 값 하나만 루트에 실어 두면 규칙은 그대로 두고
 * 세기만 바뀐다. CSS 쪽에 같은 기본값이 폴백으로 적혀 있어, 이 함수가 아직 불리지 않은
 * 첫 페인트에서도 패널이 제자리를 지킨다.
 */
export function setUnfocusedPanelFade(fadePercent: number): void {
  if (typeof document === "undefined") return;
  const clamped = Math.min(70, Math.max(0, Math.round(fadePercent)));
  document.documentElement.style.setProperty("--unfocused-panel-opacity", String((100 - clamped) / 100));
}

export function setActiveUiFont(uiFont: UiFontSettings): void {
  applyUiFontToDocument(uiFont);
}

export function applyObserverStatus(status: ObserverStatus): void {
  setState({
    consoleName: status.name,
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

export function applyReleaseNotes(response: ReleaseNotesResponse, locale: ReleaseNotesLocale): void {
  const localeChanged = state.releaseNotesLocale !== null && state.releaseNotesLocale !== locale;
  const next = {
    ...state,
    releaseNotes: response.notes,
    releaseNotesLocale: locale,
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: response.sourceRef,
    releaseNotesFetchedAt: response.fetchedAt,
    releaseNotesStale: response.stale,
    // key에는 배열 위치가 들어가므로 refresh가 앞에 릴리스를 추가해도 같은 버전·중복 순번을 다시 찾는다.
    selectedReleaseNoteKey: remapReleaseNoteKey(state.releaseNotes, state.selectedReleaseNoteKey, response.notes),
  };
  setState({
    releaseNotes: next.releaseNotes,
    releaseNotesLocale: next.releaseNotesLocale,
    releaseNotesLoading: next.releaseNotesLoading,
    releaseNotesError: next.releaseNotesError,
    releaseNotesSourceRef: next.releaseNotesSourceRef,
    releaseNotesFetchedAt: next.releaseNotesFetchedAt,
    releaseNotesStale: next.releaseNotesStale,
    // 본문 언어 전환이나 이미 열린 모달의 refresh는 사용자가 보고 있던 버전과 열림 원인을 보존한다.
    // 자동 열림 평가는 닫힌 상태에서 받은 첫 로드·동일 언어의 새 데이터에만 필요하다.
    ...(localeChanged || state.whatsNewOpen
      ? { selectedReleaseNoteKey: next.selectedReleaseNoteKey }
      : evaluateAutomaticWhatsNew(next)),
  });
}

export function failReleaseNotesFetch(error: string): void {
  setState({ releaseNotesLoading: false, releaseNotesError: error });
}

function applyThemeToDocument(theme: ThemeId): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  try {
    globalThis.localStorage?.setItem(THEME_HINT_STORAGE_KEY, theme);
    // 마지막 다크 테마 기억은 공용 적용 경로에서 갱신한다 — Settings 카드가 마운트돼 있지 않은
    // 팔레트 커맨드 등 어떤 전환 경로든 Dark 스위치 재진입 시 같은 테마로 복원돼야 한다.
    if (theme === "instrument" || theme === "maritime" || theme === "carbon") {
      globalThis.localStorage?.setItem(LAST_DARK_THEME_STORAGE_KEY, theme);
    }
  } catch {
    // localStorage 접근 불가 환경에서는 DOM 테마만 적용한다.
  }
}

// Dark 모드 진입 시 적용할 다크 테마의 브라우저 로컬 기억 — 저장 필드는 theme: ThemeId 단일을
// 유지하고(모드는 파생 상태), 모드 전환이 "테마 없음" 상태에 착지하지 않게 한다.
export function readLastDarkTheme(): ThemeId {
  try {
    const stored = globalThis.localStorage?.getItem(LAST_DARK_THEME_STORAGE_KEY);
    return stored === "instrument" || stored === "maritime" || stored === "carbon" ? stored : "instrument";
  } catch {
    return "instrument";
  }
}

export function readStoredThemeHint(): ThemeId | null {
  try {
    const theme = globalThis.localStorage?.getItem(THEME_HINT_STORAGE_KEY);
    if (theme === "instrument" || theme === "maritime" || theme === "carbon" || theme === "whites") {
      return theme;
    }
    // 퇴역 라이트 테마 힌트는 whites로 폴백한다 — 서버 폴백과 극성이 일치해야 첫 페인트가 튀지 않는다.
    return theme === "daywatch" || theme === "drydock" ? "whites" : null;
  } catch {
    return null;
  }
}

// 테마 극성(라이트/다크) 판별은 이 한 곳이 소유한다 — Settings의 모드 스위치와 App의 극성 전환
// 안내 토스트가 같은 규칙을 봐야 한쪽만 다른 판정을 내리는 일이 없다.
export function themePolarity(theme: ThemeId): "light" | "dark" {
  return theme === "whites" ? "light" : "dark";
}

export function readServerInjectedTheme(): ThemeId | null {
  if (typeof document === "undefined") return null;
  if (document.documentElement.getAttribute("data-theme-source") !== "server") return null;
  const theme = document.documentElement.getAttribute("data-theme");
  return theme === "instrument" || theme === "maritime" || theme === "carbon" || theme === "whites"
    ? theme
    : null;
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

export function setActiveOperation(
  operationId: string | null,
  options?: { readonly acknowledged?: boolean },
): void {
  const acknowledged = operationId === null
    ? true
    : options?.acknowledged === false
      ? false
      : acknowledgeIdleArrival(operationId);
  if (state.activeOperationId === operationId && state.activeOperationAcknowledged === acknowledged) return;
  setState({ activeOperationId: operationId, activeOperationAcknowledged: acknowledged });
}

export function setOperationRuntime(operationId: string, next: OperationRuntimeState): void {
  // live/idle도 명시 항목으로 저장한다. 항목 삭제로 유휴를 표현하면 resumeAvailable 마커를 가진
  // live 세션이 resolveOperationActivity 폭백에서 dormant로 재분류된다(Codex P1) —
  // "플러그인이 관측한 live idle"과 "미관측"은 구분되어야 한다.
  if (sameRuntimeState(state.operationRuntime[operationId], next)) return;
  setState({ operationRuntime: { ...state.operationRuntime, [operationId]: next } });
}

function sameRuntimeState(current: OperationRuntimeState | undefined, next: OperationRuntimeState): boolean {
  if (!current || current.lifecycle !== next.lifecycle) return false;
  if (current.lifecycle === "dormant" || next.lifecycle === "dormant") return true;
  return current.activity === next.activity;
}

export function clearOperationRuntime(operationId: string): void {
  if (!(operationId in state.operationRuntime)) return;
  const operationRuntime = { ...state.operationRuntime };
  delete operationRuntime[operationId];
  setState({ operationRuntime });
}

// 런타임 축의 신뢰도는 전역 하나로 둔다 — 지금 이 축을 보고하는 소유자는 터미널 플러그인 하나뿐이고,
// degraded의 소비처도 전역 배너 하나다. 소유자가 늘어 서로 다른 신뢰도를 동시에 말해야 하는 날이
// 오면 그때 pluginId 별 맵으로 쪼갠다. 어느 경우든 모르는 상태를 유휴로 접지 않는 계약은 같다.
export function setOperationRuntimeHydration(next: OperationRuntimeHydration, error?: string): void {
  const nextError = next === "degraded" ? error ?? null : null;
  if (state.operationRuntimeHydration === next && state.operationRuntimeError === nextError) return;
  setState({ operationRuntimeHydration: next, operationRuntimeError: nextError });
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

// 선별 처리처럼 "포커스가 Theater를 전환하면 안 되는" 모드가 등록하는 가드 — store는 triage를
// 모른다(import 방향: triage-store → store). 가드가 true를 반환하는 동안 focusOperation은
// activeTheater를 보존한 채 포커스 요청만 흘려보낸다.
let focusTheaterSwitchSuppressed: () => boolean = () => false;

export function registerFocusTheaterSwitchSuppression(guard: () => boolean): void {
  focusTheaterSwitchSuppressed = guard;
}

export function focusOperation(operationId: string): void {
  const operation = state.operations.find((item) => item.id === operationId);
  if (!operation) return;
  const suppressSwitch = focusTheaterSwitchSuppressed() && operation.theaterId !== state.activeTheaterId;
  if (!suppressSwitch) writeStoredActiveTheaterId(operation.theaterId);
  const activeOperationAcknowledged = acknowledgeIdleArrival(operationId);
  setState({
    ...(suppressSwitch ? {} : { activeTheaterId: operation.theaterId }),
    activeOperationId: operationId,
    activeOperationAcknowledged,
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

// 소비자(OperationsSideBar)가 없는 동안 쌓인 사이드바 요청을 부수 효과 없이 폐기한다 —
// consume은 UI 반응(다이얼로그 열림 등)을 동반하므로 경계 정리에는 쓸 수 없다.
export function clearPendingSideBarSignals(): void {
  setState({
    pendingSideBarAddTheater: false,
    pendingSideBarTheaterLaunch: null,
    launchMenuRequest: null,
  });
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

// 그룹은 Operation과 같은 Theater일 때만 그 Operation에 적용된다.
// 활성 Theater가 아니라 Operation 자신의 Theater를 기준 삼는 것이 핵심이다 — 선별 무대는 활성
// Theater 밖 Operation도 올리므로 활성 기준으로 거르면 그 무대의 그룹이 사라진다.
// 서버 PATCH는 groupId가 문자열인지만 보고 Theater 소속을 검사하지 않으므로(operations-domain.ts),
// API로 타 Theater 그룹이 붙은 Operation이 존재할 수 있다. 사이드바는 그 조합을 미분류로 읽으므로,
// 이 검사가 없으면 캡션만 홀로 그룹 이름을 주장해 두 면이 서로를 부정한다.
export function resolveOperationGroup(
  operation: OperationNode,
  groupById: ReadonlyMap<string, OperationGroup>,
): OperationGroup | null {
  if (!operation.groupId) return null;
  const group = groupById.get(operation.groupId);
  if (!group || group.theaterId !== operation.theaterId) return null;
  return group;
}

// GROUP 축 SideBar 표시 순서와 Alt+←/→ 순환 순서가 갈라지지 않도록 Operation 정렬을 이 한 함수로 단일화한다.
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
// GROUP 축 SideBar visible 순서와 Alt+←/→ cycling 순서의 공유 SSoT.
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

// Alt+←/→는 캔버스 배치 순서를 따르되, 캔버스에서 최소화된 Operation은 순환 대상에서 제외한다. 사이드바의 'Sort by status' 축은 이 순서에 관여하지 않는다.
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

export function compareOperationCreatedAt(left: OperationNode, right: OperationNode): number {
  return left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);
}

export function openOperationSearch(seed?: string): void {
  setState({ operationSearchOpen: true, operationSearchSeed: seed ?? null });
}

export function closeOperationSearch(): void {
  setState({ operationSearchOpen: false, operationSearchSeed: null });
}

export function toggleOperationSearch(): void {
  const operationSearchOpen = !state.operationSearchOpen;
  setState({
    operationSearchOpen,
    ...(operationSearchOpen ? {} : { operationSearchSeed: null }),
  });
}

export function openQuickLaunch(): void {
  // 고정된 컴포저는 이미 떠 있다 — 여는 대신 펼쳐 포커스한다. 열림 플래그를 참으로 올려 두면
  // 눈에 보이는 변화 없이 값만 남아, 도킹을 접어 둔 화면에서 모달로 되살아나고 열림을 보고 자기를
  // 억제하는 What's New가 영영 뜨지 않는다(setQuickLaunchPinned가 막는 것과 같은 경로).
  if (isQuickLaunchDocked()) {
    setState({
      quickLaunchExpandRequest: state.quickLaunchExpandRequest + 1,
      quickLaunchError: null,
      quickLaunchErrorShortenBy: null,
    });
    return;
  }
  setState({ quickLaunchOpen: true, quickLaunchError: null, quickLaunchErrorShortenBy: null });
}

/**
 * 행선지를 들고 컴포저를 연다 — 패널 본문의 회신 버튼처럼 "이 Operation에게"라는 의도가 이미
 * 정해진 진입점이 쓴다. 시드는 의도일 뿐 결정이 아니다: 멘션 가능 여부·중복 부착 판정은
 * 컴포저가 자기 규칙으로 내린다. 남은 초안은 이 회차의 주소가 아니다 — 컴포저가 시드를 읽는
 * 순간 버리고 행선지만 심는다. 시드와 열림은 한 번의 전이다.
 */
export function openQuickLaunchForOperation(operationId: string): void {
  // 시드와 열림을 한 번에 올린다. 두 번 emit하면 시드만 있는 중간 렌더가 생기고, 이미 열린
  // 컴포저에서는 열림 전이가 없어 시드가 소비되지 않은 채 남을 수 있다.
  if (isQuickLaunchDocked()) {
    setState({
      quickLaunchMentionSeed: operationId,
      quickLaunchExpandRequest: state.quickLaunchExpandRequest + 1,
      quickLaunchError: null,
      quickLaunchErrorShortenBy: null,
    });
    return;
  }
  setState({
    quickLaunchMentionSeed: operationId,
    quickLaunchOpen: true,
    quickLaunchError: null,
    quickLaunchErrorShortenBy: null,
  });
}

/**
 * 초안을 들고 컴포저를 연다 — 플러그인이 자기 텍스트(부관의 답)를 Operation 지시로 넘기는
 * 진입점. 남은 초안은 교체된다: 이 호출은 "이 문장으로 시작하라"는 뜻이지 이어 쓰기가 아니다.
 * 고정 컴포저는 초안 도착 효과가 싣고, 모달은 열림 전이의 복원 경로가 싣는다.
 */
export function openQuickLaunchWithDraft(draft: string): void {
  if (isQuickLaunchDocked()) {
    setState({
      quickLaunchDraft: draft,
      quickLaunchDraftAttachments: null,
      quickLaunchExpandRequest: state.quickLaunchExpandRequest + 1,
      quickLaunchError: null,
      quickLaunchErrorShortenBy: null,
    });
    return;
  }
  setState({
    quickLaunchDraft: draft,
    quickLaunchDraftAttachments: null,
    quickLaunchOpen: true,
    quickLaunchError: null,
    quickLaunchErrorShortenBy: null,
  });
}

export function consumeQuickLaunchMentionSeed(): void {
  if (state.quickLaunchMentionSeed === null) return;
  setState({ quickLaunchMentionSeed: null });
}

// 실행이 실패했을 때 초안과 사유를 함께 들고 컴포저를 되연다.
export function reopenQuickLaunchWithDraft(draft: string, errorCode: string | null, shortenByChars: number | null = null, attachments: readonly QuickLaunchDraftAttachment[] | null = null): void {
  setState({ quickLaunchOpen: true, quickLaunchDraft: draft, quickLaunchDraftAttachments: attachments, quickLaunchError: errorCode, quickLaunchErrorShortenBy: shortenByChars });
}

export function consumeQuickLaunchDraft(): void {
  if (state.quickLaunchDraft === null && state.quickLaunchDraftAttachments === null) return;
  setState({ quickLaunchDraft: null, quickLaunchDraftAttachments: null });
}

/**
 * 발사되지 않은 초안을 다음 열림까지 지킨다. 닫힘은 취소가 아니라 미룸이다 — Escape 한 번이
 * 문장을 지우면 컴포저가 키보드 사용자에게 유일한 데이터 손실 키를 쥐여 주는 셈이다.
 * 복원은 열림 전이의 기존 경로(quickLaunchDraft 읽기 + consume)가 그대로 맡는다.
 */
export function preserveQuickLaunchDraft(draft: string, attachments: readonly QuickLaunchDraftAttachment[] | null = null): void {
  setState({ quickLaunchDraft: draft, quickLaunchDraftAttachments: attachments });
}

export function closeQuickLaunch(): void {
  setState({ quickLaunchOpen: false, quickLaunchError: null, quickLaunchErrorShortenBy: null });
}

/**
 * 거절 사유만 내린다. 모달은 닫히면서 사유를 함께 버리지만, 고정된 컴포저는 닫히지 않으므로
 * 성공한 재시도 뒤에도 지난 거절이 바에 남아 — 사유가 붙어 있는 동안 접히지도 않는다.
 */
export function clearQuickLaunchRejection(): void {
  if (state.quickLaunchError === null && state.quickLaunchErrorShortenBy === null) return;
  setState({ quickLaunchError: null, quickLaunchErrorShortenBy: null });
}

export function toggleQuickLaunch(): void {
  // 고정 중에는 컴포저가 상주하므로 Mod+J가 여닫을 것이 없다 — 대신 포커스를 왕복시킨다
  // (펼쳐 두고 쓰다가 같은 키로 물러나게 하는 것이 이 단축키의 고정판 계약).
  // 도킹이 접힌 화면에서는 상주하는 바가 없으므로 예전처럼 모달로 여닫는다.
  if (isQuickLaunchDocked()) {
    setState({ quickLaunchFocusToggle: state.quickLaunchFocusToggle + 1 });
    return;
  }
  setState({ quickLaunchOpen: !state.quickLaunchOpen, quickLaunchError: null, quickLaunchErrorShortenBy: null });
}

/** 고정이 켜져 있고, 지금 화면이 그 도킹을 접어 두지 않았을 때만 참이다. */
export function isQuickLaunchDocked(): boolean {
  return state.quickLaunchPinned && !state.quickLaunchDockSuppressed;
}

export function setQuickLaunchDockSuppressed(suppressed: boolean): void {
  if (state.quickLaunchDockSuppressed === suppressed) return;
  setState({ quickLaunchDockSuppressed: suppressed });
}

export function setQuickLaunchPinned(pinned: boolean): void {
  if (state.quickLaunchPinned === pinned) return;
  writeQuickLaunchPinned(pinned);
  // 고정을 풀면 그 자리에서 계속 쓰던 컴포저가 모달로 돌아온다 — 닫아 버리면 되돌리기가 아니라
  // 취소가 된다. 반대로 고정을 켤 때는 모달 열림을 반드시 내린다: 고정된 컴포저는 배치가 존재를
  // 결정하므로 이 값이 참으로 남으면 도킹을 접어 둔 화면(설정)에서 컴포저가 모달로 되살아나고,
  // 열림을 보고 자기를 억제하는 What's New가 영영 뜨지 않는다.
  setState({ quickLaunchOpen: !pinned, quickLaunchPinned: pinned });
}

// pendingOperationFocus/consumeOperationFocus와 같은 request/consume 계약. 컴포저는 의도만 남기고,
// 실행 좌표·포커스 승계는 Operations 화면이 자기 규율로 처리한다.
export function requestQuickLaunch(request: QuickLaunchRequest): void {
  setState({ pendingQuickLaunch: request });
}

export function consumeQuickLaunch(): void {
  if (state.pendingQuickLaunch === null) return;
  setState({ pendingQuickLaunch: null });
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
  const settings = getGlobalSettingsStoreState().state;
  if (settings && !settings.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)) {
    void setGlobalSettingsField("seenFeatureTours", [...settings.seenFeatureTours, COMMISSIONING_SEEN_KEY]);
  }
  if (!state.onboardingOpen) return;
  setState({ onboardingOpen: false });
}

/** 코어가 소유한 Codex 정독 표면의 주소. built-in.tsx의 서술자 id와 한 벌이다. */
const CODEX_SURFACE_ID = "codex";

function closeExpandedSurfacesFor(surfaceId: string): void {
  for (const instance of getExpandedSurfaceState().instances) {
    if (instance.surfaceId === surfaceId) closeExpandedSurface(instance.instanceId);
  }
}

export function openCodexReader(req: CodexReaderRequest): void {
  setState({ codexReader: req, codexReaderExpanded: false });
}

export function expandCodexReader(): void {
  if (state.codexReader === null) return;
  setState({ codexReaderExpanded: true });
  // 확대는 곧 슬롯을 하나 차지하는 일이다. 표면을 열지 않고 플래그만 세우면 리더가
  // 캔버스에 직접 겹쳐 그려져 다른 표면을 덮는다.
  openExpandedSurface({ surfaceId: CODEX_SURFACE_ID });
}

export function collapseCodexReader(): void {
  setState({ codexReaderExpanded: false });
  closeExpandedSurfacesFor(CODEX_SURFACE_ID);
}

export function closeCodexReader(): void {
  setState({ codexReader: null, codexReaderExpanded: false });
  closeExpandedSurfacesFor(CODEX_SURFACE_ID);
}

export function resolveOnboardingOnBootstrap(): void {
  if (state.bootstrapped) return;
  const settings = getGlobalSettingsStoreState();
  if (settings.loadStatus === "pending") return;
  if (settings.loadStatus === "failed" || !settings.state) {
    setState({ bootstrapped: true, onboardingOpen: false });
    return;
  }
  const commissioningSeen = settings.state.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)
    || readStoredCommissioningSeen();
  const shouldOpen = state.theaters.length === 0 && !commissioningSeen;
  // 커미셔닝을 여는 순간이 곧 "이 사람에게 이 제품은 처음"이라는 판정이다. 같은 자리에서
  // 릴리스 워터마크를 찍어 두면, 릴리스 노트가 언제 도착하든 지난 묶음이 첫 화면에 따라
  // 붙지 않는다 — 처음 설치한 사람에게 "새 소식"은 성립하지 않는다.
  if (shouldOpen && state.version && readStoredWhatsNewSeenVersion() === null) {
    writeStoredWhatsNewSeenVersion(state.version);
  }
  setState({ bootstrapped: true, onboardingOpen: shouldOpen ? true : state.onboardingOpen });
}

export async function migrateStoredCommissioningSeen(): Promise<boolean> {
  if (commissioningMigrationAttempted) return false;
  commissioningMigrationAttempted = true;
  const settings = getGlobalSettingsStoreState();
  if (settings.loadStatus !== "ready" || !settings.state) return false;
  if (settings.state.seenFeatureTours.includes(COMMISSIONING_SEEN_KEY)) return false;
  if (!readStoredCommissioningSeen()) return false;
  const saved = await setGlobalSettingsField(
    "seenFeatureTours",
    [...settings.state.seenFeatureTours, COMMISSIONING_SEEN_KEY],
  );
  if (saved) removeStoredCommissioningSeen();
  return saved;
}

export function removeTheater(theaterId: string): void {
  const theaters = state.theaters.filter((theater) => theater.id !== theaterId);
  const activeTheaterId = chooseActiveTheaterId(theaters, state.activeTheaterId === theaterId ? null : state.activeTheaterId);
  const operationNotifications = pruneNotificationsForTheater(state.operationNotifications, theaterId);
  const removedOperationIds = new Set(state.operations.filter((operation) => operation.theaterId === theaterId).map((operation) => operation.id));
  const activeOperationId = state.activeOperationId && removedOperationIds.has(state.activeOperationId) ? null : state.activeOperationId;
  const activeOperationAcknowledged = activeOperationId === null ? true : state.activeOperationAcknowledged;
  // 사라진 Theater를 겨눈 Quick Launch 요청은 여기서 함께 버린다. 소비 조건이
  // request.theaterId === activeTheaterId라, 그 Theater가 없어지면 조건이 영영 성립하지 않아
  // 프롬프트가 실행되지도 지워지지도 않은 채 남는다.
  const pendingQuickLaunch = state.pendingQuickLaunch?.theaterId === theaterId ? null : state.pendingQuickLaunch;
  writeStoredActiveTheaterId(activeTheaterId);
  setState({ theaters, activeTheaterId, activeOperationId, activeOperationAcknowledged, operationNotifications, pendingQuickLaunch });
}

export function dismissNotificationsForOperation(operationId: string): void {
  const operationNotifications = removeNotificationForOperation(state.operationNotifications, operationId);
  if (operationNotifications === state.operationNotifications) return;
  setState({ operationNotifications });
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
  const unchanged = {
    whatsNewOpen: current.whatsNewOpen,
    automaticWhatsNewVersion: current.automaticWhatsNewVersion,
    selectedReleaseNoteKey: current.selectedReleaseNoteKey,
  };
  if (!firstReal || !current.version || firstReal.version !== current.version || readStoredWhatsNewSeenVersion() === firstReal.version) {
    return unchanged;
  }
  // 처음 설치한 사람에게는 "새 소식"이 성립하지 않는다 — 그들에게는 전부가 처음이라, 지난
  // 릴리스 묶음을 펼쳐 봤자 아직 본 적 없는 제품의 변경 이력일 뿐이다. 본 기록이 없고
  // Theater도 아직 없으면 첫 실행으로 보고, 현재 버전을 읽은 것으로 표시해 다음 릴리스부터
  // 알린다. Theater가 있으면 이 브라우저가 처음일 뿐인 기존 사용자이므로 평소대로 연다.
  if (readStoredWhatsNewSeenVersion() === null && current.bootstrapped && current.theaters.length === 0) {
    writeStoredWhatsNewSeenVersion(firstReal.version);
    return unchanged;
  }
  return {
    whatsNewOpen: true,
    automaticWhatsNewVersion: firstReal.version,
    selectedReleaseNoteKey: releaseNoteKey(firstReal.version, firstRealIndex),
  };
}

function remapReleaseNoteKey(
  previousNotes: readonly { readonly version: string }[],
  previousKey: string | null,
  nextNotes: readonly { readonly version: string }[],
): string | null {
  if (previousKey === null) return firstReleaseNoteKey(nextNotes);
  const previousIndex = previousNotes.findIndex((note, index) => releaseNoteKey(note.version, index) === previousKey);
  const selected = previousNotes[previousIndex];
  if (!selected) return firstReleaseNoteKey(nextNotes);

  const occurrence = previousNotes.slice(0, previousIndex + 1).filter((note) => note.version === selected.version).length;
  let seen = 0;
  for (let index = 0; index < nextNotes.length; index += 1) {
    if (nextNotes[index]?.version !== selected.version) continue;
    seen += 1;
    if (seen === occurrence) return releaseNoteKey(selected.version, index);
  }
  return firstReleaseNoteKey(nextNotes);
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

function removeStoredCommissioningSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(COMMISSIONING_SEEN_STORAGE_KEY);
  } catch {
    // 저장소가 막힌 환경에서는 legacy 표식을 그대로 둔다.
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
