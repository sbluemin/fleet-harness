import { useSyncExternalStore } from "react";
import { isConsoleRosterSummary, type ConsoleRosterSummary } from "@fleet-console/protocol/desktop/console-section";

import { createListenerSet } from "./listener-set.js";
import { getMobileAppearanceSnapshot, postMobileShellMessage, type MobileIdentityTone } from "./mobile-appearance-store.js";

/*
 * Fleet Mobile 심리스 콘솔(브리지 v1.6, 공유 계약 m2-contract.md 1·2·4·6·7절, 개정 r1).
 *
 * 셸은 문서 시작에 `window.__fleetMobileConsoles`(동결)를 심고, 갱신 때 같은 전역을 갈아 끼운 뒤
 * `fleet-mobile-consoles` 이벤트를 낸다. 이벤트는 "다시 읽어라" 신호이고 값은 전역에서 읽는다.
 * 페이지가 아는 것은 다른 페어링 콘솔의 불투명 id·표시 이름·모노그램·톤·거친 상태·최소 명부뿐이다 —
 * 주소·지문·쿠키는 네이티브만 안다.
 *
 * 능력 표지 `__fleetMobileAppearance.consoles = { roster: true, seamless: true }`가 없으면(구 셸·브라우저)
 * 이 스토어는 아무것도 보내지 않고 화면은 현행 그대로다.
 *
 * arrival(r1): 문서 적재 때 전역에서 읽은 값만 그 문서에서 한 번 적용한다. 이후 이벤트의 arrival은
 * (null이든 아니든) 보지 않는다 — 셸이 commit 직후 null로 다시 보내는 것은 취소가 아니다.
 */

const STATE_GLOBAL = "__fleetMobileConsoles";
const STATE_EVENT = "fleet-mobile-consoles";
const APPEARANCE_GLOBAL = "__fleetMobileAppearance";
const APPEARANCE_EVENT = "fleet-mobile-appearance";

export const MOBILE_CONSOLES_MAX = 16;
const CONSOLE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;
const CONSOLE_LABEL_MAX = 48;
const CONSOLE_MONOGRAM_MAX = 3;
const ID_MAX = 128;
export const MOBILE_SCROLL_TOP_MAX = 100_000;
/** 누른 행의 진행 표시를 거두는 시간 — 셸의 arrival TTL(30s)과 같다. 실패는 셸이 토스트로 알린다. */
const SWITCH_PENDING_MS = 30_000;
const IDENTITY_TONES: ReadonlySet<string> = new Set(["crimson", "amber", "moss", "teal", "cerulean", "indigo", "plum", "rose"]);
// 제어 문자(C0·DEL·C1) — 계약 4절 "제어문자 없음".
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type MobileConsoleStatus = "ok" | "unsupported" | "unavailable" | "unpaired";

export interface MobileConsoleEntry {
  readonly id: string;
  readonly label: string;
  readonly monogram: string | null;
  readonly tone: MobileIdentityTone | null;
  readonly active: boolean;
  /** 활성 항목은 null. */
  readonly status: MobileConsoleStatus | null;
  readonly at: number | null;
  /** 활성 항목은 언제나 null(페이지가 자기 목록을 그린다). */
  readonly roster: ConsoleRosterSummary | null;
}

export interface MobileConsoleArrival {
  readonly commodore: string;
  readonly commander: string | null;
  readonly scrollTop: number | null;
}

export interface MobileConsolesState {
  readonly v: 1;
  readonly consoles: readonly MobileConsoleEntry[];
  readonly arrival: MobileConsoleArrival | null;
}

export interface MobileConsolesSnapshot {
  /** 셸이 능력 표지를 실었는가(roster·seamless 둘 다). 아니면 보내지 않고 그리지 않는다. */
  readonly capable: boolean;
  readonly state: MobileConsolesState | null;
  /** 전환을 요청하고 아직 결과를 모르는 행 — `${console}/${commodore}/${commander ?? ""}`. */
  readonly switching: string | null;
}

export interface MobileConsoleSwitch {
  readonly console: string;
  readonly commodore: string;
  readonly commander?: string | null;
  readonly scrollTop?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codePoints(value: string): number {
  return [...value].length;
}

/** 계약 4절의 id 규칙 — 1..128자, 제어 문자 없음. */
export function isMobileShellId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX && !CONTROL.test(value);
}

function parseEntry(value: unknown): MobileConsoleEntry | null {
  if (!isRecord(value)) return null;
  const { id, label, monogram, tone, active, status, at, roster } = value;
  if (typeof id !== "string" || !CONSOLE_ID_PATTERN.test(id)) return null;
  if (typeof label !== "string") return null;
  const name = label.trim();
  if (!name || codePoints(name) > CONSOLE_LABEL_MAX || CONTROL.test(name)) return null;
  if (typeof active !== "boolean") return null;
  const letters = typeof monogram === "string" && monogram.trim() && codePoints(monogram.trim()) <= CONSOLE_MONOGRAM_MAX ? monogram.trim() : null;
  const identityTone = typeof tone === "string" && IDENTITY_TONES.has(tone) ? tone as MobileIdentityTone : null;
  const word = status === "ok" || status === "unsupported" || status === "unavailable" || status === "unpaired" ? status : null;
  const stamp = typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : null;
  // 활성 항목의 명부는 쓰지 않는다. 다른 콘솔은 isConsoleRosterSummary를 지난 것만 — 아니면 명부 없음.
  const summary = !active && isConsoleRosterSummary(roster) ? roster : null;
  // unpaired는 목록을 비운다(계약 2절).
  return { id, label: name, monogram: letters, tone: identityTone, active, status: active ? null : word, at: stamp, roster: word === "unpaired" ? null : summary };
}

function parseArrival(value: unknown): MobileConsoleArrival | null {
  if (!isRecord(value) || !isMobileShellId(value.commodore)) return null;
  const commander = isMobileShellId(value.commander) ? value.commander : null;
  const scrollTop = typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0
    ? Math.min(MOBILE_SCROLL_TOP_MAX, Math.round(value.scrollTop))
    : null;
  return { commodore: value.commodore, commander, scrollTop };
}

/**
 * 셸이 심은 상태 — 틀린 항목은 버리고, 같은 id는 처음 것만, 최대 16개. 활성 항목이 정확히 하나가
 * 아니면 이 문서의 자리를 정할 수 없어 상태 전체를 없는 것으로 본다(현행 화면).
 */
export function parseMobileConsolesState(value: unknown): MobileConsolesState | null {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.consoles)) return null;
  const consoles: MobileConsoleEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.consoles.slice(0, MOBILE_CONSOLES_MAX)) {
    const entry = parseEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    consoles.push(entry);
  }
  if (consoles.filter((entry) => entry.active).length !== 1) return null;
  return { v: 1, consoles, arrival: parseArrival(value.arrival) };
}

/** 능력 표지 — `__fleetMobileAppearance.consoles`에 roster·seamless가 모두 참일 때만. */
export function parseMobileConsolesCapability(appearance: unknown): boolean {
  if (!isRecord(appearance) || !isRecord(appearance.consoles)) return false;
  return appearance.consoles.roster === true && appearance.consoles.seamless === true;
}

/**
 * 페이지→셸 전환 메시지(계약 4절) — 키 집합 v,type,console,commodore(+commander, scrollTop).
 * 틀린 값이면 null(보내지 않는다).
 */
export function mobileConsoleSwitchMessage(request: MobileConsoleSwitch): Record<string, string | number> | null {
  if (typeof request.console !== "string" || !CONSOLE_ID_PATTERN.test(request.console) || !isMobileShellId(request.commodore)) return null;
  const body: Record<string, string | number> = { v: 1, type: "switch", console: request.console, commodore: request.commodore };
  if (request.commander !== undefined && request.commander !== null) {
    if (!isMobileShellId(request.commander)) return null;
    body.commander = request.commander;
  }
  if (request.scrollTop !== undefined && request.scrollTop !== null) {
    if (!Number.isFinite(request.scrollTop)) return null;
    body.scrollTop = Math.min(MOBILE_SCROLL_TOP_MAX, Math.max(0, Math.round(request.scrollTop)));
  }
  return body;
}

const listeners = createListenerSet();
let installed = false;
let snapshot: MobileConsolesSnapshot = { capable: false, state: null, switching: null };
/** r1 — 문서 적재 때 읽은 도착. 한 번 꺼내 쓰면 null. */
let documentArrival: MobileConsoleArrival | null = null;
/**
 * 홈 목록 위치(D1) — 같은 문서 안에서 사령관을 열었다 돌아올 때 복원한다(문서 메모리, 저장소 아님).
 * 도착 scrollTop이 초기값이다 → 전환 뒤 뒤로 가면 누를 때의 위치.
 */
let homeScrollMemory: number | null = null;
/** 도착을 어떻게 처리했는가 — 첫 의미 있는 화면(r7)을 판정하는 데 쓴다. */
export type MobileArrivalOutcome = "objective" | "commodore" | "home";
let arrivalOutcome: MobileArrivalOutcome | null = null;
let paintSignalled = false;
const PAINT_SIGNAL_GLOBAL = "__fleetMobilePaintSignal";
const PAINTED_GLOBAL = "__fleetMobilePainted";
const PAINTED_EVENT = "fleet-mobile-painted";
/** r7 보강 — rAF가 멈춘 숨김 뷰를 위한 폴백. */
const PAINT_FALLBACK_MS = 100;
let switchTimer: ReturnType<typeof setTimeout> | null = null;

function readGlobal(name: string): unknown {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, unknown>)[name];
}

function readCapable(): boolean {
  // 앱 소유가 아니면(브라우저) 전역이 있어도 쓰지 않는다 — 보낼 통로가 없다.
  return parseMobileConsolesCapability(readGlobal(APPEARANCE_GLOBAL));
}

function setSnapshot(next: MobileConsolesSnapshot): void {
  if (next.capable === snapshot.capable && next.state === snapshot.state && next.switching === snapshot.switching) return;
  snapshot = next;
  listeners.emit();
}

function clearSwitching(): void {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
  setSnapshot({ ...snapshot, switching: null });
}

/** r6 — 실패 뒤 한 번 오는 상태 이벤트의 detail에만 실린 `failed: "<console id>"`. 전역에는 없다. */
export function failedConsoleOf(event: Event | undefined): string | null {
  const detail = event && "detail" in event ? (event as CustomEvent<unknown>).detail : undefined;
  if (!isRecord(detail) || typeof detail.failed !== "string" || !CONSOLE_ID_PATTERN.test(detail.failed)) return null;
  return detail.failed;
}

function refresh(event?: Event): void {
  const capable = readCapable();
  const state = capable ? parseMobileConsolesState(readGlobal(STATE_GLOBAL)) : null;
  // 전환을 요청한 콘솔이 닿지 않거나 페어링이 풀렸다고 알려 오면 진행 표시를 거둔다.
  // r6: 상태가 이미 unavailable이라 바뀐 것이 없어도, 셸이 그 콘솔의 실패를 알리면 즉시 거둔다.
  let switching = snapshot.switching;
  const failed = failedConsoleOf(event);
  if (switching && failed && switching.startsWith(`${failed}/`)) switching = null;
  if (switching) {
    const target = state?.consoles.find((entry) => switching!.startsWith(`${entry.id}/`));
    if (!target || target.status === "unavailable" || target.status === "unpaired" || target.status === "unsupported") switching = null;
  }
  if (!switching && switchTimer) { clearTimeout(switchTimer); switchTimer = null; }
  setSnapshot({ capable, state, switching });
}

/** 앱 시작에 한 번 — 문서 적재 때의 arrival을 포착하고 셸의 갱신을 구독한다. */
export function installMobileConsoles(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  refresh();
  documentArrival = snapshot.capable ? snapshot.state?.arrival ?? null : null;
  homeScrollMemory = documentArrival?.scrollTop ?? null;
  window.addEventListener(STATE_EVENT, (event) => refresh(event));
  window.addEventListener(APPEARANCE_EVENT, () => refresh());
  // r7 — 이 페이지는 첫 의미 있는 화면을 알린다. 셸은 이 표지가 있을 때만 `fleet-mobile-painted`를 (최대 2.5s) 기다렸다 commit한다.
  (window as unknown as Record<string, unknown>)[PAINT_SIGNAL_GLOBAL] = true;
}

/**
 * r7 — 첫 의미 있는 화면이 섰다. 다음 프레임에 `__fleetMobilePainted = true`와 `fleet-mobile-painted`를 한 번 낸다.
 * 두 번째부터는 아무것도 하지 않는다.
 */
export function markMobileFirstPaint(): void {
  if (paintSignalled || typeof window === "undefined") return;
  paintSignalled = true;
  // 숨긴 스테이징 WebView에서는 rAF가 멈출 수 있다 — 100ms 타이머와 경쟁시켜 먼저 오는 쪽에서 한 번만 낸다.
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    (window as unknown as Record<string, unknown>)[PAINTED_GLOBAL] = true;
    window.dispatchEvent(new Event(PAINTED_EVENT));
  };
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => fire());
  setTimeout(fire, PAINT_FALLBACK_MS);
}

export function mobileFirstPaintSignalled(): boolean {
  return paintSignalled;
}

export function noteMobileArrivalOutcome(outcome: MobileArrivalOutcome): void {
  arrivalOutcome = outcome;
}

/** 이 문서의 도착 처리 결과 — 도착이 없었거나 아직이면 null. */
export function getMobileArrivalOutcome(): MobileArrivalOutcome | null {
  return arrivalOutcome;
}

/** 테스트 전용 — 모듈 상태를 처음으로 되돌린다(리스너는 그대로 둔다). */
export function resetMobileConsolesForTest(): void {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
  installed = false;
  documentArrival = null;
  homeScrollMemory = null;
  arrivalOutcome = null;
  paintSignalled = false;
  snapshot = { capable: false, state: null, switching: null };
  listeners.emit();
}

export function getMobileConsolesSnapshot(): MobileConsolesSnapshot {
  return snapshot;
}

export function useMobileConsoles(): MobileConsolesSnapshot {
  return useSyncExternalStore(listeners.subscribe, getMobileConsolesSnapshot, getMobileConsolesSnapshot);
}

/** 홈을 콘솔별 머리글 섹션으로 그리는가 — 능력이 있고 콘솔이 둘 이상일 때만. */
export function mobileConsolesSeamless(value: MobileConsolesSnapshot): value is MobileConsolesSnapshot & { readonly state: MobileConsolesState } {
  return value.capable && value.state !== null && value.state.consoles.length > 1;
}

function post(body: Record<string, string | number>): boolean {
  if (!snapshot.capable || !getMobileAppearanceSnapshot().nativeOwned) return false;
  return postMobileShellMessage(body);
}

/** 셸에 다른 콘솔 명부를 새로 읽어 달라고 한다(홈 표시 중 30s마다). */
export function requestMobileConsoleRoster(): boolean {
  return post({ v: 1, type: "roster" });
}

export function mobileSwitchKey(request: MobileConsoleSwitch): string {
  return `${request.console}/${request.commodore}/${request.commander ?? ""}`;
}

/** 다른 콘솔의 사령관(·목표)으로 넘어가 달라고 한다. 알려진 비활성 콘솔만. */
export function switchMobileConsole(request: MobileConsoleSwitch): boolean {
  const target = snapshot.state?.consoles.find((entry) => entry.id === request.console);
  if (!target || target.active) return false;
  const body = mobileConsoleSwitchMessage(request);
  if (!body || !post(body)) return false;
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = setTimeout(clearSwitching, SWITCH_PENDING_MS);
  setSnapshot({ ...snapshot, switching: mobileSwitchKey(request) });
  return true;
}

/** r1 — 이 문서의 도착을 한 번 꺼낸다. 두 번째부터는 null. 꺼내는 즉시 `arrived`를 보낸다(선택적 메시지). */
export function takeMobileConsoleArrival(): MobileConsoleArrival | null {
  const arrival = documentArrival;
  if (!arrival) return null;
  documentArrival = null;
  post({ v: 1, type: "arrived" });
  return arrival;
}

/** 아직 꺼내지 않은 이 문서의 도착 — 읽기만(언제 꺼낼지 정하는 데 쓴다). */
export function peekMobileConsoleArrival(): MobileConsoleArrival | null {
  return documentArrival;
}

/** 홈이 돌아올 때 맞출 목록 위치(D1) — 없으면 null(맨 위). */
export function readMobileHomeScrollTop(): number | null {
  return homeScrollMemory;
}

/** 홈 목록이 스크롤될 때 그 위치를 기억한다(문서 메모리). */
export function rememberMobileHomeScrollTop(scrollTop: number): void {
  if (!Number.isFinite(scrollTop)) return;
  homeScrollMemory = Math.min(MOBILE_SCROLL_TOP_MAX, Math.max(0, Math.round(scrollTop)));
}
