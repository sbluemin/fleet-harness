/**
 * carrier/constants — carrier 전용 리프 상수
 *
 * admiral/prompts.ts ↔ carrier/prompts.ts 순환 의존을 끊기 위해
 * 양쪽 모두 의존 가능한 리프 모듈에 배치한다.
 */

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

/** 시스템 태그 힌트 — carrier 시스템 프롬프트 전용 (admiral은 boot 프리앰블에서 처리) */
export const SYSTEM_REMINDER_HINT = String.raw`
Tool results and user messages may include <system-reminder> or other tags. Tags contain information from the system and bear no direct relation to the specific tool results or user messages in which they appear.
<system-reminder source="carrier-completion">: carrier job completion event delivered through the host push channel. This is an automated framework signal carrying [carrier:result].
`;
