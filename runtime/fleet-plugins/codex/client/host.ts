import type {
  ClientConsoleStateCapability,
  ClientExpandedSurfacesCapability,
  ClientNavigationCapability,
  ClientRailCapability,
  ConsoleTheme,
} from "@fleet-console/sdk/plugin";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { resolveActiveLocale, setActiveLocale } from "./i18n/index.js";

/**
 * 호스트가 install에서 건네준 능력들. 예전에는 이 파일들이 코어 스토어를 직접 import했고,
 * 그래서 코어 내부 형태가 움직일 때마다 Codex가 깨졌다.
 *
 * 모듈 스코프 상태이지만 플러그인 번들 안이므로 호스트/플러그인 경계를 넘지 않는다.
 */
interface CodexHostCapabilities {
  readonly consoleState: ClientConsoleStateCapability;
  readonly navigation: ClientNavigationCapability;
  readonly surfaces: ClientExpandedSurfacesCapability;
  readonly rail: ClientRailCapability;
}

let capabilities: CodexHostCapabilities | null = null;
let theme: ConsoleTheme = "instrument";

/**
 * 바인딩을 기다리는 쪽. 상주 기여는 App의 install effect보다 **먼저** 마운트된다(자식
 * effect가 부모보다 먼저 돈다). 그때 능력을 한 번 읽고 마는 코드는 영영 빈손을 쥐게 되므로,
 * 바인딩이 일어난 뒤 스스로 다시 붙을 기회를 준다.
 */
const bindListeners = new Set<() => void>();

export function onCodexHostBound(listener: () => void): () => void {
  bindListeners.add(listener);
  // 이미 묶인 뒤에 등록했다면 지금 한 번 돌려준다 — 순서에 기대지 않기 위한 계약이다.
  if (capabilities) listener();
  return () => { bindListeners.delete(listener); };
}

export function bindCodexHost(next: CodexHostCapabilities): void {
  capabilities = next;
  for (const listener of bindListeners) listener();
}

export function hostCapabilities(): CodexHostCapabilities {
  if (!capabilities) throw new Error("codex_host_not_bound");
  return capabilities;
}

/** 아직 bind 전일 수 있는 자리에서 쓴다 — 부팅 순서에 기대지 않는다. */
hostCapabilities.bound = (): CodexHostCapabilities | null => capabilities;

export function setConsoleTheme(next: ConsoleTheme | undefined): void {
  if (next) theme = next;
}

export function consoleTheme(): ConsoleTheme {
  return theme;
}

/** 로케일은 호스트가 알려준다 — 플러그인이 전역 설정 스토어를 읽지 않는다. */
export function setConsoleLocale(locale: ConsoleLocale | undefined): void {
  setActiveLocale(locale);
}

export function activeTheaterId(): string | null {
  return capabilities?.consoleState.getActiveTheaterId() ?? null;
}

export function setActiveTheater(theaterId: string): void {
  capabilities?.consoleState.setActiveTheater(theaterId);
}

/** 공유 링크로 들어오면 Codex 패널이 아직 서 있지 않다 — 그 자리를 세운다. */
export function openCodexRailPanel(): void {
  capabilities?.rail.open("codex");
}

export function subscribeConsoleState(listener: () => void): () => void {
  return capabilities?.consoleState.subscribe(listener) ?? (() => undefined);
}

export function resolveActiveLocaleFromHost(): ConsoleLocale {
  return resolveActiveLocale();
}
