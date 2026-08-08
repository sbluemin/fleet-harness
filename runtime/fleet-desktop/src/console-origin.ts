/**
 * Console이 살 수 있는 origin의 단일 정의.
 *
 * 이 판정이 세 곳에 복사되어 있었고, 원격을 열자 창은 이동했는데 전체화면·테마 동기화기가
 * 각자의 사본에서 그 origin을 거절했다. 사본은 반드시 어긋나므로 정의는 하나만 둔다.
 */

/** 루프백 콘솔은 평문 http이고 언제나 포트를 가진다. */
export function isLoopbackConsoleOrigin(origin: string): boolean {
  const parsed = parseCanonicalOrigin(origin);
  return parsed !== null && parsed.protocol === "http:" && Boolean(parsed.port)
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
}

/** 원격 콘솔은 TLS 위에서만 산다 — 지문을 대조할 수 있는 전송이 그것뿐이다. */
export function isRemoteConsoleOrigin(origin: string): boolean {
  const parsed = parseCanonicalOrigin(origin);
  return parsed !== null && parsed.protocol === "https:" && parsed.hostname.length > 0;
}

export function isConsoleOrigin(origin: string): boolean {
  return isLoopbackConsoleOrigin(origin) || isRemoteConsoleOrigin(origin);
}

/** 호출자가 자기 실패 코드를 들고 온다 — 어느 표면이 거절했는지가 로그에서 드러나야 한다. */
export function normalizeConsoleOrigin(origin: string, failureCode: string): string {
  if (!isConsoleOrigin(origin)) throw new Error(failureCode);
  return new URL(origin).origin;
}

/** 경로·질의·조각·자격이 섞인 문자열은 origin이 아니라 URL이다. */
function parseCanonicalOrigin(origin: string): URL | null {
  try {
    const parsed = new URL(origin);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    return parsed.origin === origin ? parsed : null;
  } catch {
    return null;
  }
}
