/**
 * OpenCode Go 접속 좌표. `src/auth/`는 공급자를 모르는 채로 남아야 하므로 저장 id·기반
 * URL·검증 경로는 공급자 폴더인 이 자리에 산다.
 *
 * 근거: https://opencode.ai/docs/go/ (2026-11-15 확인). 기반 URL은 `/inference/go/`이며,
 * 예전 `/zen/go/` 네임스페이스와 그 아래 경로는 다시 쓰지 않는다.
 */

// Keep the persisted provider id stable so stored keys survive upgrades. 이 공급자가 제거되기
// 전(#1874)에 저장된 auth.json 항목을 그대로 읽어야 하므로 문자열을 바꾸지 않는다.
export const OPENCODE_AUTH_PROVIDER_ID = "Claude Code with OpenCode Go";
export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/inference/go";
export const OPENCODE_GO_CHAT_COMPLETIONS_URL = `${OPENCODE_GO_API_BASE_URL}/openai/v1/chat/completions`;
export const OPENCODE_GO_RESPONSES_URL = `${OPENCODE_GO_API_BASE_URL}/openai/v1/responses`;
/**
 * 키 검증 프로브가 부르는 모델 목록 경로. 추론 토큰을 쓰지 않는다. 목록 자체는 공개라 키 없이도
 * 200이므로, 프로브는 언제나 키를 싣고 401·403만 거절로 읽는다(2026-11-15 실측: 가짜·만료 키 401).
 */
export const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_API_BASE_URL}/v1/models`;
/**
 * 구독 사용량. 공개 문서에는 없지만 #767이 쓰던 공식 사용량 API의 새 네임스페이스 자리다.
 * 2026-11-15 실측: 키 없이 401 AuthError(존재), `/inference/go/openai/v1/usage`는 404.
 */
export const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_API_BASE_URL}/v1/usage`;
/**
 * 서드파티 클라이언트는 범용 SDK·HTTP 라이브러리 이름이 아니라 자기 user agent로 자신을
 * 밝혀야 한다(문서 "Where can I use it?"). 호스트(`fleet-console`) 이름을 그대로 쓴다.
 */
export const OPENCODE_GO_USER_AGENT = "fleet-console";
