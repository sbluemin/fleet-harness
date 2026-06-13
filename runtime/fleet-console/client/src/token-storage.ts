export interface ConsoleTokens {
  readonly observerToken: string | null;
  readonly terminalToken: string | null;
}

const OBSERVER_TOKEN_STORAGE_KEY = "fleet-console-observer-token";
const TERMINAL_TOKEN_STORAGE_KEY = "fleet-console-terminal-token";

/** URL fragment의 1회성 토큰들을 sessionStorage로 옮기고 주소창에서 제거한 뒤 반환한다. */
export function readConsoleTokens(): ConsoleTokens {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const observerToken = fragment.get("observerToken");
  const terminalToken = fragment.get("terminalToken");
  if (observerToken) sessionStorage.setItem(OBSERVER_TOKEN_STORAGE_KEY, observerToken);
  if (terminalToken) sessionStorage.setItem(TERMINAL_TOKEN_STORAGE_KEY, terminalToken);
  if (observerToken || terminalToken) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return {
    observerToken: observerToken ?? sessionStorage.getItem(OBSERVER_TOKEN_STORAGE_KEY),
    terminalToken: terminalToken ?? sessionStorage.getItem(TERMINAL_TOKEN_STORAGE_KEY),
  };
}

/** 기존 호출자 호환용 observer token 읽기. */
export function readObserverToken(): string | null {
  return readConsoleTokens().observerToken;
}

export function clearObserverToken(): void {
  sessionStorage.removeItem(OBSERVER_TOKEN_STORAGE_KEY);
}

export function clearTerminalToken(): void {
  sessionStorage.removeItem(TERMINAL_TOKEN_STORAGE_KEY);
}

export function clearConsoleTokens(): void {
  clearObserverToken();
  clearTerminalToken();
}
