export const CURSOR_AUTH_PROVIDER_ID = "Fleet AI Gateway with Cursor";
/** 사용자가 여는 승인 페이지. challenge·uuid만 싣는다. verifier는 폴링하는 서버만 갖는다. */
export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
/** 응답에 수명이 없다. Cursor CLI의 폴링 상한(150회, 최대 10초 간격)보다 짧게 둔다. */
export const CURSOR_LOGIN_LIFETIME_MS = 10 * 60_000;
export const CURSOR_POLL_INTERVAL_SECONDS = 2;
/** 연이은 일시 오류를 이만큼 넘기면 로그인을 실패로 끝낸다. */
export const CURSOR_POLL_MAX_CONSECUTIVE_ERRORS = 3;
export const CURSOR_FALLBACK_ACCESS_TTL_MS = 3_600_000;
