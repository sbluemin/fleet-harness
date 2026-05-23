/**
 * protocols/completion-report — Admiral Completion Report follow-up prompt
 */

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────

export const COMPLETION_REPORT_REQUEST_PROMPT =
  "First, silently complete Phase 1 Step 0 (Mission Objective Anchor) for the active task in this session and use it as the north star for the report. Do not output the Objective line or any part of this anchoring. Then output only the Completion Report body for the active task, following the existing Completion Report spec already injected in the system prompt exactly, with no text before or after it."

// ─────────────────────────────────────────────────────────
// 함수
// ─────────────────────────────────────────────────────────

export function buildCompletionReportRequestPrompt(): string {
  return COMPLETION_REPORT_REQUEST_PROMPT;
}
