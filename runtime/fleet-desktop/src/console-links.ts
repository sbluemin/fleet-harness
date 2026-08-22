// What this shell will follow: which origins count as the console, and how a
// fleet:// access link is recognised on the command line.



// ─── console origins ───────────────────────────────────────────────────────────

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

// ─── fleet:// links ────────────────────────────────────────────────────────────

/**
 * `fleet://join?code=…`를 OS에서 받아 로컬 Console에 넘기기 위한 최소한의 배관.
 *
 * Desktop은 이 문자열을 해석하지 않는다 — 봉투를 열고 주소·지문·자격을 판정하는 일은 Console
 * 하나가 맡는다. 여기서 하는 일은 "이게 우리 스킴인가"를 가르고 그대로 전달하는 것뿐이다.
 * 그래서 argv에 섞여 들어온 잡다한 인자를 링크로 착각하지 않는 것이 이 파일의 유일한 책임이다.
 */
export const FLEET_PROTOCOL = "fleet";

const LINK_PREFIX = "fleet://";
const MAX_LINK_LENGTH = 4096;

export function isFleetProtocolLink(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LINK_LENGTH) return false;
  if (!value.toLowerCase().startsWith(LINK_PREFIX)) return false;
  // 공백과 제어문자가 섞인 값은 링크가 아니라 잘못 이어 붙은 인자다.
  return !/[\u0000-\u001f\u007f\s]/u.test(value);
}

/**
 * 실행 인자 중 링크 하나를 고른다. 여러 개가 오면 첫 번째만 쓴다 — 창은 하나뿐이고, 한 번의
 * 실행이 여러 콘솔을 여는 동선은 없다.
 */
export function findAccessLinkArgument(argv: readonly string[]): string | null {
  return argv.find((entry) => isFleetProtocolLink(entry)) ?? null;
}
