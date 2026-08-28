import type {
  ClientConsoleStateCapability,
  ClientExpandedSurfacesCapability,
  ClientNavigationCapability,
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
}

let capabilities: CodexHostCapabilities | null = null;
let theme: ConsoleTheme = "instrument";

export function bindCodexHost(next: CodexHostCapabilities): void {
  capabilities = next;
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

export function subscribeConsoleState(listener: () => void): () => void {
  return capabilities?.consoleState.subscribe(listener) ?? (() => undefined);
}

export function resolveActiveLocaleFromHost(): ConsoleLocale {
  return resolveActiveLocale();
}
