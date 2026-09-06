import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import {
  createDurableJsonStore,
  type CreateDurableJsonStoreDeps,
  type DurableJsonStore,
} from "@dotobokuri/core-infra";

import type { ApiCatalogEntry } from "@fleet-console/sdk/plugin";
import { DEFAULT_EXPERIMENT_SETTINGS, isExperimentModelId, resolveExperimentSettings, type ConsoleExperimentSettings } from "@fleet-console/sdk/settings";
import type { GlobalSettingsMutationResult, GlobalSettingsState } from "../console-contract-types.js";
import { createConsoleDataPaths, type ConsoleDataPaths } from "../paths.js";

export type ConsoleThemeId = "instrument" | "maritime" | "carbon" | "whites";
export type ConsoleUiFontId = "manrope" | "jetbrains-mono" | "source-code-pro";
export type UiFontSettings =
  | { readonly source: "builtin"; readonly id: ConsoleUiFontId; readonly size: number }
  | { readonly source: "system"; readonly familyName: string; readonly size: number };

export const REMOTE_AUTO_PORT_MIN = 49152;
export const REMOTE_AUTO_PORT_MAX = 65535;
export const REMOTE_AUTO_PORT_ATTEMPTS = 12;

export interface RemotePortSetting {
  readonly mode: "auto" | "custom";
  readonly value: number;
}

export interface RemoteAccessAcknowledgment {
  readonly version: 1;
  readonly listenAddress: string;
  readonly listenPort: number;
  readonly advertisedHost: string;
  readonly advertisedPort: number;
}

export interface ConsoleRemoteAccessSettings {
  readonly enabled: boolean;
  readonly publicEndpointEnabled: boolean;
  readonly listenAddress: string;
  readonly advertisedHost: string;
  readonly listenPort: RemotePortSetting;
  readonly advertisedPort: RemotePortSetting;
  readonly acknowledgment: RemoteAccessAcknowledgment | null;
}

export interface RemoteAccessAdvertisedTuple {
  readonly host: string;
  readonly port: number;
}

export function effectiveRemoteAccessAdvertisedTuple(settings: ConsoleRemoteAccessSettings): RemoteAccessAdvertisedTuple {
  return settings.publicEndpointEnabled
    ? { host: settings.advertisedHost, port: settings.advertisedPort.value }
    : { host: settings.listenAddress, port: settings.listenPort.value };
}

export interface ConsoleGeneralSettings {
  readonly consolePortMode?: "dynamic" | "static";
  readonly consoleStaticPort?: number;
  readonly language?: "auto" | "en" | "ko";
  readonly remoteAccess?: ConsoleRemoteAccessSettings;
  readonly seenFeatureTours?: readonly string[];
  readonly theme?: ConsoleThemeId;
  /** 리퀴드 글래스 머티리얼 — 부재는 켜짐(기본 옵트인)이다. */
  readonly liquidGlass?: boolean;
  /**
   * 포커스하지 않은 패널의 본문이 물러나는 세기(백분율). 0은 물러나지 않음, 클수록 더 흐리다.
   * 부재는 기본값이며, 상한은 곁을 훑는 일이 끊기지 않는 선에서 정한다.
   */
  readonly unfocusedPanelFade?: number;
  readonly uiFont?: UiFontSettings;
  /**
   * 실험 기능과 모델 좌석. 부재는 전부 꺼짐이다 — 켜는 행위가 곧 동의이므로 기본값이 켜짐일 수 없다.
   * 형태와 정제기는 SDK가 소유한다(플러그인 서버·브라우저가 같은 규칙으로 읽는다).
   */
  readonly experiments?: ConsoleExperimentSettings;
}

/** 후퇴 세기의 허용 구간과 기본값 — 서버·클라이언트·화면이 같은 수를 본다. */
export const UNFOCUSED_PANEL_FADE_MIN = 0;
export const UNFOCUSED_PANEL_FADE_MAX = 70;
export const UNFOCUSED_PANEL_FADE_DEFAULT = 50;

export function isUnfocusedPanelFade(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= UNFOCUSED_PANEL_FADE_MIN && value <= UNFOCUSED_PANEL_FADE_MAX;
}

/** 바인드 주소는 IPv4 리터럴이거나 단순 호스트명만 허용한다. */
const REMOTE_BIND_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?)$/u;

export function sanitizeRemoteAccessSettings(value: unknown): ConsoleRemoteAccessSettings | undefined {
  if (!isRecord(value) || "bindHost" in value) return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  const listenAddress = value.listenAddress === "" ? "" : isValidRemoteBindHost(value.listenAddress) ? canonicalizeRemoteBindHost(value.listenAddress) : null;
  const advertisedHost = value.advertisedHost === "" ? "" : isValidRemoteAdvertisedHost(value.advertisedHost) ? canonicalizeRemoteBindHost(value.advertisedHost) : null;
  if (listenAddress === null || advertisedHost === null) return undefined;
  const listenPort = sanitizeRemotePortSetting(value.listenPort);
  const advertisedPort = sanitizeRemotePortSetting(value.advertisedPort);
  if (!listenPort || !advertisedPort) return undefined;
  const acknowledgment = sanitizeAcknowledgment(value.acknowledgment);
  const explicitPublicEndpointEnabled = typeof value.publicEndpointEnabled === "boolean" ? value.publicEndpointEnabled : null;
  if (explicitPublicEndpointEnabled === true && value.acknowledgment !== null && !acknowledgment) return undefined;
  const publicEndpointEnabled = explicitPublicEndpointEnabled
    ?? acknowledgmentMatches({ listenAddress, advertisedHost, listenPort, advertisedPort }, acknowledgment);
  if (value.enabled && (listenAddress === "" || (publicEndpointEnabled && (advertisedHost === "" || !acknowledgmentMatches({ listenAddress, advertisedHost, listenPort, advertisedPort }, acknowledgment))))) return undefined;
  return {
    enabled: value.enabled,
    publicEndpointEnabled,
    listenAddress,
    advertisedHost,
    listenPort,
    advertisedPort,
    acknowledgment: publicEndpointEnabled ? acknowledgment : null,
  };
}

/**
 * 원격 리스너는 루프백과 **같은 포트**를 다른 인터페이스에 바인드한다. 그래서 와일드카드는
 * 값으로 성립하지 않는다 — `0.0.0.0:<port>`는 이미 `127.0.0.1:<port>`가 잡고 있어 반드시
 * EADDRINUSE로 끝나고, 사용자는 "다른 프로그램이 쓰고 있다"는 오해를 사는 오류만 받는다.
 */
const UNUSABLE_REMOTE_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

/**
 * DNS 이름은 대소문자를 가리지 않지만 `validateHost`는 Host 헤더를 바이트로 비교하고, 브라우저와
 * Chromium은 URL 호스트명을 소문자로 정규화해 보낸다. 저장된 이름에 대문자가 남아 있으면 리스너와
 * 인증서는 멀쩡한데 모든 요청이 403이다 — 조인까지 포함해서. 그래서 경계에서 한 번 접어 둔다.
 */
function canonicalizeRemoteBindHost(value: string): string {
  return value.toLowerCase();
}

export function isValidRemoteBindHost(value: unknown): value is string {
  // 루프백은 원격 바인드가 아니다. 이 자리에 넣으면 원격 세션 규칙이 로컬 표면에 적용된다.
  return typeof value === "string" && REMOTE_BIND_HOST.test(value) && !UNUSABLE_REMOTE_BIND_HOSTS.has(value);
}

export interface ConsoleSettingsData {
  readonly version: 1;
  readonly general?: ConsoleGeneralSettings;
  readonly plugins?: Record<string, Record<string, unknown>>;
}

export interface CreateConsoleSettingsStoreDeps {
  readonly randomInt?: (min: number, max: number) => number;
  readonly readFile?: (file: string) => string;
  readonly paths?: ConsoleDataPaths;
  readonly createStore?: (deps: CreateDurableJsonStoreDeps<ConsoleSettingsData>) => DurableJsonStore<ConsoleSettingsData>;
  readonly now?: () => number;
}

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const UI_FONT_SIZE_RANGE = { min: 12, max: 18, step: 1 } as const;
const DEFAULT_UI_FONT_SETTINGS: UiFontSettings = { source: "builtin", id: "manrope", size: 14 };

const SETTINGS_VERSION = 1;
const SETTINGS_LOCK_DIR_NAME = "settings.lock";
const SETTINGS_LOCK_OWNER_FILE_NAME = "owner.json";
const SETTINGS_TEMP_PREFIX = ".settings.";
const MIN_CONSOLE_STATIC_PORT = 1024;
const MAX_CONSOLE_STATIC_PORT = 65535;
const MAX_SEEN_FEATURE_TOURS = 64;
const MAX_FEATURE_TOUR_KEY_LENGTH = 64;

export function createConsoleSettingsStore(deps: CreateConsoleSettingsStoreDeps = {}): DurableJsonStore<ConsoleSettingsData> {
  const paths = deps.paths ?? createConsoleDataPaths();
  const createStore = deps.createStore ?? createDurableJsonStore;
  const randomInt = deps.randomInt ?? crypto.randomInt;
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const base = createStore({
    filePath: paths.settingsFile,
    lockDir: path.join(paths.dir, SETTINGS_LOCK_DIR_NAME),
    lockOwnerFileName: SETTINGS_LOCK_OWNER_FILE_NAME,
    now: deps.now,
    sanitize: sanitizeConsoleSettingsData,
    sensitivity: "sensitive",
    tempCleanupPrefix: SETTINGS_TEMP_PREFIX,
  });
  let initialized = false;
  function initialize(): ConsoleSettingsData {
    if (initialized) return base.load();
    initialized = true;
    const current = base.load();
    const raw = readRawSettings(paths.settingsFile, readFile);
    const legacy = readLegacyRemoteAccess(raw, paths.dir, readFile, randomInt);
    const remoteAccess = current.general?.remoteAccess ?? legacy ?? createDefaultRemoteAccess(randomInt);
    const next = { ...current, general: { ...current.general, remoteAccess } };
    if (!current.general?.remoteAccess || legacy || currentRemoteAccessNeedsMigration(raw)) base.save(next);
    return next;
  }
  return {
    path: base.path,
    load: initialize,
    save(data) { initialized = true; base.save(data); },
    update(mutate) {
      // 감싼 저장소도 skip 판정을 그대로 전달한다 — 여기서 삼키면 "쓸 것이 없다"가 쓰기가 된다.
      const next = mutate(initialize());
      if (next !== undefined) base.save(next);
      return base.load();
    },
  };
}

export function sanitizeConsoleSettingsData(value: unknown): ConsoleSettingsData {
  if (!isRecord(value)) return emptyConsoleSettingsData();
  if (value.version !== SETTINGS_VERSION) return emptyConsoleSettingsData();
  const general = readConsoleGeneralSettings(value.general);
  const plugins = readConsolePluginSettings(value.plugins);
  return {
    version: SETTINGS_VERSION,
    general: general ?? {},
    plugins: plugins ?? {},
  };
}

export function emptyConsoleSettingsData(): ConsoleSettingsData {
  return { version: 1, general: {}, plugins: {} };
}

function sanitizeUiFontSettings(value: unknown): UiFontSettings | undefined {
  if (isConsoleUiFontId(value)) return { source: "builtin", id: value, size: DEFAULT_UI_FONT_SETTINGS.size };
  if (!isRecord(value) || !isValidUiFontSize(value.size)) return undefined;
  if (value.source === "builtin" && isConsoleUiFontId(value.id)) {
    return { source: "builtin", id: value.id, size: value.size };
  }
  if (value.source === "system" && typeof value.familyName === "string") {
    const familyName = sanitizeSystemFontFamily(value.familyName);
    return familyName ? { source: "system", familyName, size: value.size } : undefined;
  }
  return undefined;
}

export function sanitizeSeenFeatureTours(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_FEATURE_TOUR_KEY_LENGTH) continue;
    seen.add(item);
    if (seen.size === MAX_SEEN_FEATURE_TOURS) break;
  }
  return [...seen];
}

function isUiFontSettings(value: unknown): value is UiFontSettings {
  if (!isRecord(value) || !isValidUiFontSize(value.size)) return false;
  if (value.source === "builtin") return isConsoleUiFontId(value.id);
  return value.source === "system" && typeof value.familyName === "string" && value.familyName.length > 0 && value.familyName === sanitizeSystemFontFamily(value.familyName);
}

function readConsoleGeneralSettings(value: unknown): ConsoleGeneralSettings | null {
  if (!isRecord(value)) return null;
  const consolePortMode = value.consolePortMode === "dynamic" || value.consolePortMode === "static"
    ? value.consolePortMode
    : undefined;
  const consoleStaticPort = isValidConsoleStaticPort(value.consoleStaticPort)
    ? value.consoleStaticPort
    : undefined;
  const language = value.language === "auto" || value.language === "en" || value.language === "ko"
    ? value.language
    : undefined;
  const remoteAccess = sanitizeRemoteAccessSettings(value.remoteAccess);
  const seenFeatureTours = sanitizeSeenFeatureTours(value.seenFeatureTours);
  // 퇴역 라이트 테마(daywatch/drydock) 저장값은 whites로 무손실 폴백한다 — 라이트 사용자가
  // 업그레이드 직후 다크 기본값으로 떨어지는 극성 반전을 막는다.
  const theme = value.theme === "instrument" || value.theme === "maritime" || value.theme === "carbon"
    || value.theme === "whites"
    ? value.theme
    : value.theme === "daywatch" || value.theme === "drydock"
      ? "whites"
      : undefined;
  const uiFont = sanitizeUiFontSettings(value.uiFont);
  const liquidGlass = typeof value.liquidGlass === "boolean" ? value.liquidGlass : undefined;
  const unfocusedPanelFade = isUnfocusedPanelFade(value.unfocusedPanelFade) ? value.unfocusedPanelFade : undefined;
  const experiments = value.experiments !== undefined ? resolveExperimentSettings(value.experiments) : undefined;
  return {
    ...(consolePortMode !== undefined ? { consolePortMode } : {}),
    ...(consoleStaticPort !== undefined ? { consoleStaticPort } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(remoteAccess !== undefined ? { remoteAccess } : {}),
    ...(seenFeatureTours !== undefined ? { seenFeatureTours } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(liquidGlass !== undefined ? { liquidGlass } : {}),
    ...(unfocusedPanelFade !== undefined ? { unfocusedPanelFade } : {}),
    ...(uiFont !== undefined ? { uiFont } : {}),
    ...(experiments !== undefined ? { experiments } : {}),
  };
}

function readConsolePluginSettings(value: unknown): Record<string, Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PLUGIN_ID_PATTERN.test(key)) continue;
    if (!isRecord(entry)) continue;
    result[key] = entry;
  }
  return result;
}

/**
 * 공표 이름은 바인드하지 않지만, 루프백·와일드카드는 여기서도 값이 아니다 — 그 이름을 실은 링크를
 * 받은 기기는 자기 자신에게 향한다. 바인드와 같은 집합을 쓰지 않으면 정상 접속이 불가능한 설정을
 * 저장할 수 있고, 그때 실제 소켓은 다른 이름으로 여전히 열려 있어 상태가 어긋난다.
 */
function isValidRemoteAdvertisedHost(value: unknown): value is string {
  return isValidRemoteBindHost(value);
}

function sanitizeRemotePortSetting(value: unknown): RemotePortSetting | null {
  if (!isRecord(value) || (value.mode !== "auto" && value.mode !== "custom") || !isBindablePort(value.value)) return null;
  if (value.mode === "auto" && (value.value < REMOTE_AUTO_PORT_MIN || value.value > REMOTE_AUTO_PORT_MAX)) return null;
  return { mode: value.mode, value: value.value };
}

function sanitizeAcknowledgment(value: unknown): RemoteAccessAcknowledgment | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 1 || !isValidRemoteBindHost(value.listenAddress)
    || !isValidRemoteAdvertisedHost(value.advertisedHost) || !isBindablePort(value.listenPort) || !isBindablePort(value.advertisedPort)) return null;
  return { version: 1, listenAddress: canonicalizeRemoteBindHost(value.listenAddress), listenPort: value.listenPort, advertisedHost: canonicalizeRemoteBindHost(value.advertisedHost), advertisedPort: value.advertisedPort };
}

export function acknowledgmentMatches(settings: Pick<ConsoleRemoteAccessSettings, "listenAddress" | "listenPort" | "advertisedHost" | "advertisedPort">, acknowledgment: RemoteAccessAcknowledgment | null): boolean {
  return acknowledgment !== null && acknowledgment.version === 1
    && acknowledgment.listenAddress === settings.listenAddress && acknowledgment.listenPort === settings.listenPort.value
    && acknowledgment.advertisedHost === settings.advertisedHost && acknowledgment.advertisedPort === settings.advertisedPort.value;
}

function createDefaultRemoteAccess(randomInt: (min: number, max: number) => number): ConsoleRemoteAccessSettings {
  return { enabled: false, publicEndpointEnabled: false, listenAddress: "", advertisedHost: "", listenPort: { mode: "auto", value: randomAutoPort(randomInt) }, advertisedPort: { mode: "auto", value: randomAutoPort(randomInt) }, acknowledgment: null };
}

function randomAutoPort(randomInt: (min: number, max: number) => number): number {
  return randomInt(REMOTE_AUTO_PORT_MIN, REMOTE_AUTO_PORT_MAX + 1);
}

function isBindablePort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function readRawSettings(file: string, readFile: (file: string) => string): unknown {
  try { return JSON.parse(readFile(file)); } catch { return null; }
}

function currentRemoteAccessNeedsMigration(raw: unknown): boolean {
  return isRecord(raw) && raw.version === 1 && isRecord(raw.general) && isRecord(raw.general.remoteAccess)
    && !("bindHost" in raw.general.remoteAccess) && typeof raw.general.remoteAccess.publicEndpointEnabled !== "boolean";
}

function readLegacyRemoteAccess(raw: unknown, consoleDir: string, readFile: (file: string) => string, randomInt: (min: number, max: number) => number): ConsoleRemoteAccessSettings | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.general) || !isRecord(raw.general.remoteAccess)) return null;
  const legacy = raw.general.remoteAccess;
  if (!isValidRemoteBindHost(legacy.bindHost)) return null;
  const host = canonicalizeRemoteBindHost(legacy.bindHost);
  let port: number | null = null;
  try {
    const endpoint = JSON.parse(readFile(path.join(consoleDir, "remote", "listener.json"))) as unknown;
    if (isRecord(endpoint) && endpoint.version === 1 && isBindablePort(endpoint.port)) port = endpoint.port;
  } catch {}
  const listenPort: RemotePortSetting = port === null ? { mode: "auto", value: randomAutoPort(randomInt) } : { mode: "custom", value: port };
  const advertisedPort: RemotePortSetting = port === null ? { mode: "auto", value: randomAutoPort(randomInt) } : { mode: "custom", value: port };
  return { enabled: legacy.enabled === true, publicEndpointEnabled: false, listenAddress: host, advertisedHost: host, listenPort, advertisedPort, acknowledgment: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidConsoleStaticPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_CONSOLE_STATIC_PORT && value <= MAX_CONSOLE_STATIC_PORT;
}

function isConsoleUiFontId(value: unknown): value is ConsoleUiFontId {
  return value === "manrope" || value === "jetbrains-mono" || value === "source-code-pro";
}

function isValidUiFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= UI_FONT_SIZE_RANGE.min && value <= UI_FONT_SIZE_RANGE.max;
}

function sanitizeSystemFontFamily(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, 128);
}

export interface RemoteAccessSettingsChange {
  readonly previous: ConsoleRemoteAccessSettings;
  readonly next: ConsoleRemoteAccessSettings;
}

interface GlobalSettingsRouteDeps {
  readonly consoleSettingsStore: DurableJsonStore<ConsoleSettingsData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  /**
   * 원격 리스너 자신의 설정은 소유자 것이다. 신원 회전과 기기 해제가 루프백 전용인데 여기가
   * 열려 있으면, 공표 튜플을 바꾸는 것만으로 같은 결과(전 기기 페어링 해제)에 도달한다.
   */
  readonly isRemoteAccessOwner?: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
  readonly onThemeChanged?: (theme: ConsoleThemeId) => void;
  /**
   * 저장 직후 살아 있는 리스너를 설정에 맞춘다 — 켜자마자 링크를 만들 수 있어야 한다.
   * 전환이 끝나기 전에 응답하면 저장 직후의 상태 조회가 항상 "꺼짐"을 읽는다.
   */
  readonly onRemoteAccessChanged?: (change: RemoteAccessSettingsChange) => void | Promise<void>;
}

interface GlobalSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

interface GlobalSettingsBody {
  readonly consolePortMode?: unknown;
  readonly consoleStaticPort?: unknown;
  readonly language?: unknown;
  readonly remoteAccess?: unknown;
  readonly seenFeatureTours?: unknown;
  readonly theme?: unknown;
  readonly liquidGlass?: unknown;
  readonly unfocusedPanelFade?: unknown;
  readonly uiFont?: unknown;
  readonly experiments?: unknown;
}

const GLOBAL_SETTINGS_MIN_STATIC_PORT = 1024;
const GLOBAL_SETTINGS_MAX_STATIC_PORT = 65535;

export const GLOBAL_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/settings/global",
    summary: "Get the global console settings status.",
    category: "Settings",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "PUT",
    path: "/api/v1/settings/global",
    summary: "Save the global console settings.",
    category: "Settings",
    gate: "origin-write",
    transport: "http",
  },
];

export function createGlobalSettingsRouter(deps: GlobalSettingsRouteDeps): (context: GlobalSettingsRouteContext) => Promise<boolean> {
  return async function handleGlobalSettingsRoute(context: GlobalSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (pathname === "/api/v1/settings/global") {
      if (req.method === "GET") {
        deps.writeJson(res, 200, withRemoteAccessVisibility(buildGlobalSettingsState(deps.consoleSettingsStore), req, deps));
        return true;
      }
      if (req.method === "PUT") {
        await mutateGlobalSettings(req, res, deps);
        return true;
      }
      deps.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    return false;
  };
}

function buildGlobalSettingsState(store: DurableJsonStore<ConsoleSettingsData>): GlobalSettingsState {
  return toGlobalSettingsState(store.load());
}

async function mutateGlobalSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: GlobalSettingsRouteDeps,
): Promise<void> {
  if (!deps.isAuthorized(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  if (!isGlobalSettingsJsonRequest(req)) {
    deps.writeJson(res, 415, { error: "unsupported_media_type" });
    return;
  }
  const body = await deps.readJsonBody<GlobalSettingsBody>(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    deps.writeJson(res, 400, { error: "invalid_json" });
    return;
  }
  if (body.consolePortMode !== undefined && body.consolePortMode !== "dynamic" && body.consolePortMode !== "static") {
    deps.writeJson(res, 400, { error: "invalid_console_port_mode" });
    return;
  }
  if (body.consoleStaticPort !== undefined && body.consoleStaticPort !== null && !isValidGlobalStaticPortInput(body.consoleStaticPort)) {
    deps.writeJson(res, 400, { error: "invalid_console_static_port" });
    return;
  }
  if (body.language !== undefined && body.language !== "auto" && body.language !== "en" && body.language !== "ko") {
    deps.writeJson(res, 400, { error: "invalid_language" });
    return;
  }
  if (body.remoteAccess !== undefined && deps.isRemoteAccessOwner !== undefined && !deps.isRemoteAccessOwner(req)) {
    deps.writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  // 읽기가 쓰기보다 느슨하면 GET 정규형을 그대로 PUT으로 돌려보낼 때 섹션 저장이 통째로 잠긴다.
  if (body.remoteAccess !== undefined && !isValidRemoteAccessInput(body.remoteAccess)) {
    deps.writeJson(res, 400, { error: "invalid_remote_access" });
    return;
  }
  if (body.seenFeatureTours !== undefined && !isSeenFeatureToursInput(body.seenFeatureTours)) {
    deps.writeJson(res, 400, { error: "invalid_seen_feature_tours" });
    return;
  }
  if (
    body.theme !== undefined
    && body.theme !== "instrument" && body.theme !== "maritime" && body.theme !== "carbon"
    && body.theme !== "whites"
  ) {
    deps.writeJson(res, 400, { error: "invalid_theme" });
    return;
  }
  if (body.liquidGlass !== undefined && typeof body.liquidGlass !== "boolean") {
    deps.writeJson(res, 400, { error: "invalid_liquid_glass" });
    return;
  }
  if (body.unfocusedPanelFade !== undefined && !isUnfocusedPanelFade(body.unfocusedPanelFade)) {
    deps.writeJson(res, 400, { error: "invalid_unfocused_panel_fade" });
    return;
  }
  if (!isUiFontSettingsOrUndefined(body.uiFont)) {
    deps.writeJson(res, 400, { error: "invalid_ui_font" });
    return;
  }
  if (body.experiments !== undefined && !isExperimentSettingsInput(body.experiments)) {
    deps.writeJson(res, 400, { error: "invalid_experiments" });
    return;
  }
  const theme = body.theme === "instrument" || body.theme === "maritime" || body.theme === "carbon"
    || body.theme === "whites"
    ? body.theme
    : undefined;
  const beforeUpdate = deps.consoleSettingsStore.load();
  const previousRemoteAccess = beforeUpdate.general?.remoteAccess ?? createDefaultRemoteAccess(crypto.randomInt);
  const nextRemoteAccess = body.remoteAccess !== undefined ? normalizeRemoteAccessInput(body.remoteAccess) : previousRemoteAccess;
  const updated = deps.consoleSettingsStore.update((current) => ({
    ...current,
    version: 1,
    general: {
      ...current.general,
      ...(body.consolePortMode === "dynamic" || body.consolePortMode === "static" ? { consolePortMode: body.consolePortMode } : {}),
      ...(isValidGlobalStaticPortInput(body.consoleStaticPort) ? { consoleStaticPort: body.consoleStaticPort } : {}),
      ...(body.language === "auto" || body.language === "en" || body.language === "ko" ? { language: body.language } : {}),
      ...(body.remoteAccess !== undefined ? { remoteAccess: nextRemoteAccess } : {}),
      ...(body.seenFeatureTours !== undefined ? { seenFeatureTours: sanitizeSeenFeatureTours(body.seenFeatureTours) ?? [] } : {}),
      ...(theme !== undefined ? { theme } : {}),
      ...(typeof body.liquidGlass === "boolean" ? { liquidGlass: body.liquidGlass } : {}),
      ...(isUnfocusedPanelFade(body.unfocusedPanelFade) ? { unfocusedPanelFade: body.unfocusedPanelFade } : {}),
      ...(isUiFontSettings(body.uiFont) ? { uiFont: body.uiFont } : {}),
      ...(body.experiments !== undefined ? { experiments: resolveExperimentSettings(body.experiments) } : {}),
    },
    plugins: current.plugins,
  }));
  if (theme !== undefined) deps.onThemeChanged?.(theme);
  if (body.remoteAccess !== undefined) await deps.onRemoteAccessChanged?.({ previous: previousRemoteAccess, next: nextRemoteAccess });
  /**
   * 응답은 조정이 끝난 뒤의 저장값으로 짓는다. Auto 대체 포트를 고르는 경로는 이 콜백 안에서
   * 설정을 다시 쓰므로, 호출 전 스냅샷을 돌려주면 화면이 낡은 tuple을 기준선으로 삼고 다음 저장에
   * 그 값을 되돌려 쓴다.
   */
  const response: GlobalSettingsMutationResult = { state: withRemoteAccessVisibility(buildGlobalSettingsState(deps.consoleSettingsStore), req, deps) };
  deps.writeJson(res, 200, response);
}

function isValidRemoteAccessInput(value: unknown): boolean {
  if (!isRecord(value) || "bindHost" in value || typeof value.enabled !== "boolean" || typeof value.publicEndpointEnabled !== "boolean") return false;
  const validListenAddress = value.listenAddress === "" || isValidRemoteBindHost(value.listenAddress);
  const validAdvertisedHost = value.advertisedHost === "" || isValidRemoteAdvertisedHost(value.advertisedHost);
  if (!validListenAddress || !validAdvertisedHost) return false;
  const listenPort = sanitizeRemotePortSetting(value.listenPort);
  const advertisedPort = sanitizeRemotePortSetting(value.advertisedPort);
  if (!listenPort || !advertisedPort) return false;
  const acknowledgment = sanitizeAcknowledgment(value.acknowledgment);
  if (value.acknowledgment !== null && !acknowledgment) return false;
  if (value.publicEndpointEnabled !== true) return value.acknowledgment === null && (value.enabled !== true || value.listenAddress !== "");
  if (value.enabled !== true) return true;
  return value.listenAddress !== "" && value.advertisedHost !== ""
    && acknowledgmentMatches({ listenAddress: value.listenAddress as string, advertisedHost: value.advertisedHost as string, listenPort, advertisedPort }, acknowledgment);
}

function normalizeRemoteAccessInput(value: unknown): ConsoleRemoteAccessSettings {
  const record = value as Record<string, unknown>;
  const publicEndpointEnabled = record.publicEndpointEnabled === true;
  return {
    enabled: record.enabled === true,
    publicEndpointEnabled,
    listenAddress: record.listenAddress === "" ? "" : canonicalizeRemoteBindHost(record.listenAddress as string),
    advertisedHost: record.advertisedHost === "" ? "" : canonicalizeRemoteBindHost(record.advertisedHost as string),
    listenPort: sanitizeRemotePortSetting(record.listenPort)!,
    advertisedPort: sanitizeRemotePortSetting(record.advertisedPort)!,
    acknowledgment: publicEndpointEnabled ? sanitizeAcknowledgment(record.acknowledgment) : null,
  };
}

/**
 * 원격 세션에는 이 섹션이 아예 없다. 값을 비워 보내면 화면이 거짓을 그리고, 그대로 보내면
 * 손님이 이 기계의 LAN 주소를 읽는다 — 관리 라우트를 루프백에 둔 것과 같은 이유다.
 * 부재가 곧 "여기서는 다루지 않는다"는 뜻이고, 화면은 그때 섹션을 세우지 않는다.
 */
function withRemoteAccessVisibility(state: GlobalSettingsState, req: http.IncomingMessage, deps: GlobalSettingsRouteDeps): GlobalSettingsState {
  if (deps.isRemoteAccessOwner === undefined || deps.isRemoteAccessOwner(req)) return state;
  const { remoteAccess: _hidden, ...rest } = state;
  return rest as GlobalSettingsState;
}

function toGlobalSettingsState(data: ConsoleSettingsData): GlobalSettingsState {
  const general = data.general ?? {};
  return {
    consolePortMode: general.consolePortMode ?? "dynamic",
    consoleStaticPort: general.consoleStaticPort ?? null,
    language: general.language ?? "auto",
    remoteAccess: general.remoteAccess ?? createDefaultRemoteAccess(crypto.randomInt),
    seenFeatureTours: general.seenFeatureTours ?? [],
    theme: general.theme ?? "instrument",
    liquidGlass: general.liquidGlass ?? true,
    unfocusedPanelFade: general.unfocusedPanelFade ?? UNFOCUSED_PANEL_FADE_DEFAULT,
    uiFont: general.uiFont ?? DEFAULT_UI_FONT_SETTINGS,
    experiments: general.experiments ?? DEFAULT_EXPERIMENT_SETTINGS,
  };
}

/** 저장된 실험 설정 — 플러그인 호스트 능력이 매 요청마다 읽는다. */
export function readExperimentSettings(store: DurableJsonStore<ConsoleSettingsData>): ConsoleExperimentSettings {
  return store.load().general?.experiments ?? DEFAULT_EXPERIMENT_SETTINGS;
}

/**
 * 쓰기는 읽기보다 엄격하다. 정제기는 알 수 없는 값을 기본값으로 접지만, 요청이 잘못된 모델 id를
 * 실어 보냈다면 그것은 400이지 조용한 기본값 대체가 아니다 — 화면이 저장됐다고 믿는 값과 저장된
 * 값이 갈라지면 안 된다.
 */
function isExperimentSettingsInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ["promptRefine", "launchContextPack", "sessionWatch", "aideConsoleRead"]) {
    if (key in value && typeof value[key] !== "boolean") return false;
  }
  for (const key of ["promptRefineModel", "sessionWatchModel"]) {
    if (key in value && !isExperimentModelId(value[key])) return false;
  }
  return true;
}

function isGlobalSettingsJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}

function isValidGlobalStaticPortInput(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= GLOBAL_SETTINGS_MIN_STATIC_PORT && value <= GLOBAL_SETTINGS_MAX_STATIC_PORT;
}

function isUiFontSettingsOrUndefined(value: unknown): boolean {
  return value === undefined || isUiFontSettings(value);
}

function isSeenFeatureToursInput(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every((item) => typeof item === "string" && item.length <= 64);
}

interface PluginSettingsRouteDeps {
  readonly consoleSettingsStore: DurableJsonStore<ConsoleSettingsData>;
  readonly isAuthorized: (req: http.IncomingMessage) => boolean;
  readonly readJsonBody: <T>(req: http.IncomingMessage) => Promise<T | null>;
  readonly writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface PluginSettingsRouteContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly pathname: string;
}

const PLUGIN_SETTINGS_PREFIX = "/api/v1/settings/plugins/";
const MAX_PLUGIN_SETTINGS_BYTES = 32 * 1024;

export const PLUGIN_SETTINGS_API_CATALOG: readonly ApiCatalogEntry[] = [
  {
    method: "GET",
    path: "/api/v1/settings/plugins/:pluginId",
    summary: "Get the settings for a specific plugin.",
    category: "Settings",
    gate: "loopback",
    transport: "http",
  },
  {
    method: "PUT",
    path: "/api/v1/settings/plugins/:pluginId",
    summary: "Save the settings for a specific plugin.",
    category: "Settings",
    gate: "origin-write",
    transport: "http",
  },
];

export function createPluginSettingsRouter(deps: PluginSettingsRouteDeps): (context: PluginSettingsRouteContext) => Promise<boolean> {
  return async function handlePluginSettingsRoute(context: PluginSettingsRouteContext): Promise<boolean> {
    const { req, res, pathname } = context;
    if (!pathname.startsWith(PLUGIN_SETTINGS_PREFIX)) return false;
    const rest = pathname.slice(PLUGIN_SETTINGS_PREFIX.length);
    if (rest.includes("/")) return false;
    let pluginId: string;
    try {
      pluginId = decodeURIComponent(rest);
    } catch {
      deps.writeJson(res, 400, { error: "invalid_plugin_id" });
      return true;
    }
    if (!PLUGIN_ID_PATTERN.test(pluginId)) {
      deps.writeJson(res, 400, { error: "invalid_plugin_id" });
      return true;
    }
    if (req.method === "GET") {
      const data = deps.consoleSettingsStore.load();
      const value = data.plugins?.[pluginId] ?? null;
      deps.writeJson(res, 200, { value });
      return true;
    }
    if (req.method === "PUT") {
      if (!deps.isAuthorized(req)) {
        deps.writeJson(res, 401, { error: "unauthorized" });
        return true;
      }
      if (!isPluginSettingsJsonRequest(req)) {
        deps.writeJson(res, 415, { error: "unsupported_media_type" });
        return true;
      }
      const body = await deps.readJsonBody<unknown>(req);
      if (!isRecord(body)) {
        deps.writeJson(res, 400, { error: "invalid_json" });
        return true;
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_PLUGIN_SETTINGS_BYTES) {
        deps.writeJson(res, 413, { error: "payload_too_large" });
        return true;
      }
      const updated = deps.consoleSettingsStore.update((current) => ({
        ...current,
        version: 1,
        plugins: { ...current.plugins, [pluginId]: body as Record<string, unknown> },
      }));
      deps.writeJson(res, 200, { value: updated.plugins?.[pluginId] ?? null });
      return true;
    }
    deps.writeJson(res, 405, { error: "Method not allowed" });
    return true;
  };
}


function isPluginSettingsJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().split(";")[0]?.trim() === "application/json";
}
