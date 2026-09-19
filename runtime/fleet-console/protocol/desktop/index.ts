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

const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_SETTINGS_FILE_NAME = "settings.json";
const CONSOLE_CAPTURES_DIR_NAME = "captures";

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

// ---------- Operation Browser 네이티브 뷰 ----------
//
// 창을 든 셸이 Operation 브라우저의 탭을 자기 창 안의 실제 Chromium 뷰로 그린다. 사람은 그 뷰를 직접 보고
// 만지며, 픽셀을 찍어 보내는 일이 없다. 방향은 셸의 다른 동기화와 같다 — 셸이 콘솔의 스냅샷을 구독하고,
// 그 결과(CDP 응답·이벤트·뷰 크기)를 relay 로 되돌려 보낸다. 브라우저 정책·탭 상태·도구는 콘솔이 소유한다.

export const DESKTOP_BROWSER_PATH = "/api/v1/desktop/browser";
export const DESKTOP_BROWSER_EVENTS_PATH = "/api/v1/desktop/browser/events";
export const DESKTOP_BROWSER_RELAY_PATH = "/api/v1/desktop/browser/relay";
export const DESKTOP_BROWSER_EVENT = "desktop:browser";

export interface DesktopBrowserBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** 셸이 띄워야 하는 뷰 하나. `bounds` 가 없거나 `visible` 이 false 면 만들어 두되 보이지 않는다. */
export interface DesktopBrowserView {
  readonly id: string;
  readonly operationId: string;
  /** Electron 세션 파티션 — Operation 마다 다르며 앱 수명 동안만 산다. */
  readonly partition: string;
  /**
   * 영속 브라우저 프로필의 id. `null` 이면 이 뷰는 위 `partition` 의 메모리 세션에 산다.
   * 값이 있으면 셸이 자기 데이터 루트 아래에서 경로를 만들어 디스크 세션을 연다 — 콘솔은 경로를 보내지 않는다.
   * 옛 셸은 이 필드를 모르고 `partition` 만 읽으므로 임시 세션으로 떨어진다.
   */
  readonly profile: string | null;
  readonly visible: boolean;
  /** 콘솔 창의 CSS px 좌표. 셸이 창의 줌 배율을 곱해 DIP 로 놓는다. */
  readonly bounds: DesktopBrowserBounds | null;
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
}

/** 셸 → 콘솔. 어느 필드든 비어 있을 수 있다. */
export interface DesktopBrowserRelay {
  /** 셸이 처음 붙을 때 한 번 — 이 셸의 Chromium 이 누구인지. */
  readonly hello?: { readonly product: string; readonly userAgent: string };
  readonly attached?: readonly string[];
  readonly detached?: readonly string[];
  /** 뷰의 실제 크기(DIP)와 화면 배율. bounds 를 놓을 때마다 알린다. */
  readonly sizes?: readonly { readonly viewId: string; readonly width: number; readonly height: number; readonly scale: number }[];
  readonly results?: readonly { readonly id: number; readonly result?: unknown; readonly error?: string }[];
  readonly events?: readonly { readonly viewId: string; readonly method: string; readonly params: Record<string, unknown> }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);

export function isDesktopBrowserBounds(value: unknown): value is DesktopBrowserBounds {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.width) && isFiniteNumber(value.height) && value.width >= 0 && value.height >= 0;
}

export function isDesktopBrowserView(value: unknown): value is DesktopBrowserView {
  return isRecord(value) && isSafeId(value.id) && typeof value.operationId === "string" && isSafeId(value.partition)
    && (value.profile === null || (typeof value.profile === "string" && DESKTOP_BROWSER_PROFILE_ID.test(value.profile)))
    && typeof value.visible === "boolean" && (value.bounds === null || isDesktopBrowserBounds(value.bounds)) && typeof value.url === "string";
}

export function isDesktopBrowserCommand(value: unknown): value is DesktopBrowserCommand {
  return isRecord(value) && isFiniteNumber(value.id) && isSafeId(value.viewId) && typeof value.method === "string" && /^[A-Za-z]+\.[A-Za-z]+$/u.test(value.method) && isRecord(value.params);
}

export function isDesktopBrowserSnapshot(value: unknown): value is DesktopBrowserSnapshot {
  return isRecord(value) && isFiniteNumber(value.generation) && Array.isArray(value.views) && value.views.every(isDesktopBrowserView)
    && Array.isArray(value.commands) && value.commands.every(isDesktopBrowserCommand);
}

export function isDesktopBrowserRelay(value: unknown): value is DesktopBrowserRelay {
  if (!isRecord(value)) return false;
  if (value.hello !== undefined && !(isRecord(value.hello) && typeof value.hello.product === "string" && typeof value.hello.userAgent === "string")) return false;
  for (const key of ["attached", "detached"] as const) if (value[key] !== undefined && !(Array.isArray(value[key]) && (value[key] as unknown[]).every(isSafeId))) return false;
  if (value.sizes !== undefined && !(Array.isArray(value.sizes) && value.sizes.every((entry) => isRecord(entry) && isSafeId(entry.viewId) && isFiniteNumber(entry.width) && isFiniteNumber(entry.height) && isFiniteNumber(entry.scale)))) return false;
  if (value.results !== undefined && !(Array.isArray(value.results) && value.results.every((entry) => isRecord(entry) && isFiniteNumber(entry.id) && (entry.error === undefined || typeof entry.error === "string")))) return false;
  if (value.events !== undefined && !(Array.isArray(value.events) && value.events.every((entry) => isRecord(entry) && isSafeId(entry.viewId) && typeof entry.method === "string" && isRecord(entry.params)))) return false;
  return true;
}
