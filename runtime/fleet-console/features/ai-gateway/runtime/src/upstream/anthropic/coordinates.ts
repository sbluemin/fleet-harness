/**
 * Anthropic API 키(Claude Console, 구독에 붙는 월 API 크레딧 포함) 접속 좌표. `src/auth/`는 공급자를
 * 몰라야 하므로 저장 id·모델 id는 공급자 폴더인 이 자리에 산다.
 *
 * 구독 `claude`(설치된 Claude Code가 OAuth로 호출하는 네이티브 별칭)와는 **별도 공급자**다: 자격이
 * 키이고, 청구가 API 크레딧이며, 사용량은 플릿이 응답 usage로 직접 센다.
 *
 * 근거: https://platform.claude.com/docs/en/models/overview (2026-11-18 열람) — Claude API ID는 고정
 * 스냅샷이고 별칭과 같다. 크레딧은 Agent SDK 진입(`sdk-ts`)에서만 쓰이며 대화형 CLI는 `billing_error`로
 * 거절된다(2026-11-18 지휘관 실측, e0-credit-attribution). 그래서 이 공급자는 Agent SDK 세션 전용이다.
 */

/** Quota·게이트웨이·설정이 함께 쓰는 공급자 id. 구독 `claude`와 별도 항목이다. */
export const ANTHROPIC_PROVIDER_ID = "anthropic";
/** auth.json에 저장되는 공급자 id. 저장된 키가 업그레이드 뒤에도 읽히도록 바꾸지 않는다. */
export const ANTHROPIC_AUTH_PROVIDER_ID = "Anthropic API";
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
