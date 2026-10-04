import { useSyncExternalStore } from "react";
import type { MobileScheme } from "@fleet-console/sdk/settings/mobile-scheme";

/*
 * 모바일 겉모습(색상 모드·글자 배율) — 기기 단위 모바일 선호다. Console 서버 설정
 * (general.theme·general.fonts)과는 별개이며 이 모듈은 그것들을 절대 쓰지 않는다.
 *
 * 소유자는 둘 중 하나다(브리지 계약 v1, shared/bridge-contract.md):
 * - Fleet Mobile 앱: 네이티브가 저장·소유하고 문서 시작에 `window.__fleetMobileAppearance`를 심는다.
 *   웹에서 바꾸면 main frame·로컬 오리진 게이트를 지나는 `fleetAppearance` 메시지로 알리고,
 *   네이티브가 저장한 뒤 같은 전역+이벤트로 확정해 준다. 이때 웹은 localStorage에 쓰지 않는다.
 * - 브라우저: localStorage에 저장하고 "시스템"은 prefers-color-scheme을 실시간으로 따른다.
 *
 * 결과는 루트 속성 두 개(data-mobile-scheme·data-mobile-font-scale)로만 나간다 — theme.css 모바일
 * 블록과 SDK `readMobileScheme()` 소비자가 그것을 읽는다. 첫 페인트의 같은 판정은
 * public/theme-boot.js가 하며 키·전역 이름·화이트리스트를 이 파일과 수동 동기화한다.
 */

export type MobileColorMode = "system" | "dark" | "light";
export type MobileFontScale = "small" | "default" | "large";
/** `scrim`은 브리지 v1.5 — 지금 모드의 bg 위에 스크림을 합성한 면. 앱이 `chrome.scrim`으로 알린 때만 보낸다. */
export type MobileChromeTop = "bg" | "bg-deep" | "scrim";
export type MobileChromeBottom = "bg" | "bg-deep" | "surface" | "scrim";

export type MobileIdentityTone = "crimson" | "amber" | "moss" | "teal" | "cerulean" | "indigo" | "plum" | "rose";

/** 앱이 알려 주는 "지금 연결된 이 Console" 표시값(v1.1) — 다른 Console 정보는 웹에 오지 않는다. */
export type MobileConsoleIdentity = {
  readonly label: string;
  readonly monogram: string | null;
  readonly tone: MobileIdentityTone | null;
  /** v1.3 — 앱이 아는 이 Console의 주소(표시용). 없으면 주소 줄을 숨긴다(루프백 주소를 대신 보이지 않는다). */
  readonly address: string | null;
};

export type MobileAppearanceSnapshot = {
  readonly colorMode: MobileColorMode;
  readonly fontScale: MobileFontScale;
  /** 지금 칠하는 극성 — "시스템"이면 OS 외관을 푼 값. */
  readonly scheme: MobileScheme;
  /** 앱(네이티브)이 값을 소유하는가. true면 브라우저 저장소를 쓰지 않는다. */
  readonly nativeOwned: boolean;
  /** 앱이 넘긴 지금 Console 표시값. 브라우저·구버전 셸이면 null. */
  readonly console: MobileConsoleIdentity | null;
  /** v1.4 — 앱(Fleet 앱)의 버전 문자열. 브라우저·구버전 셸이면 null. */
  readonly appVersion: string | null;
  /** v1.5 — 앱이 chrome 신호의 `scrim` 토큰을 아는가. 아니면(구버전 셸·브라우저) 웹은 `bg-deep`으로 대신한다. */
  readonly chromeScrim: boolean;
};

const COLOR_MODE_KEY = "fleet-console.mobile-color-mode";
const FONT_SCALE_KEY = "fleet-console.mobile-font-scale";
const NATIVE_GLOBAL = "__fleetMobileAppearance";
const NATIVE_EVENT = "fleet-mobile-appearance";
const NATIVE_HANDLER = "fleetAppearance";

type NativeAppearance = {
  readonly colorMode: MobileColorMode;
  readonly systemScheme: MobileScheme;
  readonly fontScale: MobileFontScale;
  readonly console: MobileConsoleIdentity | null;
  readonly appVersion: string | null;
  readonly chromeScrim: boolean;
};

const IDENTITY_TONES: ReadonlySet<string> = new Set(["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"]);
const CONSOLE_LABEL_MAX = 64;
const CONSOLE_MONOGRAM_MAX = 3;
const CONSOLE_ADDRESS_MAX = 120;

type NativeMessageTarget = { postMessage(body: string): void };

const listeners = new Set<() => void>();
let systemQuery: MediaQueryList | null = null;
let installed = false;
let lastChrome = "";
let snapshot: MobileAppearanceSnapshot = initialSnapshot();

function isColorMode(value: unknown): value is MobileColorMode {
  return value === "system" || value === "dark" || value === "light";
}

function isFontScale(value: unknown): value is MobileFontScale {
  return value === "small" || value === "default" || value === "large";
}

function isScheme(value: unknown): value is MobileScheme {
  return value === "dark" || value === "light";
}

/** 네이티브가 넘긴 값 — 화이트리스트 밖이면 없는 것으로 본다(구버전·위조 전역 모두 브라우저 모드로). */
function parseNativeAppearance(value: unknown): NativeAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || !isColorMode(record.colorMode) || !isScheme(record.systemScheme) || !isFontScale(record.fontScale)) return null;
  return { colorMode: record.colorMode, systemScheme: record.systemScheme, fontScale: record.fontScale, console: parseConsoleIdentity(record.console), appVersion: parseAppVersion(record.app), chromeScrim: parseChromeScrim(record.chrome) };
}

/** v1.5 선택 필드 — `chrome: { scrim: true }`일 때만 참. 그 밖의 모양은 모르는 앱으로 본다. */
function parseChromeScrim(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).scrim === true;
}

/** v1.4 선택 필드 — 앱 버전 문자열(최대 64자). 없거나 틀리면 줄을 그리지 않는다. */
function parseAppVersion(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "string" && version.trim().length > 0 && version.trim().length <= 64 ? version.trim() : null;
}

/** v1.1 선택 필드 — 없거나 틀리면 표시값만 비우고 겉모습 값은 그대로 쓴다(v1 셸 호환). */
function parseConsoleIdentity(value: unknown): MobileConsoleIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  if (!label || label.length > CONSOLE_LABEL_MAX) return null;
  const monogram = typeof record.monogram === "string" && record.monogram.trim().length > 0 && [...record.monogram.trim()].length <= CONSOLE_MONOGRAM_MAX
    ? record.monogram.trim()
    : null;
  const tone = typeof record.tone === "string" && IDENTITY_TONES.has(record.tone) ? record.tone as MobileIdentityTone : null;
  const address = typeof record.address === "string" && record.address.trim().length > 0 && record.address.trim().length <= CONSOLE_ADDRESS_MAX
    ? record.address.trim()
    : null;
  return { label, monogram, tone, address };
}

function readNativeAppearance(): NativeAppearance | null {
  if (typeof window === "undefined") return null;
  return parseNativeAppearance((window as unknown as Record<string, unknown>)[NATIVE_GLOBAL]);
}

function readStored<T>(key: string, guard: (value: unknown) => value is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return guard(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 저장소가 막힌 환경에서는 이 세션만 바뀐다. */ }
}

function systemScheme(): MobileScheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveScheme(colorMode: MobileColorMode, system: MobileScheme): MobileScheme {
  return colorMode === "system" ? system : colorMode;
}

function fromNative(native: NativeAppearance): MobileAppearanceSnapshot {
  return { colorMode: native.colorMode, fontScale: native.fontScale, scheme: resolveScheme(native.colorMode, native.systemScheme), nativeOwned: true, console: native.console, appVersion: native.appVersion, chromeScrim: native.chromeScrim };
}

function initialSnapshot(): MobileAppearanceSnapshot {
  const native = readNativeAppearance();
  if (native) return fromNative(native);
  const colorMode = readStored(COLOR_MODE_KEY, isColorMode, "system");
  return { colorMode, fontScale: readStored(FONT_SCALE_KEY, isFontScale, "default"), scheme: resolveScheme(colorMode, systemScheme()), nativeOwned: false, console: null, appVersion: null, chromeScrim: false };
}

function applyToDocument(next: MobileAppearanceSnapshot): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-mobile-scheme", next.scheme);
  root.setAttribute("data-mobile-font-scale", next.fontScale);
}

function setSnapshot(next: MobileAppearanceSnapshot): void {
  const same = next.colorMode === snapshot.colorMode && next.fontScale === snapshot.fontScale
    && next.scheme === snapshot.scheme && next.nativeOwned === snapshot.nativeOwned
    && next.console?.label === snapshot.console?.label && next.console?.monogram === snapshot.console?.monogram
    && next.console?.tone === snapshot.console?.tone && next.console?.address === snapshot.console?.address && next.appVersion === snapshot.appVersion && next.chromeScrim === snapshot.chromeScrim;
  applyToDocument(next);
  if (same) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function nativeMessageTarget(): NativeMessageTarget | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    webkit?: { messageHandlers?: Record<string, NativeMessageTarget | undefined> };
  } & Record<string, unknown>;
  const ios = scope.webkit?.messageHandlers?.[NATIVE_HANDLER];
  if (ios && typeof ios.postMessage === "function") return ios;
  const android = scope[NATIVE_HANDLER] as NativeMessageTarget | undefined;
  if (android && typeof android.postMessage === "function") return android;
  return null;
}

function postToNative(body: Record<string, string | number>): boolean {
  const target = nativeMessageTarget();
  if (!target) return false;
  try {
    target.postMessage(JSON.stringify(body));
    return true;
  } catch {
    return false; // 셸이 통로를 닫았으면 화면만 바뀐다.
  }
}

/** 앱 시작에 한 번 — 시스템 외관·네이티브 확정·다른 탭의 변경을 구독하고 루트 속성을 맞춘다. */
export function installMobileAppearance(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  applyToDocument(snapshot);
  if (typeof window.matchMedia === "function") {
    systemQuery = window.matchMedia("(prefers-color-scheme: light)");
    systemQuery.addEventListener("change", () => {
      // 앱에서는 OS 외관도 네이티브가 systemScheme으로 알려 준다 — WebView의 미디어 쿼리는
      // Android에서 앱 테마에 따라 OS와 어긋날 수 있어 믿지 않는다.
      if (snapshot.nativeOwned || snapshot.colorMode !== "system") return;
      setSnapshot({ ...snapshot, scheme: systemScheme() });
    });
  }
  // 이벤트는 "다시 읽어라"는 신호일 뿐이고 값은 네이티브가 함께 갈아 끼운 전역에서 읽는다 — 전역
  // 없이 이벤트만 온 브라우저에서 앱 소유로 넘어가 저장을 멈추는 일이 없게 한다.
  window.addEventListener(NATIVE_EVENT, () => {
    const native = readNativeAppearance();
    if (native) setSnapshot(fromNative(native));
  });
  window.addEventListener("storage", (event) => {
    if (snapshot.nativeOwned || (event.key !== COLOR_MODE_KEY && event.key !== FONT_SCALE_KEY)) return;
    const colorMode = readStored(COLOR_MODE_KEY, isColorMode, "system");
    setSnapshot({ ...snapshot, colorMode, fontScale: readStored(FONT_SCALE_KEY, isFontScale, "default"), scheme: resolveScheme(colorMode, systemScheme()) });
  });
  // 문서 시작 주입을 못 하는 구형 Android는 페이지가 뜬 뒤 같은 스크립트를 실행한다 — 그 사이 붙은
  // 전역을 한 번 더 읽는다(이벤트를 놓쳤어도 값은 전역에 남아 있다).
  const late = readNativeAppearance();
  if (late) setSnapshot(fromNative(late));
}

export function getMobileAppearanceSnapshot(): MobileAppearanceSnapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMobileAppearance(): MobileAppearanceSnapshot {
  return useSyncExternalStore(subscribe, getMobileAppearanceSnapshot);
}

function commit(colorMode: MobileColorMode, fontScale: MobileFontScale): void {
  if (snapshot.nativeOwned) {
    const native = readNativeAppearance();
    // 낙관적으로 먼저 칠하고, 네이티브가 저장한 뒤 돌려주는 확정(이벤트)을 정본으로 다시 칠한다.
    setSnapshot({ ...snapshot, colorMode, fontScale, scheme: resolveScheme(colorMode, native?.systemScheme ?? snapshot.scheme), nativeOwned: true });
    postToNative({ v: 1, type: "set", colorMode, fontScale });
    return;
  }
  writeStored(COLOR_MODE_KEY, colorMode);
  writeStored(FONT_SCALE_KEY, fontScale);
  setSnapshot({ ...snapshot, colorMode, fontScale, scheme: resolveScheme(colorMode, systemScheme()), nativeOwned: false });
}

/** 사람이 설정에서 고른 색상 모드. general.theme은 바뀌지 않는다. */
export function setMobileColorMode(colorMode: MobileColorMode): void {
  if (!isColorMode(colorMode) || colorMode === snapshot.colorMode) return;
  commit(colorMode, snapshot.fontScale);
}

/** 사람이 설정에서 고른 모바일 글자 배율. general.fonts는 바뀌지 않는다. */
export function setMobileFontScale(fontScale: MobileFontScale): void {
  if (!isFontScale(fontScale) || fontScale === snapshot.fontScale) return;
  commit(snapshot.colorMode, fontScale);
}

/**
 * 지금 화면의 위·아래 면을 앱에 알린다(드로어·하단 시트 열림/닫힘, impl-spec S-03). 색이 아니라 토큰
 * 이름이며 네이티브가 같은 값으로 상태 바·내비게이션 바를 칠한다. 브라우저에서는 아무것도 하지 않는다.
 */
export function reportMobileChrome(requestedTop: MobileChromeTop, requestedBottom: MobileChromeBottom): void {
  if (!snapshot.nativeOwned) return;
  // 옛 앱은 모르는 토큰이 든 메시지를 통째로 버린다(§3-4) — scrim은 앱이 안다고 알린 때만 보내고, 아니면 가장 가까운 bg-deep으로 대신한다.
  const top = requestedTop === "scrim" && !snapshot.chromeScrim ? "bg-deep" : requestedTop;
  const bottom = requestedBottom === "scrim" && !snapshot.chromeScrim ? "bg-deep" : requestedBottom;
  if ((top !== "bg" && top !== "bg-deep" && top !== "scrim") || (bottom !== "bg" && bottom !== "bg-deep" && bottom !== "surface" && bottom !== "scrim")) return;
  const key = `${top}|${bottom}`;
  if (key === lastChrome) return;
  lastChrome = key;
  postToNative({ v: 1, type: "chrome", top, bottom });
}

/** 연결이 다시 선 뒤·페이지가 다시 보일 때 — 같은 값이라도 앱이 한 번 더 받도록 마지막 보고를 잊는다(NV-7). */
export function forgetReportedMobileChrome(): void {
  lastChrome = "";
}

/**
 * Console 전환 시트(impl-spec S-18)를 연다. 앱에서는 네이티브가 띄운다 — 이 Console의 웹 페이지가
 * 다른 Console들의 이름·주소·상태를 알지 않게 하기 위해서다. 브라우저·구버전 셸이면 false를
 * 돌려주고, 웹 셸이 자기 시트(D12)로 대신한다.
 */
export function openConsoleSwitcher(): boolean {
  if (!snapshot.nativeOwned) return false;
  return postToNative({ v: 1, type: "consoles" });
}
