import { MACOS_TRAFFIC_LIGHTS } from "@fleet-console/protocol/desktop/chrome";
import { remapReleaseNoteKey, firstReleaseNoteKey, releaseNoteKeyExists } from "../../../../features/updates/client/release-state.js";
import { rememberSeen } from "../../../../features/onboarding/client/seen-store.js";
import { liftNestedActivity } from "../../../../features/objectives/shared/records/activity.js";
import type { ClientNotification } from "../../../../features/execution/shared/notifications.js";
import type { ObjectiveRuntimeHydration, ObjectiveRuntimeState } from "../../../../features/execution/shared/client-contract.js";

import { buildObjectiveSearchEntries } from "./objective-search.js";
import { fetchObjectiveRecords, putObjectiveOrder } from "./api.js";
import { clearLegacyObjectiveOrder, readLegacyObjectiveOrder } from "./legacy-objective-order.js";
import { getGlobalSettingsStoreState, setGlobalSettingsField } from "../../../../features/settings/client/global-settings-store.js";
import { acknowledgeIdleArrival } from "../../../../features/execution/client/objective-marks.js";
import { noteObjectiveFocused } from "./palette-recent.js";
import { stowExpandedSurfaces, closeExpandedSurface, getExpandedSurfaceState, openExpandedSurface } from "../chrome/expanded-surface/store.js";
import { observeConsoleVersion } from "./console-version.js";
import type {
  CodexReaderRequest,
  ConnectionState,
  ConsoleState,
  ControlHolder,
  NotificationKind,
  NotificationPreferences,
  ObjectiveGroup,
  ObjectiveNotification,
  ObjectiveRecord,
  ObserverStatus,
  NewSessionTarget,
  LaunchRequest,
  NewSessionRejection,
  NewSessionSeed,
  ReleaseNotesLocale,
  ReleaseNotesResponse,
  ThemeId,
  TheaterBootstrap,
  TheaterInfo,
} from "./types.js";

type Listener = () => void;

const THEME_HINT_STORAGE_KEY = "fleet-console.theme-hint";
// 다크 테마가 여럿이던 시절 모드 전환이 돌아갈 다크를 기억하던 키다. 다크가 하나뿐이라 지우기만 한다.
const RETIRED_LAST_DARK_THEME_STORAGE_KEY = "fleet-console.last-dark-theme";
// 서버 seenFeatureTours로 일방향 승격하기 위한 legacy migration 읽기·삭제 전용 키다. 새 값은 쓰지 않는다.
const COMMISSIONING_SEEN_STORAGE_KEY = "fleet-console.commissioningSeen";
// "화면 안내 다시 보기"가 온보딩 전체를 초기화할 때 함께 지우는 최초 설정 가이드 시청 키.
export const COMMISSIONING_SEEN_KEY = "commissioning";

const NOTIFICATION_PREFERENCES_STORAGE_KEY = "fleet-console.notificationPreferences";
const NOTIFICATION_PREFERENCES_VERSION = 1;
const DEFAULT_THEME: ThemeId = "dark";
const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  globalMute: false,
  dnd: false,
  mutedTheaterIds: {},
};

const listeners = new Set<Listener>();
// 플러그인의 관측값은 원천으로 보존한다. 공개 축만 부모가 대표하는 구성원의 살아 있는 활동을 반영한다.
let rawObjectiveRuntime: Readonly<Record<string, ObjectiveRuntimeState>> = {};
let nestedMembersByParent: ReadonlyMap<string, readonly string[]> = new Map();
// 호스트가 붙잡은 Console/Computer 허용 요청도 사람의 답을 기다리는 활동이다.
let pendingUseRequestIds: ReadonlySet<string> = new Set();

let notificationSeq = 0;

let commissioningMigrationAttempted = false;

let state: ConsoleState = {
  connection: "connecting",
  connectionLostAt: null,
  controlHolder: null,
  controlCurtainDismissed: false,
  controlReclaimed: null,
  consoleName: "",
  channel: "unknown",
  // The SDK ConsoleTheme union matches ThemeId; the selected theme passes
  // through to the plugin context unchanged.
  activeTheme: DEFAULT_THEME,
  version: "",
  updateAvailable: false,
  latestVersion: null,
  shellUpdateRequired: false,
  portMode: "dynamic",
  requestedPort: null,
  effectivePort: 0,
  portHonored: true,
  theaters: [],
  objectiveRecords: [],
  nestedObjectiveRecords: [],
  nestedBodySelection: {},
  objectiveRecordsHydrated: false,
  groups: [],
  activeObjectiveId: null,
  activeObjectiveAcknowledged: true,
  selectedObjectiveId: null,
  objectiveRecordRuntime: {},
  // 기본은 ready 다. 런타임 축을 보고하는 플러그인이 스스로 pending 을 선언하고 시작하며,
  // 그런 플러그인이 하나도 없는 Console 은 기다릴 권위가 없으므로 처음부터 신뢰 가능한 상태다 —
  // 기본을 pending 으로 두면 아무도 보고하지 않는 설치에서 재개가 영구히 막힌다.
  objectiveRecordRuntimeHydration: "ready",
  objectiveRecordRuntimeError: null,
  addingTheater: false,
  theaterError: null,
  objectiveRecordsViewActive: false,
  objectiveRecordSearchOpen: false,
  objectiveRecordSearchSeed: null,
  objectiveRecordSearchSeedNonce: 0,
  objectiveRecordSearchMode: null,
  mobileNewSessionOpen: false,
  newSessionSeed: null,
  pendingLaunch: null,
  whatsNewOpen: false,
  releaseNotes: [],
  releaseNotesLocale: null,
  releaseNotesLoading: false,
  releaseNotesError: null,
  releaseNotesSourceRef: null,
  releaseNotesFetchedAt: null,
  releaseNotesStale: false,
  selectedReleaseNoteKey: null,
  onboardingOpen: false,
  bootstrapped: false,
  pendingObjectiveFocus: null,
  keyboardFocusRequest: null,
  pendingSideBarAddTheater: false,
  newSession: null,
  newSessionFocusRequest: 0,
  newSessionRejection: null,
  keyboardShortcutsOpen: false,
  objectiveRecordNotifications: {},
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
  state = withLiveSelection({ ...state, ...partitionObjectiveRecordsPatch(patch) });
  emit();
}

/**
 * 선택은 살아 있는 Objective 을 가리킬 때만 남는다 — 제거·보관이 어느 경로로 오든 여기 한 곳에서 거둔다. 사라진
 * Objective 을 가리킨 채 남으면 목표가 없는 문맥을 따라간다. Theater 사이 이동은 선택의 수명과 무관하다.
 */
function withLiveSelection(next: ConsoleState): ConsoleState {
  const selectedId = next.selectedObjectiveId;
  if (selectedId === null) return next;
  const selected = next.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === selectedId);
  if (selected && selectedId !== next.activeObjectiveId) return next;
  return { ...next, selectedObjectiveId: null };
}

/**
 * `objectiveRecords`는 최상위 부모 목록이다. 각 부모의 `sessions`에서 구성원 표시 뷰(`nestedObjectiveRecords`)를
 * 매번 파생하며, 자식을 별도 평면 목록으로 저장하거나 방송하지 않는다.
 * 구성원 구성이 바뀌면 부모의 공개 활동(구성원의 대기·실행 끌어올리기)도 여기서 다시 센다.
 */
function partitionObjectiveRecordsPatch(patch: Partial<ConsoleState>): Partial<ConsoleState> {
  if (!patch.objectiveRecords) {
    if (!("nestedObjectiveRecords" in patch)) return patch;
    const { nestedObjectiveRecords: _derived, ...rest } = patch;
    return rest;
  }
  const nested = patch.objectiveRecords.flatMap((parent) => (parent.sessions ?? []).map((child): ObjectiveRecord => ({...(child),
id: child.id,
theaterId: parent.theaterId,
title: child.id.slice(0, 8),
ts: child.ts,
parentObjectiveId: parent.id})));
  const members = membersByParent(nested);
  const membersChanged = !sameMembersByParent(members, nestedMembersByParent);
  nestedMembersByParent = members;
  const derived = membersChanged && !("objectiveRecordRuntime" in patch) ? deriveNestedRuntime(rawObjectiveRuntime, members, state.objectiveRecordRuntime) : null;
  return { ...patch, nestedObjectiveRecords: nested, ...(derived && derived !== state.objectiveRecordRuntime ? { objectiveRecordRuntime: derived } : {}) };
}

function membersByParent(nested: readonly ObjectiveRecord[]): ReadonlyMap<string, readonly string[]> {
  const next = new Map<string, string[]>();
  for (const objectiveRecord of nested) {
    const parentId = objectiveRecord.parentObjectiveId!;
    const list = next.get(parentId);
    if (list) list.push(objectiveRecord.id); else next.set(parentId, [objectiveRecord.id]);
  }
  return next;
}

function sameMembersByParent(left: ReadonlyMap<string, readonly string[]>, right: ReadonlyMap<string, readonly string[]>): boolean {
  return left.size === right.size && [...left].every(([parentId, members]) => {
    const other = right.get(parentId);
    return other?.length === members.length && members.every((id, index) => id === other[index]);
  });
}

/**
 * 전체 목록 — 구성원까지. 스토어 안의 쓰기는 구성원을 떨어뜨리지 않도록 이것을 고쳐 `objectiveRecords` 로 다시 싣고,
 * 밖에서는 id 로 한 Objective 을 찾는 소비자(호출자 이름·제스처 대상)만 명시적으로 쓴다. 목록 표면은 `objectiveRecords` 다.
 */
export function objectiveRecordsIncludingNested(current: ConsoleState = state): readonly ObjectiveRecord[] {
  return current.nestedObjectiveRecords.length === 0 ? current.objectiveRecords : [...current.objectiveRecords, ...current.nestedObjectiveRecords];
}
const allObjectiveRecords = objectiveRecordsIncludingNested;

/** id 로 찾는다 — 기본 목록에 없는 구성원도 찾는다. 목록이 아니라 한 Objective 을 가리키는 소비자의 길이다. */
export function findObjective(objectiveId: string, current: ConsoleState = state): ObjectiveRecord | null {
  return current.objectiveRecords.find((objectiveRecord) => objectiveRecord.id === objectiveId)
    ?? current.nestedObjectiveRecords.find((objectiveRecord) => objectiveRecord.id === objectiveId)
    ?? null;
}

/** 부모가 대표하는 구성원 — 부모 패널의 본문 교체·노드 줄처럼 구성원을 명시적으로 보는 자리가 읽는다. */
export function nestedObjectiveRecordsOf(parentObjectiveId: string, current: ConsoleState = state): readonly ObjectiveRecord[] {
  return current.nestedObjectiveRecords.filter((objectiveRecord) => objectiveRecord.parentObjectiveId === parentObjectiveId);
}

/** 부모 패널의 본문을 구성원으로 바꾸거나(`objectiveId`) 부모 자신으로 돌린다(`null`·부모 id). 세션은 그대로다. */
export function selectNestedBody(parentObjectiveId: string, objectiveId: string | null): void {
  const body = withNestedBody(parentObjectiveId, objectiveId);
  if ("nestedBodySelection" in body) setState(body);
}

/** 구성원을 가리킨 포커스는 부모 패널로 가고, 부모 패널이 그 구성원의 본문을 보인다. */
function nestedTarget(objectiveId: string): ObjectiveRecord | null {
  return state.nestedObjectiveRecords.find((objectiveRecord) => objectiveRecord.id === objectiveId) ?? null;
}

function withNestedBody(parentObjectiveId: string, bodyObjectiveId: string | null): Pick<ConsoleState, "nestedBodySelection"> | Record<string, never> {
  const current = state.nestedBodySelection[parentObjectiveId];
  const next = bodyObjectiveId && bodyObjectiveId !== parentObjectiveId ? bodyObjectiveId : undefined;
  if (current === next) return {};
  const nestedBodySelection = { ...state.nestedBodySelection };
  if (next) nestedBodySelection[parentObjectiveId] = next; else delete nestedBodySelection[parentObjectiveId];
  return { nestedBodySelection };
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

/** 이 원격 세션이 회수·대체로 끝났다. 종착 상태로 굳어 그 뒤의 폴링·재합류가 멈춘다. */
export function applyControlReclaimed(reason: "reclaimed" | "superseded"): void {
  setState({ controlReclaimed: reason });
}

export function dismissControlCurtain(): void {
  setState({ controlCurtainDismissed: true });
}

export function setObjectiveRecordsViewActive(active: boolean): void {
  if (state.objectiveRecordsViewActive === active) return;
  setState({ objectiveRecordsViewActive: active });
}

export function setActiveTheme(theme: ThemeId): void {
  applyThemeToDocument(theme);
  setState({ activeTheme: theme });
}

export function applyObserverStatus(status: ObserverStatus): void {
  // 서버가 이 문서와 다른 버전이 됐다면 화면은 옛 번들이다 — 상태를 옛 화면에 그리는 대신 새로 받는다.
  if (observeConsoleVersion(status.version)) return;
  setState({
    consoleName: status.name,
    channel: status.channel,
    version: status.version,
    updateAvailable: status.updateAvailable,
    latestVersion: status.latestVersion ?? null,
    shellUpdateRequired: status.shellUpdateRequired === true,
    portMode: status.portMode,
    requestedPort: status.requestedPort,
    effectivePort: status.effectivePort,
    portHonored: status.portHonored,
  });
}

export function beginReleaseNotesFetch(): void {
  setState({ releaseNotesLoading: true, releaseNotesError: null });
}

export function applyReleaseNotes(response: ReleaseNotesResponse, locale: ReleaseNotesLocale): void {
  setState({
    releaseNotes: response.notes,
    releaseNotesLocale: locale,
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: response.sourceRef,
    releaseNotesFetchedAt: response.fetchedAt,
    releaseNotesStale: response.stale,
    // key에는 배열 위치가 들어가므로 refresh가 앞에 릴리스를 추가해도 같은 버전·중복 순번을 다시 찾는다.
    selectedReleaseNoteKey: remapReleaseNoteKey(state.releaseNotes, state.selectedReleaseNoteKey, response.notes),
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
    globalThis.localStorage?.removeItem(RETIRED_LAST_DARK_THEME_STORAGE_KEY);
  } catch {
    // localStorage 접근 불가 환경에서는 DOM 테마만 적용한다.
  }
}

/**
 * 테마 힌트·서버 주입값을 읽는 규칙. 퇴역 다크 팔레트(instrument/maritime/carbon)는 dark로, 퇴역 라이트
 * (whites와 그 전의 daywatch/drydock)는 light로 옮긴다 — 서버 정규화(settings-domain)·theme-boot.js와
 * 극성이 일치해야 첫 페인트가 튀지 않는다.
 */
function readThemeId(value: string | null | undefined): ThemeId | null {
  if (value === "dark" || value === "instrument" || value === "maritime" || value === "carbon") return "dark";
  if (value === "light" || value === "whites" || value === "daywatch" || value === "drydock") return "light";
  return null;
}

export function readStoredThemeHint(): ThemeId | null {
  try {
    return readThemeId(globalThis.localStorage?.getItem(THEME_HINT_STORAGE_KEY));
  } catch {
    return null;
  }
}

// 테마 극성(라이트/다크) 판별은 이 한 곳이 소유한다 — App의 극성 전환 안내 토스트와 브라우저 표면이
// 같은 규칙을 봐야 한쪽만 다른 판정을 내리는 일이 없다.
export function themePolarity(theme: ThemeId): "light" | "dark" {
  return theme;
}

export function readServerInjectedTheme(): ThemeId | null {
  if (typeof document === "undefined") return null;
  if (document.documentElement.getAttribute("data-theme-source") !== "server") return null;
  return readThemeId(document.documentElement.getAttribute("data-theme"));
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
    if (platform === "darwin" || platform === "win32") trackDesktopZoomFactor();
  }
}

/**
 * 네이티브 창 컨트롤은 페이지 줌을 타지 않는다 — macOS 신호등은 좌측 76 DIP에, Windows 캡션
 * 버튼 스트립은 우측 138 DIP에 그대로 머문다. 그런데 그 자리를 비워 두는 밴드 양 끝의 예약
 * 폭은 CSS px이라 줌에 비례해 자라고 줄었다: 확대하면 브랜드가 신호등에서 떨어져 나가고(실측
 * 131%에서 40 DIP), 축소하면 신호등 위로 올라탔다(76%에서 8.5 DIP 겹침). Windows에서는 같은
 * 어긋남이 축소 쪽에서 도움말·호스트 칩을 캡션 버튼 아래로 밀어 넣는다.
 *
 * 창 폭(outerWidth, DIP)과 뷰포트 폭(innerWidth, CSS px)의 비가 곧 줌이다 — 타이틀바를 숨긴
 * 창(hiddenInset·hidden)에는 웹 콘텐츠 밖의 가로 크롬이 없어 두 값이 같은 창을 잰다. 그 비를
 * 문서에 심어 예약 폭을 DIP로 되돌리면 양 끝 클러스터는 어느 줌에서든 네이티브 컨트롤 옆
 * 같은 자리에 선다. 세로 정렬은 이 축의 몫이 아니다 — 셸이 신호등을 밴드 중앙으로 옮기고
 * 캡션 스트립 높이를 줌만큼 키워 맡는다(window-policy.ts·title-bar-overlay-refresh.ts).
 */
let desktopZoomFactor = 1;
const desktopZoomListeners = new Set<() => void>();

export function getDesktopZoomFactor(): number { return desktopZoomFactor; }
export function subscribeDesktopZoomFactor(listener: () => void): () => void {
  desktopZoomListeners.add(listener);
  return () => { desktopZoomListeners.delete(listener); };
}

function trackDesktopZoomFactor(): void {
  let pendingMeasurement = false;
  const retry = (): void => apply();
  const retryWhenVisible = (): void => {
    if (document.visibilityState === "visible") apply();
  };
  const apply = (): void => {
    const outerWidth = window.outerWidth;
    const innerWidth = window.innerWidth;
    // 비활성 창을 다시 읽으면 폭이 0일 수 있다. 이전 줌을 보존하고 유효한 폭을 얻을 때까지만 임시 신호로 재시도한다.
    // resize를 상시 관측하면 아래에 기록한 전체화면 전환의 서로 다른 프레임을 줌으로 오인하므로 대기가 끝나면 반드시 걷는다.
    if (outerWidth <= 0 || innerWidth <= 0) {
      if (!pendingMeasurement) {
        pendingMeasurement = true;
        window.addEventListener("resize", retry);
        window.addEventListener("focus", retry);
        document.addEventListener("visibilitychange", retryWhenVisible);
      }
      return;
    }
    if (pendingMeasurement) {
      pendingMeasurement = false;
      window.removeEventListener("resize", retry);
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    }
    const factor = outerWidth / innerWidth;
    desktopZoomFactor = factor;
    const style = document.documentElement.style;
    style.setProperty("--desktop-zoom", `${factor}`);
    const lights = MACOS_TRAFFIC_LIGHTS;
    style.setProperty("--desktop-macos-compact-width", `${(lights.left + lights.span + lights.right) / factor}px`);
    // 셸의 52px 줄 가운데 배치와 같은 DIP 반올림을 적용한다.
    style.setProperty("--desktop-traffic-bottom", `${(Math.round((52 * factor - lights.height) / 2) + lights.height) / factor}px`);
    for (const listener of desktopZoomListeners) listener();
  };
  /**
   * 다시 재는 신호는 resize가 아니라 devicePixelRatio의 변화다. 줌이 바뀌면 둘 다 오지만,
   * resize는 줌과 무관한 전환에서도 오고 그중 네이티브 전체화면 전환은 두 값이 서로 다른
   * 프레임에 갱신된다 — 실측에서 innerWidth는 이미 전체화면인데 outerWidth는 아직 창
   * 크기여서, 줌 1.31인 창이 0.64로 기록됐다(전체화면은 이 여백을 쓰지 않아 눈에 띄지 않을 뿐
   * 그대로 남는 거짓값이다). devicePixelRatio는 줌이 실제로 바뀔 때만 움직이고, 그 순간
   * 창 폭은 건드려지지 않으므로 두 값이 언제나 같은 창을 가리킨다.
   *
   * 배율이 다른 모니터로 건너가도 이 신호가 오지만, 그때 두 폭은 그대로라 같은 줌이 다시
   * 계산될 뿐이다. 미디어 쿼리는 현재 배율에서만 참이므로 한 번 울릴 때마다 다시 건다.
   */
  const watch = (): void => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", () => { apply(); watch(); }, { once: true });
  };
  apply();
  watch();
}


export function hydrateTheaters(theaters: readonly TheaterInfo[]): void {
  setState({ theaters });
}

export function hydrateTheaterBootstrap(bootstrap: TheaterBootstrap): void {
  hydrateTheaters(bootstrap.theaters);
}

export function hydrateObjectiveRecords(objectiveRecords: readonly ObjectiveRecord[]): void {
  setState({ objectiveRecords: objectiveRecords, objectiveRecordsHydrated: true });
  migrateLegacyObjectiveOrders(objectiveRecords);
}

// 초기 요청 응답이 늦는 동안 launch 수화가 먼저 도착할 수 있다. 그 패널을 초기 응답이 덮어쓰지 않게 합친다.
export function hydrateInitialObjectiveRecords(objectiveRecords: readonly ObjectiveRecord[]): void {
  const initialIds = new Set(objectiveRecords.map((objectiveRecord) => objectiveRecord.id));
  const launchedBeforeInitialHydration = state.objectiveRecords.filter((objectiveRecord) => !initialIds.has(objectiveRecord.id));
  setState({ objectiveRecords: [...objectiveRecords, ...launchedBeforeInitialHydration], objectiveRecordsHydrated: true });
  migrateLegacyObjectiveOrders(objectiveRecords);
}

const migratingOrderTheaters = new Set<string>();

function migrateLegacyObjectiveOrders(objectiveRecords: readonly ObjectiveRecord[]): void {
  for (const theaterId of new Set(objectiveRecords.map((objectiveRecord) => objectiveRecord.theaterId))) {
    if (migratingOrderTheaters.has(theaterId)) continue;
    const legacyOrder = readLegacyObjectiveOrder(theaterId);
    if (legacyOrder.length === 0) continue;
    const theaterObjectiveRecords = objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theaterId);
    if (theaterObjectiveRecords.some((objectiveRecord) => objectiveRecord.order !== undefined)) {
      clearLegacyObjectiveOrder(theaterId);
      continue;
    }
    const ids = new Set(theaterObjectiveRecords.map((objectiveRecord) => objectiveRecord.id));
    const retained = legacyOrder.filter((id) => ids.has(id));
    if (retained.length === 0) {
      clearLegacyObjectiveOrder(theaterId);
      continue;
    }
    migratingOrderTheaters.add(theaterId);
    void putObjectiveOrder(theaterId, retained).then((changed) => {
      for (const objectiveRecord of changed) applyObjectiveUpdate(objectiveRecord);
      clearLegacyObjectiveOrder(theaterId);
    }).catch(() => {
      // 이관 실패 시 로컬 원본을 보존하고 다음 수화에서 다시 시도한다.
    }).finally(() => migratingOrderTheaters.delete(theaterId));
  }
}

export function objectiveRecordOrderFromNodes(objectiveRecords: readonly ObjectiveRecord[]): readonly string[] {
  return [...objectiveRecords].sort((left, right) => {
    if (left.order !== undefined && right.order !== undefined) return left.order - right.order || compareObjectiveCreatedAt(left, right);
    if (left.order !== undefined) return -1;
    if (right.order !== undefined) return 1;
    return compareObjectiveCreatedAt(left, right);
  }).map((objectiveRecord) => objectiveRecord.id);
}

const pendingOrders = new Map<string, Promise<void>>();
const orderRevisions = new Map<string, number>();

export function setObjectiveOrder(theaterId: string, ids: readonly string[]): void {
  const theaterObjectiveRecords = state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.theaterId === theaterId);
  const valid = new Set(theaterObjectiveRecords.map((objectiveRecord) => objectiveRecord.id));
  const orderedIds = [...new Set(ids.filter((id) => valid.has(id)))];
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const revision = (orderRevisions.get(theaterId) ?? 0) + 1;
  orderRevisions.set(theaterId, revision);
  setState({ objectiveRecords: state.objectiveRecords.map((objectiveRecord) => objectiveRecord.theaterId !== theaterId ? objectiveRecord : {
    ...objectiveRecord,
    order: positions.get(objectiveRecord.id),
  }) });
  const previous = pendingOrders.get(theaterId) ?? Promise.resolve();
  // 같은 Theater의 두 드래그는 직렬 전송하되 화면은 즉시 최신 순서를 그린다.
  const commit = previous.then(async () => {
    try {
      const changed = await putObjectiveOrder(theaterId, orderedIds);
      if (orderRevisions.get(theaterId) === revision) for (const objectiveRecord of changed) applyObjectiveUpdate(objectiveRecord, true);
    } catch {
      if (orderRevisions.get(theaterId) !== revision) return;
      try {
        const serverObjectiveRecords = await fetchObjectiveRecords();
        if (orderRevisions.get(theaterId) === revision) hydrateObjectiveRecords(serverObjectiveRecords);
      } catch { /* 연결 복구 후 SSE/다음 조회가 다시 동기화한다. */ }
    }
  });
  pendingOrders.set(theaterId, commit);
  void commit.finally(() => {
    if (pendingOrders.get(theaterId) !== commit) return;
    pendingOrders.delete(theaterId);
    // 요청 중에 눌러 둔 순서 사건은 다른 창·에이전트의 더 새 순서였을 수 있다 — 마지막 요청이 끝나면 서버 목록으로 한 번 맞춘다.
    if (!suppressedOrders.delete(theaterId)) return;
    void fetchObjectiveRecords().then((serverObjectiveRecords) => {
      if (!pendingOrders.has(theaterId)) hydrateObjectiveRecords(serverObjectiveRecords);
    }).catch(() => { /* 연결 복구 후 SSE/다음 조회가 다시 동기화한다. */ });
  });
}

const suppressedOrders = new Set<string>();

export function applyObjectiveUpdate(objectiveRecord: ObjectiveRecord, confirmedOrder = false): void {
  // 내 요청이 진행 중일 때 서버가 이전 순서의 개별 SSE를 보내도 낙관적 배치를 되돌리지 않는다.
  if (!confirmedOrder && pendingOrders.has(objectiveRecord.theaterId) && objectiveRecord.order !== findObjective(objectiveRecord.id)?.order) {
    suppressedOrders.add(objectiveRecord.theaterId);
    objectiveRecord = { ...objectiveRecord, order: findObjective(objectiveRecord.id)?.order };
  }
  const index = state.objectiveRecords.findIndex((op) => op.id === objectiveRecord.id);
  const objectiveRecords = [...state.objectiveRecords];
  // MCP·다른 창에서 생성한 Objective은 로컬 launch 응답이 없다. 같은 이벤트로 추가·갱신한다.
  if (index === -1) objectiveRecords.push(objectiveRecord);
  else objectiveRecords[index] = objectiveRecord;
  setState({ objectiveRecords });
}

/**
 * 제거 사건 — 다른 창이나 에이전트가 닫은(삭제 유예에 들어간) Objective 을 재조회 없이 내린다.
 * 활성 대상이었다면 비운다: 없는 패널을 겨눈 채 두면 대화 화면이 사라진 본문를 기다린다.
 */
export function applyObjectiveRemoved(objectiveId: string): void {
  if (!findObjective(objectiveId)) return;
  const objectiveRecords = state.objectiveRecords.filter((objectiveRecord) => objectiveRecord.id !== objectiveId);
  const objectiveRecordNotifications = removeNotificationForObjective(state.objectiveRecordNotifications, objectiveId);
  const activeObjectiveId = state.activeObjectiveId === objectiveId ? null : state.activeObjectiveId;
  // 사라진 구성원을 보이던 부모 패널은 부모 자신으로 돌아온다. 부모가 사라지면 그 선택도 거둔다.
  const selection = Object.entries(state.nestedBodySelection).filter(([parentId, bodyId]) => parentId !== objectiveId && bodyId !== objectiveId);
  const nestedBodySelection = selection.length === Object.keys(state.nestedBodySelection).length ? state.nestedBodySelection : Object.fromEntries(selection);
  setState({ objectiveRecords, objectiveRecordNotifications, activeObjectiveId, nestedBodySelection, ...(activeObjectiveId === null ? { activeObjectiveAcknowledged: true } : {}) });
}

export function hydrateGroups(groups: readonly ObjectiveGroup[]): void {
  setState({ groups });
}

/** 그룹 사건 — 다른 클라이언트·에이전트가 만들거나 고친 그룹이 새로고침 없이 선다. 같은 사건으로 추가·갱신한다. */
export function applyGroupUpdate(group: ObjectiveGroup): void {
  const index = state.groups.findIndex((item) => item.id === group.id);
  const groups = [...state.groups];
  if (index === -1) groups.push(group);
  else groups[index] = group;
  setState({ groups });
}

export function applyGroupRemoved(groupId: string): void {
  if (!state.groups.some((item) => item.id === groupId)) return;
  setState({ groups: state.groups.filter((item) => item.id !== groupId) });
}

// 구성원은 패널로 서지 않는다 — 구성원을 가리킨 포커스는 부모 패널로 가고, 부모 패널이 그 구성원의 본문을 보인다.
// 판정은 스토어의 구성원 목록 하나라 다른 셸(모바일)에서도 같다.
export function setActiveObjective(
  requestedObjectiveId: string | null,
  options?: { readonly acknowledged?: boolean },
): void {
  const nested = requestedObjectiveId === null ? null : nestedTarget(requestedObjectiveId);
  const objectiveId = nested ? nested.parentObjectiveId! : requestedObjectiveId;
  const acknowledged = objectiveId === null
    ? true
    : options?.acknowledged === false
      ? false
      : acknowledgeIdleArrival(objectiveId);
  // 대화 화면·사이드바·모바일 셸의 보통 포커스는 여기로 온다 — 팔레트의 「최근」 순서가 그 손길에도 반응하려면
  // 교차 Theater 전용 경로(focusObjective)만이 아니라 이 공용 활성화에서도 기록해야 한다.
  if (objectiveId !== null) noteObjectiveFocused(objectiveId);
  const body = nested ? withNestedBody(nested.parentObjectiveId!, nested.id) : {};
  // 여는 것은 고르는 것을 덮는다 — 어느 경로로든 Objective 이 활성이 되면 사이드바의 선택은 끝난다.
  const selection = objectiveId !== null && state.selectedObjectiveId !== null ? { selectedObjectiveId: null } : {};
  // Objective 을 여는 것은 아직 보내지 않은 새 세션 화면을 걷는다 — 입력 전에는 만든 것이 없으니 남는 것도 없다.
  const leaveNewSession = objectiveId !== null && state.newSession !== null ? { newSession: null } : {};
  if (state.activeObjectiveId === objectiveId && state.activeObjectiveAcknowledged === acknowledged && !("nestedBodySelection" in body) && !("selectedObjectiveId" in selection) && !("newSession" in leaveNewSession)) return;
  setState({ activeObjectiveId: objectiveId, activeObjectiveAcknowledged: acknowledged, ...body, ...selection, ...leaveNewSession });
}

/**
 * 열지 않고 고른다 — 「더블클릭으로 열기」를 켠 사이드바의 한 번 클릭. 활성·카메라·미확인 도착 표식은 건드리지 않는다
 * (setActiveObjective 은 도착을 확인 처리한다). 이미 활성인 것을 고르면 선택은 비어 있다.
 */
export function selectObjective(objectiveId: string | null): void {
  const next = objectiveId !== null && objectiveId === state.activeObjectiveId ? null : objectiveId;
  if (state.selectedObjectiveId === next) return;
  setState({ selectedObjectiveId: next });
}

/**
 * 끌어올리기 전의 런타임 — 플러그인이 보고한 원 관측이다. 공개 축(`state.objectiveRecordRuntime`)은 부모가 구성원의 대기·실행을
 * 대표하므로, 부모 자신의 활동을 가려야 하는 소비자(목표 표면의 결정 대기)만 이것을 명시적으로 읽는다.
 */
export function ownObjectiveRuntime(): Readonly<Record<string, ObjectiveRuntimeState>> {
  return rawObjectiveRuntime;
}

export function setObjectiveRuntime(objectiveId: string, next: ObjectiveRuntimeState): void {
  // live/idle도 명시 항목으로 저장한다. 항목 삭제로 유휴를 표현하면 resumeAvailable 마커를 가진
  // live 세션이 resolveObjectiveActivity 폭백에서 dormant로 재분류된다(Codex P1) —
  // "플러그인이 관측한 live idle"과 "미관측"은 구분되어야 한다.
  if (sameRuntimeState(rawObjectiveRuntime[objectiveId], next)) return;
  rawObjectiveRuntime = { ...rawObjectiveRuntime, [objectiveId]: next };
  setState({ objectiveRecordRuntime: deriveNestedRuntime(rawObjectiveRuntime, nestedMembersByParent, state.objectiveRecordRuntime) });
}

function sameRuntimeState(current: ObjectiveRuntimeState | undefined, next: ObjectiveRuntimeState): boolean {
  if (!current || current.lifecycle !== next.lifecycle) return false;
  if (current.lifecycle === "dormant" || next.lifecycle === "dormant") return true;
  return current.activity === next.activity;
}

export function clearObjectiveRuntime(objectiveId: string): void {
  if (!(objectiveId in rawObjectiveRuntime)) return;
  const next = { ...rawObjectiveRuntime };
  delete next[objectiveId];
  rawObjectiveRuntime = next;
  setState({ objectiveRecordRuntime: deriveNestedRuntime(rawObjectiveRuntime, nestedMembersByParent, state.objectiveRecordRuntime) });
}

export function setObjectiveUseRequestIds(ids: readonly string[]): void {
  const next = new Set(ids);
  if (next.size === pendingUseRequestIds.size && [...next].every((id) => pendingUseRequestIds.has(id))) return;
  pendingUseRequestIds = next;
  setState({ objectiveRecordRuntime: deriveNestedRuntime(rawObjectiveRuntime, nestedMembersByParent, state.objectiveRecordRuntime) });
}

/** 부모의 공개 활동 — 살아 있는 구성원이 기다리면 부모도 대기, 일하면 부모는 백그라운드다. 부모 자신의 실행이 먼저다. */
function deriveNestedRuntime(
  raw: Readonly<Record<string, ObjectiveRuntimeState>>,
  membersByRoot: ReadonlyMap<string, readonly string[]>,
  previous: Readonly<Record<string, ObjectiveRuntimeState>>,
): Readonly<Record<string, ObjectiveRuntimeState>> {
  const result: Record<string, ObjectiveRuntimeState> = { ...raw };
  for (const id of pendingUseRequestIds) if (raw[id]?.lifecycle === "live") result[id] = { lifecycle: "live", activity: "awaiting" };
  for (const [rootId, memberIds] of membersByRoot) {
    const root = result[rootId];
    if (!root || root.lifecycle !== "live") continue;
    const members = memberIds.map((id) => result[id]).filter((value): value is Extract<ObjectiveRuntimeState, { lifecycle: "live" }> => value?.lifecycle === "live");
    const activity = liftNestedActivity(root.activity, members.map((member) => member.activity));
    if (activity !== root.activity) result[rootId] = { lifecycle: "live", activity };
  }
  const rawIds = Object.keys(result);
  if (rawIds.length === Object.keys(previous).length && rawIds.every((id) => sameRuntimeState(previous[id], result[id]!))) return previous;
  for (const id of rawIds) if (previous[id] && sameRuntimeState(previous[id], result[id]!)) result[id] = previous[id];
  return result;
}

// 런타임 축의 신뢰도는 전역 하나로 둔다 — 지금 이 축을 보고하는 소유자는 터미널 플러그인 하나뿐이고,
// degraded의 소비처도 전역 배너 하나다. 소유자가 늘어 서로 다른 신뢰도를 동시에 말해야 하는 날이
// 오면 그때 pluginId 별 맵으로 쪼갠다. 어느 경우든 모르는 상태를 유휴로 접지 않는 계약은 같다.
export function setObjectiveRuntimeHydration(next: ObjectiveRuntimeHydration, error?: string): void {
  const nextError = next === "degraded" ? error ?? null : null;
  if (state.objectiveRecordRuntimeHydration === next && state.objectiveRecordRuntimeError === nextError) return;
  setState({ objectiveRecordRuntimeHydration: next, objectiveRecordRuntimeError: nextError });
}

export function raiseObjectiveNotification(input: ClientNotification): void {
  if (!input.objectiveId) return;
  // 기본 목록의 Objective 만 알림을 쌓는다 — 구성원의 대기는 부모의 공개 활동(대기)이 이미 대표한다.
  const objectiveRecord = state.objectiveRecords.find((item) => item.id === input.objectiveId);
  if (!objectiveRecord) return;
  const theaterId = objectiveRecord.theaterId ?? null;
  const theaterLabel = state.theaters.find((theater) => theater.id === theaterId)?.label ?? theaterId ?? "Unknown";
  const objectiveRecordLabel = objectiveRecord.title;
  const kind = mapNotificationKind(input.kind);
  notificationSeq += 1;
  // 같은 패널의 알림은 누적하지 않고 최신 것으로 교체한다(last-writer-wins).
  setState({
    objectiveRecordNotifications: {
      ...state.objectiveRecordNotifications,
      [input.objectiveId]: {
        kind,
        objectiveId: input.objectiveId,
        theaterId,
        theaterLabel,
        objectiveRecordLabel,
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
  setState({
    theaters,
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

/**
 * 확대 도구는 닫지 않고 접어 대화를 드러낸다. 같은 도구가 새 대화의 Theater로 따라간다.
 * 레일과 사이드바는 건드리지 않는다.
 * 플러그인은 이동 전에 자기 표면을 따로 닫지 않는다 — 접힌 페인은 같은 인스턴스로 남는다.
 */
export function revealObjectiveStage(): void {
  stowExpandedSurfaces();
}

/**
 * 이동 — 팔레트·알림·목표 표면·플러그인의 「이 Objective 으로」. 본문이 이동을 따른다: 구성원을 가리키면 부모 패널이 그 구성원의
 * 본문을, 부모를 가리키면 부모 자신의 본문을 보인다(보던 구성원 본문에 가려 부모의 질문이 안 보이던 자리). Alt 순환처럼
 * 패널 사이를 걷는 이동은 `keepBody` 로 보던 본문을 그대로 둔다.
 */
export function focusObjective(requestedObjectiveId: string, options?: { readonly keepBody?: boolean }): void {
  const nested = nestedTarget(requestedObjectiveId);
  const objectiveId = nested ? nested.parentObjectiveId! : requestedObjectiveId;
  const objectiveRecord = state.objectiveRecords.find((item) => item.id === objectiveId);
  if (!objectiveRecord) return;
  revealObjectiveStage();
  noteObjectiveFocused(objectiveId);
  const activeObjectiveAcknowledged = acknowledgeIdleArrival(objectiveId);
  const body = options?.keepBody === true && !nested ? {} : withNestedBody(objectiveId, nested ? nested.id : null);
  setState({
    activeObjectiveId: objectiveId,
    activeObjectiveAcknowledged,
    pendingObjectiveFocus: objectiveId,
    objectiveRecordNotifications: removeNotificationForObjective(state.objectiveRecordNotifications, objectiveId),
    selectedObjectiveId: null,
    // 새 세션 화면에서 보낸 첫 메시지가 Objective 을 세우면 그 포커스가 화면을 걷는다(다른 길로 연 Objective 도 같다).
    newSession: null,
    ...body,
  });
}

export function consumeObjectiveFocus(): void {
  if (state.pendingObjectiveFocus === null) return;
  setState({ pendingObjectiveFocus: null });
}

// 커맨드 밴드 → 사이드바 단방향 요청 신호 — 사이드바가 effect로 소비(consume)한다.
// pendingObjectiveFocus/consumeObjectiveFocus와 같은 request/consume 계약.
export function requestSideBarAddTheater(): void {
  setState({ pendingSideBarAddTheater: true });
}

export function consumeSideBarAddTheater(): void {
  if (!state.pendingSideBarAddTheater) return;
  setState({ pendingSideBarAddTheater: false });
}

export function requestObjectiveKeyboardFocus(objectiveId: string): void {
  setState({
    keyboardFocusRequest: {
      objectiveId,
      requestId: (state.keyboardFocusRequest?.requestId ?? 0) + 1,
    },
  });
}

/**
 * 본문에 「새 세션 화면」을 연다 — 사이드바 맨 위 「+」, 팔레트 「New Objective」, 새 세션 단축키. 여는 것만으로는 아무것도
 * 만들지 않고, 첫 메시지가 실행 의도(requestLaunch)로 나간다. 보던 대화는 칸에서 물러난다.
 */
export function openNewSession(target: NewSessionTarget): void {
  if (state.newSession?.theaterId === target.theaterId) return;
  setState({ newSession: target });
}

/** 열린 새 세션 화면의 컴포저로 포커스를 돌려 달라는 요청. 화면이 닫혀 있으면 아무 일도 없다. */
export function requestNewSessionFocus(): void {
  if (state.newSession === null) return;
  setState({ newSessionFocusRequest: state.newSessionFocusRequest + 1 });
}

export function closeNewSession(): void {
  if (state.newSession === null) return;
  setState({ newSession: null });
}

// 소비자(ObjectiveRecordsSideBar)가 없는 동안 쌓인 사이드바 요청을 부수 효과 없이 폐기한다 —
// consume은 UI 반응(다이얼로그 열림 등)을 동반하므로 경계 정리에는 쓸 수 없다.
export function clearPendingSideBarSignals(): void {
  setState({ pendingSideBarAddTheater: false });
}

export function openKeyboardShortcuts(): void {
  if (state.keyboardShortcutsOpen) return;
  setState({ keyboardShortcutsOpen: true });
}

export function closeKeyboardShortcuts(): void {
  if (!state.keyboardShortcutsOpen) return;
  setState({ keyboardShortcutsOpen: false });
}

export function nextObjectiveId(order: readonly string[], currentId: string | null, delta: number): string | null {
  if (order.length === 0) return null;
  const current = currentId ? order.indexOf(currentId) : -1;
  const nextIndex = current === -1
    ? (delta > 0 ? 0 : order.length - 1)
    : (current + delta + order.length) % order.length;
  return order[nextIndex] ?? null;
}

// 그룹은 Objective과 같은 Theater일 때만 그 Objective에 적용된다.
// 활성 Theater가 아니라 Objective 자신의 Theater를 기준 삼는다.
// 서버 PATCH는 groupId가 문자열인지만 보고 Theater 소속을 검사하지 않으므로(objective-records-domain.ts),
// API로 타 Theater 그룹이 붙은 Objective이 존재할 수 있다. 사이드바는 그 조합을 미분류로 읽으므로,
// 이 검사가 없으면 캡션만 홀로 그룹 이름을 주장해 두 면이 서로를 부정한다.
export function resolveObjectiveGroup(
  objectiveRecord: ObjectiveRecord,
  groupById: ReadonlyMap<string, ObjectiveGroup>,
): ObjectiveGroup | null {
  if (!objectiveRecord.groupId) return null;
  const group = groupById.get(objectiveRecord.groupId);
  if (!group || group.theaterId !== objectiveRecord.theaterId) return null;
  return group;
}

// GROUP 축 SideBar 표시 순서와 Alt+←/→ 순환 순서가 갈라지지 않도록 Objective 정렬을 이 한 함수로 단일화한다.
// order가 있는 노드는 서버 순서, 나머지는 생성 순서로 뒤에 붙는다.
export function sortObjectiveRecordsByOrder(
  objectiveRecords: readonly ObjectiveRecord[],
  objectiveRecordOrder: readonly string[],
): readonly ObjectiveRecord[] {
  if (objectiveRecordOrder.length === 0) return [...objectiveRecords].sort(compareObjectiveCreatedAt);
  const explicitOrder = new Map(objectiveRecordOrder.map((id, index) => [id, index]));
  return [...objectiveRecords].sort((left, right) => {
    const leftIndex = explicitOrder.get(left.id);
    const rightIndex = explicitOrder.get(right.id);
    if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
    if (leftIndex !== undefined) return -1;
    if (rightIndex !== undefined) return 1;
    return compareObjectiveCreatedAt(left, right);
  });
}

// 그룹 적용 visible 순서(비-collapsed 그룹 order → 그룹 내 objectiveRecordOrder → ungrouped)로 flatten한 배열을 반환.
// GROUP 축 SideBar visible 순서와 Alt+←/→ cycling 순서의 공유 SSoT.
// collapsedGroups: 접힌 그룹 id 목록 — 해당 그룹의 멤버는 결과에서 제외한다.
export function flattenGroupedOrder(
  objectiveRecords: readonly ObjectiveRecord[],
  groups: readonly ObjectiveGroup[],
  objectiveRecordOrder: readonly string[],
  collapsedGroups: readonly string[] = [],
): readonly ObjectiveRecord[] {
  const sorted = sortObjectiveRecordsByOrder(objectiveRecords, objectiveRecordOrder);
  const collapsedSet = new Set(collapsedGroups);
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const buckets = new Map<string | null, ObjectiveRecord[]>();
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

// Alt+←/→는 그룹 배치 순서를 따른다. 사이드바의 'Sort by status' 축은 이 순서에 관여하지 않는다.
export function focusCycleObjectiveIds(
  objectiveRecords: readonly ObjectiveRecord[],
  groups: readonly ObjectiveGroup[],
  objectiveRecordOrder: readonly string[],
  collapsedGroups: readonly string[],
): readonly string[] {
  return flattenGroupedOrder(objectiveRecords, groups, objectiveRecordOrder, collapsedGroups)
    .map((objectiveRecord) => objectiveRecord.id);
}

export function compareObjectiveCreatedAt(left: ObjectiveRecord, right: ObjectiveRecord): number {
  return left.ts.createdAt - right.ts.createdAt || left.id.localeCompare(right.id);
}

export function openObjectiveSearch(seed?: string): void {
  setState({ objectiveRecordSearchOpen: true, objectiveRecordSearchSeed: seed ?? null, objectiveRecordSearchSeedNonce: state.objectiveRecordSearchSeedNonce + 1 });
}

export function closeObjectiveSearch(): void {
  setState({ objectiveRecordSearchOpen: false, objectiveRecordSearchSeed: null, objectiveRecordSearchMode: null });
}

export function toggleObjectiveSearch(): void {
  if (state.objectiveRecordSearchOpen) closeObjectiveSearch();
  else openObjectiveSearch();
}

export function setObjectiveSearchMode(mode: ConsoleState["objectiveRecordSearchMode"]): void {
  if (state.objectiveRecordSearchMode === mode) return;
  setState({ objectiveRecordSearchMode: mode });
}

/**
 * 모바일 「새 대화」 시트를 연다 — 모바일 홈의 새 대화 입구와 폰에서 부른 `composer.open`이 쓴다. 데스크톱의
 * 새 세션 화면과 같은 실행 의도(requestLaunch)로 나가고, 쓰던 문장은 시트를 닫아도 시트 쪽이 지킨다.
 */
export function openMobileNewSession(): void {
  if (state.mobileNewSessionOpen) return;
  setState({ mobileNewSessionOpen: true });
}

export function closeMobileNewSession(): void {
  if (!state.mobileNewSessionOpen) return;
  setState({ mobileNewSessionOpen: false });
}

/**
 * 새 세션 컴포저에 실을 시드 — 플러그인·부유 위젯이 `composer.open`으로 건넨 초안과 행선지다. 화면(데스크톱)이나
 * 시트(모바일)가 열리며 한 번 읽고 비운다. 남기면 다음 열림이 지난 문장을 되쓴다.
 */
export function seedNewSession(seed: NewSessionSeed): void {
  setState({ newSessionSeed: seed });
}

export function consumeNewSessionSeed(): NewSessionSeed | null {
  const seed = state.newSessionSeed;
  if (seed !== null) setState({ newSessionSeed: null });
  return seed;
}

/**
 * 새 세션 실행의 거절. 데스크톱은 새 세션 화면, 모바일은 새 대화 시트가 이 칸을 읽어 문면·칩·사유를 되살린다.
 * 그 표면이 이미 닫혔으면 초안이 있는 거절만 표면을 그 초안과 함께 다시 연다 — 빈 직접 실행은 되돌릴 문면이 없다.
 */
export function rejectNewSession(rejection: NewSessionRejection & { readonly theaterId: string; readonly mobile: boolean }): void {
  const { theaterId, mobile, ...slot } = rejection;
  const open = mobile ? state.mobileNewSessionOpen : state.newSession !== null;
  if (!open && slot.draft === null) return;
  setState({
    newSessionRejection: slot,
    ...(open ? {} : mobile ? { mobileNewSessionOpen: true } : { newSession: { theaterId } }),
  });
}

/** 새 세션 화면·시트가 거절을 문면·칩에 반영한 뒤 한 번 비운다. */
export function consumeNewSessionRejection(): void {
  if (state.newSessionRejection === null) return;
  setState({ newSessionRejection: null });
}

// pendingObjectiveFocus/consumeObjectiveFocus와 같은 request/consume 계약. 컴포저는 의도만 남기고,
// 실행 좌표·포커스 승계는 ObjectiveRecords 화면이 자기 규율로 처리한다.
export function requestLaunch(request: LaunchRequest): void {
  setState({ pendingLaunch: request });
}

export function consumeLaunch(): void {
  if (state.pendingLaunch === null) return;
  setState({ pendingLaunch: null });
}

export function openWhatsNew(): void {
  if (state.releaseNotes.length === 0 || state.whatsNewOpen) return;
  setState({ whatsNewOpen: true, selectedReleaseNoteKey: state.selectedReleaseNoteKey ?? firstReleaseNoteKey(state.releaseNotes) });
}

export function closeWhatsNew(): void {
  if (!state.whatsNewOpen) return;
  setState({ whatsNewOpen: false });
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
    // 첫 실행 직후에는 온보딩 엔진이 같은 seenFeatureTours 필드를 저장하는 중일 수 있다. 같은 필드의 겹친 저장은
    // 거절되므로, 인플라이트 저장이 끝난 뒤 최신 값 위에 덧붙이는 경로로 남긴다 — 그러지 않으면 기록이 유실되어
    // 다음 실행에 가이드가 다시 선다.
    rememberSeen([COMMISSIONING_SEEN_KEY]);
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
  // 대화 칸에 직접 겹쳐 그려져 다른 표면을 덮는다.
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
  const objectiveRecordNotifications = pruneNotificationsForTheater(state.objectiveRecordNotifications, theaterId);
  const removedObjectiveIds = new Set(allObjectiveRecords().filter((objectiveRecord) => objectiveRecord.theaterId === theaterId).map((objectiveRecord) => objectiveRecord.id));
  const activeObjectiveId = state.activeObjectiveId && removedObjectiveIds.has(state.activeObjectiveId) ? null : state.activeObjectiveId;
  const activeObjectiveAcknowledged = activeObjectiveId === null ? true : state.activeObjectiveAcknowledged;
  // 사라진 Theater를 겨눈 실행 요청도 함께 버린다.
  const pendingLaunch = state.pendingLaunch?.theaterId === theaterId ? null : state.pendingLaunch;
  // 잊은 Theater 를 고른 채 서 있던 새 세션 화면은 Theater 를 비운다 — 화면이 기본 규칙으로 다시 고른다.
  const newSession = state.newSession?.theaterId === theaterId ? { theaterId: null } : state.newSession;
  setState({ theaters, activeObjectiveId, activeObjectiveAcknowledged, objectiveRecordNotifications, pendingLaunch, newSession });
}

export function dismissNotificationsForObjective(objectiveId: string): void {
  const objectiveRecordNotifications = removeNotificationForObjective(state.objectiveRecordNotifications, objectiveId);
  if (objectiveRecordNotifications === state.objectiveRecordNotifications) return;
  setState({ objectiveRecordNotifications });
}

export function objectiveRecordSearchEntries(current: ConsoleState) {
  return buildObjectiveSearchEntries(current);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function removeNotificationForObjective(
  notifications: Readonly<Record<string, ObjectiveNotification>>,
  objectiveId: string,
): Readonly<Record<string, ObjectiveNotification>> {
  if (!notifications[objectiveId]) return notifications;
  const next = { ...notifications };
  delete next[objectiveId];
  return next;
}

function pruneNotificationsForTheater(
  notifications: Readonly<Record<string, ObjectiveNotification>>,
  theaterId: string,
): Readonly<Record<string, ObjectiveNotification>> {
  let changed = false;
  const next: Record<string, ObjectiveNotification> = {};
  for (const [objectiveId, notification] of Object.entries(notifications)) {
    if (notification.theaterId === theaterId) {
      changed = true;
      continue;
    }
    next[objectiveId] = notification;
  }
  return changed ? next : notifications;
}

function mapNotificationKind(kind: string): NotificationKind {
  const normalized = kind.toLowerCase();
  if (normalized === "ended" || normalized.includes(".end") || normalized.includes("done")) return "ended";
  return "input-waiting";
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
