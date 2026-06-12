const TOKEN_STORAGE_KEY = "fleet-console-observer-token";

/** URL fragment의 1회성 토큰을 sessionStorage로 옮기고 주소창에서 제거한 뒤 반환한다. */
export function readObserverToken(): string | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const fragmentToken = fragment.get("observerToken");
  if (fragmentToken) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fragmentToken);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return fragmentToken;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearObserverToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}
