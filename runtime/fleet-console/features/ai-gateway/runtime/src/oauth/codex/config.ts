export const CODEX_AUTH_PROVIDER_ID = "Fleet AI Gateway with Codex";
/** Codex CLI의 공개 client id. 등록되지 않은 id는 거절되므로 재사용한다. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
/** 응답에 확인 URL이 없다. 사용자는 이 페이지에서 코드를 입력한다. */
export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
/** 응답에 수명이 없다. Codex CLI의 폴링 상한(120회 × 약 8초)에 맞춘다. */
export const CODEX_DEVICE_LIFETIME_MS = 15 * 60_000;
export const CODEX_JWT_AUTH_CLAIM = "https://api.openai.com/auth";
