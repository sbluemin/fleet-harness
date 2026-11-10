import path from "node:path";

export const DESKTOP_COMPUTER_CAPTURE_PATH = "/api/v1/desktop/computer-capture";
export interface DesktopComputerCaptureTarget {
  readonly id: string;
  readonly pid: number;
  readonly windowId: number;
  readonly processStartedAt: number;
  readonly title: string;
}
export function isDesktopComputerCaptureTarget(value: unknown): value is DesktopComputerCaptureTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<DesktopComputerCaptureTarget>;
  return typeof target.id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(target.id)
    && Number.isSafeInteger(target.pid) && (target.pid ?? 0) > 0
    && Number.isSafeInteger(target.windowId) && (target.windowId ?? 0) > 0
    && Number.isFinite(target.processStartedAt) && (target.processStartedAt ?? 0) > 0
    && typeof target.title === "string" && target.title.length <= 4096;
}

export type ConsoleOwnerKind = "cli" | "desktop";

export interface ConsoleOwnerMetadata {
  readonly kind: ConsoleOwnerKind;
  readonly id: string;
  readonly protocolVersion: number;
}

export interface DesktopProtocolEnvironment {
  readonly owner: ConsoleOwnerMetadata;
  readonly resourceRoot: string;
}

export interface CanonicalConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
  readonly dataDir: string;
  readonly stateFile: string;
  readonly settingsFile: string;
  readonly capturesDir: string;
}

export interface ResolveCanonicalConsolePathsInput {
  readonly tmpDir: string;
  readonly uid: number;
  readonly fleetDataDir: string;
  readonly consoleDirOverride?: string;
}

export interface ResolveCanonicalLocalConsolePathsInput {
  readonly packageRoot: string;
}

export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_RESOURCE_ROOT_ENV = "FLEET_CONSOLE_RESOURCE_ROOT";
export const DESKTOP_OWNER_ID_ENV = "FLEET_CONSOLE_OWNER_ID";
export const DESKTOP_OWNER_KIND_ENV = "FLEET_CONSOLE_OWNER_KIND";
export const DESKTOP_PROTOCOL_VERSION_ENV = "FLEET_CONSOLE_PROTOCOL_VERSION";
export const DESKTOP_RESOURCE_ROOT_MARKER = ".fleet-console-resource-root";
export const DESKTOP_DEVELOPMENT_ENV = "FLEET_CONSOLE_DESKTOP_DEVELOPMENT";
/**
 * Optional capability a shell grants its managed Console: the shell procures Console builds from
 * this source. A managed Console without it runs under a shell that cannot install what Console's
 * own updater would offer, so its updates wait for a shell update instead.
 */
export const DESKTOP_CONSOLE_SOURCE_ENV = "FLEET_DESKTOP_CONSOLE_SOURCE";
export const DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE = "github-release";

const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_SETTINGS_FILE_NAME = "settings.json";
const CONSOLE_CAPTURES_DIR_NAME = "captures";

export function hasDesktopGithubReleaseConsoleSource(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DESKTOP_CONSOLE_SOURCE_ENV] === DESKTOP_CONSOLE_SOURCE_GITHUB_RELEASE;
}

export function isDesktopDevelopmentEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DESKTOP_DEVELOPMENT_ENV] === "1";
}

export function isCompatibleDesktopOwner(owner: ConsoleOwnerMetadata | undefined, version: string, expected: { readonly id: string; readonly version: string }): boolean {
  return owner?.kind === "desktop"
    && owner.id === expected.id
    && owner.protocolVersion === DESKTOP_PROTOCOL_VERSION
    && version === expected.version;
}

export function resolveCanonicalStableConsolePaths(input: ResolveCanonicalConsolePathsInput): CanonicalConsolePaths {
  const dir = input.consoleDirOverride ?? path.join(input.tmpDir, `${LOCK_DIR_NAME}-${input.uid}-stable`);
  const dataDir = input.consoleDirOverride ?? path.join(input.fleetDataDir, CONSOLE_DATA_DIR_NAME);
  return {
    dir,
    lockFile: path.join(dir, LOCK_FILE_NAME),
    dataDir,
    stateFile: path.join(dataDir, CONSOLE_STATE_FILE_NAME),
    settingsFile: path.join(dataDir, CONSOLE_SETTINGS_FILE_NAME),
    capturesDir: path.join(dataDir, CONSOLE_CAPTURES_DIR_NAME),
  };
}

export function resolveCanonicalLocalConsolePaths(input: ResolveCanonicalLocalConsolePathsInput): CanonicalConsolePaths {
  const dir = path.join(path.resolve(input.packageRoot, "..", ".."), ".fleet", CONSOLE_DATA_DIR_NAME);
  return {
    dir,
    lockFile: path.join(dir, LOCK_FILE_NAME),
    dataDir: dir,
    stateFile: path.join(dir, CONSOLE_STATE_FILE_NAME),
    settingsFile: path.join(dir, CONSOLE_SETTINGS_FILE_NAME),
    capturesDir: path.join(dir, CONSOLE_CAPTURES_DIR_NAME),
  };
}

export function formatDesktopResourceRootMarker(): string {
  return `${DESKTOP_PROTOCOL_VERSION}\n`;
}

export function isDesktopResourceRootMarkerValid(content: string): boolean {
  return content.trim() === String(DESKTOP_PROTOCOL_VERSION);
}

// ---------- Objective Browser 네이티브 뷰 ----------
//
// 창을 든 셸이 Objective 브라우저의 탭을 자기 창 안의 실제 Chromium 뷰로 그린다. 사람은 그 뷰를 직접 보고
// 만지며, 픽셀을 찍어 보내는 일이 없다. 방향은 셸의 다른 동기화와 같다 — 셸이 콘솔의 스냅샷을 구독하고,
// 그 결과(CDP 응답·이벤트·뷰 크기)를 relay 로 되돌려 보낸다. 브라우저 정책·탭 상태·도구는 콘솔이 소유한다.

export const DESKTOP_BROWSER_PATH = "/api/v1/desktop/browser";
export const DESKTOP_BROWSER_EVENTS_PATH = "/api/v1/desktop/browser/events";
export const DESKTOP_BROWSER_RELAY_PATH = "/api/v1/desktop/browser/relay";
export const DESKTOP_BROWSER_EVENT = "desktop:browser";
/** 네이티브 뷰가 현재 Console의 Objective 스트림을 열 때만 셸이 붙이는 뷰 id. 인증·Desktop 권한 표식이 아니다. */
export const DESKTOP_BROWSER_VIEW_HEADER = "x-fleet-browser-view";

/**
 * 셸이 띄워야 하는 뷰 하나.
 *
 * `visible` 은 **사용자 presentation** 뿐이다 — 브라우저 표면에 이 탭을 그릴지(표시 탭이고 표면이 열려 있을 때). 자리와 크기는 셸만
 * 정한다(표면의 페이지 영역). 셸은 macOS CDP 를 위해 네이티브 뷰를 숨기거나 0×0 으로 두지 않고, 보이지 않을 때는 Console 뒤에 parking 한 뒤
 * 실제 DIP 를 `sizes` 로 올린다. 표면이 닫혀도 뷰는 살아 있고, 실행 크기는 그 뷰의 `sizes` relay 가 말한다.
 */
export interface DesktopBrowserView {
  readonly id: string;
  /** 브라우저 id(현재 Console 전역 `global`). 필드 이름은 옛 Objective 단위와의 호환을 유지한다. */
  readonly objectiveId: string;
  /** Electron 세션 파티션 — Console 전역 브라우저의 모든 스페이스가 공유하며 앱 수명 동안만 산다. */
  readonly partition: string;
  /**
   * 영속 브라우저 프로필의 id. `null` 이면 이 뷰는 위 `partition` 의 메모리 세션에 산다.
   * 값이 있으면 셸이 자기 데이터 루트 아래에서 경로를 만들어 디스크 세션을 연다 — 콘솔은 경로를 보내지 않는다.
   *
   * 양쪽 방향의 옛 짝을 모두 견뎌야 한다. 옛 셸은 이 필드를 모르고 `partition` 만 읽어 임시 세션으로 떨어지고,
   * **옛 콘솔**은 이 필드를 아예 싣지 않으므로 검사는 없는 것(`undefined`)을 `null` 과 같이 받아들인다 —
   * 그러지 않으면 스냅샷 하나가 통째로 거부되어 새 Desktop 이 옛 Console 에서 탭을 열지 못한다.
   */
  readonly profile?: string | null;
  /** 표면에 이 탭을 그릴지. 네이티브 `setVisible` 이 아니다. */
  readonly visible: boolean;
  /** 처음 열 때의 주소. 그 뒤의 항해는 CDP 명령으로 온다. */
  readonly url: string;
}

/**
 * 콘솔이 어떤 뷰의 디버거로 보내려는 CDP 명령. 결과는 relay 의 `results` 로 돌아온다.
 * `viewId` 가 `DESKTOP_BROWSER_SHELL_VIEW` 면 뷰가 아니라 셸 자신에게 묻는 명령이다(`Fleet.*`) — 이 기계의 Chrome
 * 프로필을 세고 그 쿠키를 세션 파티션에 넣는 일처럼, 창을 든 기계에서만 답할 수 있는 것.
 */
export interface DesktopBrowserCommand { readonly id: number; readonly viewId: string; readonly method: string; readonly params: Record<string, unknown> }
export const DESKTOP_BROWSER_SHELL_VIEW = "shell";
/** 셸이 이 기계의 Google Chrome 프로필을 센다. 결과: `{ available, reason, profiles }`. */
export const DESKTOP_BROWSER_CHROME_PROFILES = "Fleet.chromeProfiles";
/**
 * 셸이 Chrome 프로필의 쿠키를 대상 세션에 넣는다. 인자: `{ partition, profileId, browserProfile }`,
 * 결과: `{ cookies }`. `browserProfile` 이 있으면 그 영속 프로필로, 없으면 `partition` 의 메모리 세션으로 간다.
 */
export const DESKTOP_BROWSER_IMPORT_COOKIES = "Fleet.importChromeCookies";
/** 셸이 영속 브라우저 프로필의 저장소를 비운다. 인자: `{ browserProfile }`, 결과: `{ cleared: true }`. */
export const DESKTOP_BROWSER_CLEAR_PROFILE = "Fleet.clearBrowserProfile";
/**
 * 영속 브라우저 프로필 id 로 받아들이는 모양. 이 id 는 셸에서 디렉터리 이름이 되므로 Windows 파일명으로
 * 안전한 문자만 남긴다 — 점·콜론을 빼면 예약 이름과 확장자 해석 문제도 함께 사라진다.
 */
export const DESKTOP_BROWSER_PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** 지금은 프로필이 하나뿐이다. 저장 키를 id 로 잡아 두어 이름 붙인 여러 프로필이 나중에 이주 없이 붙는다. */
export const DESKTOP_BROWSER_DEFAULT_PROFILE = "default";

export interface DesktopBrowserSnapshot {
  /** 스냅샷마다 오른다 — 셸이 옛 스냅샷을 새 것 위에 덮어쓰지 않게. */
  readonly generation: number;
  readonly views: readonly DesktopBrowserView[];
  /** 아직 결과를 받지 못한 명령 전부. 셸은 이미 실행한 id 를 건너뛴다. */
  readonly commands: readonly DesktopBrowserCommand[];
  /**
   * Console 이 현재 사용하는 유효 단축키 조합 목록(shortcut-bindings 문법, 예: "Mod+Shift+KeyB").
   * 네이티브 뷰에 포커스가 있을 때 일치하는 단축키를 Console 창으로 중계하기 위해 셸에 전달한다.
   * 선택 필드이므로 옛 Console 은 싣지 않고, 옛 셸은 이를 무시한다.
   */
  readonly shortcuts?: readonly string[];
  /**
   * 이 스냅샷을 낸 Console 프로세스의 수명 표. generation 과 명령 id 는 프로세스마다 처음부터 다시 세므로, 셸은 이 값이
   * 바뀌면(같은 origin 에 스트림만 다시 붙은 원격 Console 의 재기동) 옛 수명의 뷰·실행 기록·generation 을 버린다.
   * 선택 필드이므로 옛 Console 은 싣지 않고, 옛 셸은 이를 무시한다.
   */
  readonly epoch?: string;
  /** Console 이 소유한 단 하나의 브라우저 표면(칸 또는 독립 창). 없으면 표면이 닫혀 있다. */
  readonly surface?: DesktopBrowserSurface | null;
  /** 셸이 크롬(주소줄·세로 탭 표시줄·추가 메뉴)에 그릴 브라우저 상태. 표면이 열려 있는 동안 상태가 바뀔 때마다 실린다. */
  readonly chrome?: DesktopBrowserChrome | null;
}

/**
 * 셸이 브라우저 표면(칸·독립 창)과 그 크롬을 자기가 그리고, 어느 스페이스를 보여 줄지도 자기가 정한다는 능력. 이 능력이 없는 셸에서는
 * 플릿 브라우저가 열리지 않는다 — Console 이 크롬을 그리던 길은 남아 있지 않다. 이 능력을 모르는 Console 은 표면을 만들지 않으므로
 * 셸의 브라우저도 열리지 않는다. 크롬 투영의 모양이 바뀌면 이름을 바꾼다: 셸과 Console 은 따로 갱신되므로, 짝이 맞지 않는 동안에는
 * 서로 다른 모양을 주고받는 대신 브라우저가 닫혀 있어야 한다(옛 이름 `browser-surface` 는 탭 그룹 시절의 투영이다).
 */
export const DESKTOP_BROWSER_SURFACE_CAPABILITY = "browser-surface-spaces";
export interface DesktopBrowserSurface {
  readonly id: string;
  readonly browserId: string;
  /** 칸은 메인 창 오른쪽, 창은 따로 뜬 독립 창이다. */
  readonly mode: "pane" | "window";
  /** 사람이 기존 분리 창을 다시 부를 때만 증가한다. */
  readonly focusRequest?: number;
}
export interface DesktopBrowserSurfaceRelay {
  readonly id: string;
  readonly status: "opened" | "closed";
}

/**
 * 플릿 브라우저 스페이스 계약 — Console(탭의 소속·쓰기 정책·상한)과 셸(표시·선택·그리드)이 함께 읽는다.
 *
 * 브라우저는 Console 전체에 하나이고 쿠키·로그인 프로필도 하나다. 그 안의 탭은 스페이스로 나뉘어 화면만 따로 보인다.
 * - 사령관 스페이스(`commodore:<commodoreId>`) — 사령관마다 하나. 그 사령관 세션과 그 사령관이 소유한 Objective 의 지휘관·구성원이
 *   함께 쓴다. 사령관이 있는 동안 탭이 없어도 존재한다.
 * - 디폴트 스페이스(`DESKTOP_BROWSER_DEFAULT_SPACE_ID`) — 사람이 연 탭과, 사령관에 묶이지 않은 세션의 탭이 선다.
 * 어느 스페이스를 화면에 띄울지는 셸이 정하고 기억한다. Console 은 탭마다 스페이스와 연 쪽을 적어 에이전트의 쓰기를 가리고,
 * 표시 탭(`activeTabId`) 하나만 안다.
 */
export const DESKTOP_BROWSER_DEFAULT_SPACE_ID = "default";
export const DESKTOP_BROWSER_COMMODORE_SPACE_PREFIX = "commodore:";
/** 동시 생성 예약까지 센 탭 상한 — 네이티브 뷰의 자원 사용을 제한한다. 사령관 스페이스는 그 사령관의 모든 Objective 가 모이므로 디폴트의 두 배다. */
export const DESKTOP_BROWSER_TAB_LIMITS = { commodore: 16, default: 8, total: 32 } as const;
export type DesktopBrowserSpaceKind = "commodore" | "default";

export function commodoreBrowserSpaceId(commodoreId: string): string {
  return `${DESKTOP_BROWSER_COMMODORE_SPACE_PREFIX}${commodoreId}`;
}

export function commodoreOfBrowserSpace(spaceId: string): string | null {
  return spaceId.startsWith(DESKTOP_BROWSER_COMMODORE_SPACE_PREFIX) ? spaceId.slice(DESKTOP_BROWSER_COMMODORE_SPACE_PREFIX.length) || null : null;
}

export function browserSpaceKindOf(spaceId: string): DesktopBrowserSpaceKind {
  return commodoreOfBrowserSpace(spaceId) ? "commodore" : "default";
}

export function browserSpaceTabLimit(spaceId: string): number {
  return DESKTOP_BROWSER_TAB_LIMITS[browserSpaceKindOf(spaceId)];
}

/** 페이지가 띄워 답을 기다리는 alert·confirm. 크롬은 페이지 위에 그리고, 답은 Console 의 REST 로 보낸다. */
export interface DesktopBrowserPageDialog { readonly type: "alert" | "confirm"; readonly message: string }
export interface DesktopBrowserChromeTab {
  readonly id: string;
  readonly spaceId: string;
  readonly url: string;
  readonly title: string;
  /** `data:` 아이콘 URL 이거나 없음. 크롬은 이 값을 이미지 소스로만 쓴다. */
  readonly favicon: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly dialog?: DesktopBrowserPageDialog;
}
export type DesktopBrowserViewportPreset = "responsive" | "mobile" | "tablet";
/** 크롬 투영의 스페이스 한 칸. 디폴트와 모든 사령관 스페이스가 탭이 없어도 실린다 — 디폴트가 맨 앞이다. */
export interface DesktopBrowserChromeSpace {
  readonly id: string;
  readonly kind: DesktopBrowserSpaceKind;
  /** 사람이 읽는 이름 — 사령관 이름. 모르면 빈 문자열이고 크롬이 기본 낱말을 쓴다. */
  readonly label: string;
  /** 이 스페이스의 에이전트가 지금 브라우저를 쓰는 중인가. */
  readonly driving: boolean;
  /** 에이전트의 작업 탭인 이 스페이스의 탭들. */
  readonly agentTabIds: readonly string[];
  /** 이 스페이스의 뷰포트 프리셋 — 뷰포트는 스페이스마다 따로다. */
  readonly viewportPreset: DesktopBrowserViewportPreset;
}
/** Console 이 소유한 브라우저 상태의 크롬용 투영. 셸은 이것을 그리기만 하고 바꾸는 일은 Console 의 REST 로 요청한다. */
export interface DesktopBrowserChrome {
  readonly browserId: string;
  readonly spaces: readonly DesktopBrowserChromeSpace[];
  readonly tabs: readonly DesktopBrowserChromeTab[];
  /** 사람 화면에 띄운 탭. 셸은 이 탭의 스페이스를 따라가고, 스페이스를 옮길 때는 이 값을 바꿔 달라고 요청한다. */
  readonly activeTabId: string | null;
  readonly viewport: { readonly preset: DesktopBrowserViewportPreset; readonly width: number; readonly height: number; readonly setBy: "user" | "agent" | null };
  /** 에이전트가 브라우저를 조작 중인가. */
  readonly driving: boolean;
  /** 이 브라우저가 쓰는 영속 프로필 id. `null` 이면 임시 세션이다. */
  readonly profile: string | null;
  /** 새 세션이 시작하는 프로필. */
  readonly defaultProfile: string | null;
  readonly available: boolean;
  /** 사용할 수 없는 까닭 — 공유 중이거나(shared) 이 Console 이 Desktop 을 쓰지 못할 때(desktop_required). */
  readonly reason: "desktop_required" | "shared" | null;
}

/** 셸 → 콘솔. 어느 필드든 비어 있을 수 있다. */
export interface DesktopBrowserRelay {
  readonly surface?: DesktopBrowserSurfaceRelay;
  /** 셸이 처음 붙을 때 한 번 — 이 셸의 Chromium 이 누구인지. */
  readonly hello?: { readonly product: string; readonly userAgent: string };
  readonly attached?: readonly string[];
  readonly detached?: readonly string[];
  /**
   * 뷰 **하나**의 실제 크기(DIP)와 화면 배율. parking·presented 모두, 생성 직후와 bounds 가 바뀔 때마다
   * 올린다. 다른 탭·활성 패널 자리와 섞지 않는다 — 캡처·입력은 요청한 `viewId` 의 이 값만 본다.
   */
  readonly sizes?: readonly { readonly viewId: string; readonly width: number; readonly height: number; readonly scale: number }[];
  readonly results?: readonly { readonly id: number; readonly result?: unknown; readonly error?: string }[];
  readonly events?: readonly { readonly viewId: string; readonly method: string; readonly params: Record<string, unknown> }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);

export function isDesktopBrowserView(value: unknown): value is DesktopBrowserView {
  return isRecord(value) && isSafeId(value.id) && typeof value.objectiveId === "string" && isSafeId(value.partition)
    && (value.profile === undefined || value.profile === null || (typeof value.profile === "string" && DESKTOP_BROWSER_PROFILE_ID.test(value.profile)))
    && typeof value.visible === "boolean" && typeof value.url === "string";
}

export function isDesktopBrowserCommand(value: unknown): value is DesktopBrowserCommand {
  return isRecord(value) && isFiniteNumber(value.id) && isSafeId(value.viewId) && typeof value.method === "string" && /^[A-Za-z]+\.[A-Za-z]+$/u.test(value.method) && isRecord(value.params);
}

export function isDesktopBrowserSnapshot(value: unknown): value is DesktopBrowserSnapshot {
  return isRecord(value) && isFiniteNumber(value.generation) && Array.isArray(value.views) && value.views.every(isDesktopBrowserView)
    && Array.isArray(value.commands) && value.commands.every(isDesktopBrowserCommand)
    && (value.shortcuts === undefined || (Array.isArray(value.shortcuts) && value.shortcuts.every((item) => typeof item === "string")))
    && (value.epoch === undefined || typeof value.epoch === "string")
    && (value.surface === undefined || value.surface === null || isDesktopBrowserSurface(value.surface))
    && (value.chrome === undefined || value.chrome === null || isDesktopBrowserChrome(value.chrome));
}

export function isDesktopBrowserSurface(value: unknown): value is DesktopBrowserSurface {
  return isRecord(value) && isSafeId(value.id) && isSafeId(value.browserId) && (value.mode === "pane" || value.mode === "window")
    && (value.focusRequest === undefined || (Number.isSafeInteger(value.focusRequest) && Number(value.focusRequest) >= 0));
}

const isShortText = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const isFaviconUrl = (value: unknown): value is string | null => value === null || (typeof value === "string" && value.length <= 65536 && /^(?:data:image\/[a-z0-9.+-]+[;,]|https?:)/iu.test(value));

export function isDesktopBrowserChrome(value: unknown): value is DesktopBrowserChrome {
  if (!isRecord(value) || !isSafeId(value.browserId) || !Array.isArray(value.spaces) || !Array.isArray(value.tabs) || value.tabs.length > 64 || value.spaces.length > 64) return false;
  const viewport = value.viewport;
  return value.spaces.every((space) => isRecord(space) && isSafeId(space.id) && (space.kind === "commodore" || space.kind === "default") && isShortText(space.label, 512)
      && typeof space.driving === "boolean" && Array.isArray(space.agentTabIds) && space.agentTabIds.every(isSafeId) && ["responsive", "mobile", "tablet"].includes(String(space.viewportPreset)))
    && value.tabs.every((tab) => isRecord(tab) && isSafeId(tab.id) && isSafeId(tab.spaceId) && isShortText(tab.url, 4096) && isShortText(tab.title, 1024) && isFaviconUrl(tab.favicon)
      && typeof tab.loading === "boolean" && typeof tab.canGoBack === "boolean" && typeof tab.canGoForward === "boolean"
      && (tab.dialog === undefined || (isRecord(tab.dialog) && (tab.dialog.type === "alert" || tab.dialog.type === "confirm") && isShortText(tab.dialog.message, 2000))))
    && (value.activeTabId === null || isSafeId(value.activeTabId))
    && isRecord(viewport) && ["responsive", "mobile", "tablet"].includes(String(viewport.preset)) && isFiniteNumber(viewport.width) && isFiniteNumber(viewport.height)
    && (viewport.setBy === null || viewport.setBy === "user" || viewport.setBy === "agent")
    && typeof value.driving === "boolean" && (value.profile === null || (typeof value.profile === "string" && DESKTOP_BROWSER_PROFILE_ID.test(value.profile)))
    && (value.defaultProfile === null || (typeof value.defaultProfile === "string" && DESKTOP_BROWSER_PROFILE_ID.test(value.defaultProfile)))
    && typeof value.available === "boolean" && (value.reason === null || value.reason === "desktop_required" || value.reason === "shared");
}

export function isDesktopBrowserRelay(value: unknown): value is DesktopBrowserRelay {
  if (!isRecord(value)) return false;
  if (value.surface !== undefined && !(isRecord(value.surface) && isSafeId(value.surface.id) && ["opened", "closed"].includes(String(value.surface.status)))) return false;
  if (value.hello !== undefined && !(isRecord(value.hello) && typeof value.hello.product === "string" && typeof value.hello.userAgent === "string")) return false;
  for (const key of ["attached", "detached"] as const) if (value[key] !== undefined && !(Array.isArray(value[key]) && (value[key] as unknown[]).every(isSafeId))) return false;
  if (value.sizes !== undefined && !(Array.isArray(value.sizes) && value.sizes.every((entry) => isRecord(entry) && isSafeId(entry.viewId) && isFiniteNumber(entry.width) && isFiniteNumber(entry.height) && isFiniteNumber(entry.scale)))) return false;
  if (value.results !== undefined && !(Array.isArray(value.results) && value.results.every((entry) => isRecord(entry) && isFiniteNumber(entry.id) && (entry.error === undefined || typeof entry.error === "string")))) return false;
  if (value.events !== undefined && !(Array.isArray(value.events) && value.events.every((entry) => isRecord(entry) && isSafeId(entry.viewId) && typeof entry.method === "string" && isRecord(entry.params)))) return false;
  return true;
}

/**
 * 화면공유가 실패한 뒤 미리보기가 읽는 화면 기록 사유.
 * Desktop이 macOS `denied` / `not-determined` / `restricted`를 이 코드 하나로 접어 보내고,
 * 그 외(허용·판독 실패·해당 없음·다른 플랫폼)는 null이다.
 * 창 제목·경로·오류 원문·OS 상태 문자열은 싣지 않는다.
 */
export const DESKTOP_SCREEN_PERMISSION_PATH = "/api/v1/desktop/screen-permission";
/**
 * 화면 기록 사유를 쓰는 Desktop 메인 프로세스의 User-Agent.
 * 렌더러는 이 헤더를 바꾸지 못하므로 페이지가 사유를 지어낼 수 없다. 비밀이 아니다.
 */
export const DESKTOP_SCREEN_PERMISSION_REPORT_AGENT = "FleetShell-ScreenPermission";
export const DESKTOP_SCREEN_PERMISSION_REASONS = ["screen_recording_permission_required"] as const;
export type DesktopScreenPermissionReason = (typeof DESKTOP_SCREEN_PERMISSION_REASONS)[number];
export interface DesktopScreenPermissionSnapshot {
  readonly reason: DesktopScreenPermissionReason | null;
}

export function isDesktopScreenPermissionSnapshot(value: unknown): value is DesktopScreenPermissionSnapshot {
  return isRecord(value) && Object.keys(value).length === 1
    && (value.reason === null || (typeof value.reason === "string" && (DESKTOP_SCREEN_PERMISSION_REASONS as readonly string[]).includes(value.reason)));
}

/**
 * 창이 자기를 든 셸에게 시키는 창 조작. 방향은 셸 갱신 명령과 같다(창 → Console → 그 창의 셸 SSE)
 * 이지만, 명령은 걸어 두지 않고 지금 붙어 있는 셸에만 흘린다 — 나중에 붙은 셸이 사용자가 잊은
 * 전체화면 전환을 수행하면 창이 저 혼자 커진다. 스냅샷 경로는 옛 Console을 가려내는 데만 쓰이고
 * 늘 빈 명령을 돌려준다.
 */
export const DESKTOP_WINDOW_COMMAND_PATH = "/api/v1/desktop/window/command";
export const DESKTOP_WINDOW_COMMAND_EVENTS_PATH = "/api/v1/desktop/window/command/events";
export const DESKTOP_WINDOW_COMMAND_EVENT = "desktop:window-command";
/**
 * `request-accessibility-permission`은 화면공유 창 식별이 손쉬운 사용 권한 부족으로 실패했을 때 사람이 미리보기에서 누른 요청이다.
 * TCC는 Console 자식(osascript)을 띄운 앱 — 창을 든 Desktop — 을 기준으로 판정하므로 그 앱이 묻는다.
 * `open-screen-recording-settings`는 화면 기록 권한이 없어 공유가 실패했을 때 사람이 누른 요청이다.
 * Desktop은 고정된 화면 기록 설정 주소만 열고, OS 권한 안내를 새로 띄우지 않는다. 모르는 옛 셸은 프레임을 버린다.
 *
 * `console-ready`는 명령이라기보다 알림이다 — 막 적재된 화면이 첫 데이터를 반영해 한 번 그렸다는 사실. 호스트를 갈아타는 셸은
 * 그때까지 옛 화면을 붙잡아 두었다가 걷는다. 걸어 두지 않는 채널이라 셸은 적재 *전에* 새 콘솔의 이 스트림을 연다.
 * 모르는 옛 셸은 프레임을 버리고, 이 명령을 모르는 옛 Console은 400으로 답하므로 셸은 상한 타이머로 걷는다.
 */
export const DESKTOP_WINDOW_COMMANDS = ["enter-fullscreen", "leave-fullscreen", "request-accessibility-permission", "open-screen-recording-settings", "console-ready"] as const;
export type DesktopWindowCommand = (typeof DESKTOP_WINDOW_COMMANDS)[number];
export interface DesktopWindowCommandSnapshot { readonly command: DesktopWindowCommand | null }

export function isDesktopWindowCommand(value: unknown): value is DesktopWindowCommand {
  return typeof value === "string" && (DESKTOP_WINDOW_COMMANDS as readonly string[]).includes(value);
}

export function isDesktopWindowCommandSnapshot(value: unknown): value is DesktopWindowCommandSnapshot {
  return isRecord(value) && Object.keys(value).length === 1 && (value.command === null || isDesktopWindowCommand(value.command));
}

export { readDesktopEntryFonts, type DesktopEntryFonts, type DesktopFontAxis } from "./fonts.js";
