---
id: "guide-005-cli-hooks-io-comparison"
title: "Guide - 005 Claude Code vs Codex CLI Hook Input/Output 활용 기능 비교"
tags: ["guide", "hooks", "claude-code", "codex", "cli", "comparison", "current"]
created: "2026-06-07T03:18:01.960Z"
updated: "2026-06-07T03:27:07.329Z"
version: 2
rawSourceRef: "raw/2026-06-07-guide-005-cli-hooks-io-comparison-source-385c9ab6.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-06-07-guide-005-cli-hooks-io-comparison-source-6fb1bd2b.md\",\"title\":\"Claude Code vs Codex CLI — Hook Input/Output 활용 기능 비교\",\"hash\":\"6fb1bd2b\"},{\"ref\":\"raw/2026-06-07-guide-005-cli-hooks-io-comparison-source-385c9ab6.md\",\"title\":\"Guide - 005 Claude Code vs Codex CLI Hook Input/Output 활용 기능 비교\",\"hash\":\"385c9ab6\"}]"
---
# Claude Code vs Codex CLI — Hook Input/Output 활용 기능 비교

> **검증 출처(Provenance):**
> - Codex CLI: `openai/codex` main 브랜치 Rust 소스 직접 인용 — `codex-rs/hooks/src/schema.rs`, `codex-rs/hooks/src/events/*.rs`, `codex-rs/protocol/src/protocol.rs`(`HookEventName` enum), `codex-rs/config/src/hook_config.rs`. (Tempest 코드 검증, confidence: high)
> - Claude Code: 공식 문서 `https://code.claude.com/docs/en/hooks` 필드 단위 대조. (Deep Dive로 1차 보고의 발명 필드 11종 배제 후 확정)
> - 배제된 비실재 필드(Claude Code 공식 스펙에 없음): `environment`, `modifiedMessage`, `injectedContext`, `modifiedToolOutput`, `qualityAssurance`, `preserveItems`, `compactionStrategy`, `autoAction`, `qualityScore`, `suggestedRetry`, `notifyUser`. UserPromptSubmit 입력은 `user_message` 객체가 아니라 `prompt`(문자열).

## 개요

두 CLI 코딩 에이전트(Claude Code, Codex CLI)는 lifecycle hook을 통해 에이전트 동작에 개입할 수 있다. hook은 **stdin으로 JSON input**을 받아 현재 상태를 파악하고, **stdout으로 JSON output**을 반환하여 동작을 제어하거나 모델에 컨텍스트를 주입한다. 이 문서는 각 hook event가 어떤 input을 받고 어떤 output 필드로 무엇을 할 수 있는지를 1:1로 비교한다.

## 핵심 활용 기능 4가지 (공통 축)

| 활용 기능 | 의미 | Claude Code | Codex CLI |
|---|---|---|---|
| 컨텍스트 주입 | 모델에 추가 정보 삽입 | `additionalContext` | `additional_context` (+ plain stdout 자동 수집) |
| 도구/프롬프트 차단 | 위험 동작 거부 | `permissionDecision:deny` / `decision:block` | `permission_decision:deny` / `decision:block` |
| 입력 재작성 | 도구 호출 인자 교체 | `modifiedToolInput`(공식 문서 부분 언급) | `updated_input` (PreToolUse, 코드 확인) |
| 실행 중단/재개 | 턴 중단 또는 재개 유도 | `continue:false`+`stopReason` / `decision:block`+`reason` | `continue:false`+`stop_reason` / `continuation_fragments` |

공통 top-level output: 양쪽 모두 `continue` · `stopReason`/`stop_reason` · `suppressOutput`/`suppress_output` · `systemMessage`/`system_message`(사용자 표시용, 모델 주입 아님).

## additionalContext(컨텍스트 주입) 지원 매트릭스

가장 빈번히 쓰이는 기능. 어느 event에서 모델에 컨텍스트를 주입할 수 있는가:

| Event | Claude Code | Codex CLI |
|---|:---:|:---:|
| SessionStart | O (+`initialUserMessage`) | O (+plain stdout) |
| UserPromptSubmit | O | O (+plain stdout) |
| PreToolUse | O | O |
| PostToolUse | O | O (+`feedback_message`) |
| SubagentStart | O | O (+plain stdout) |
| PermissionRequest | X | X |
| Stop / SubagentStop | O (Claude) | X (대신 `continuation_fragments`) |
| PreCompact / PostCompact | X | X |

핵심 컨텍스트 주입 지점(Session/Prompt/Tool/Subagent 시작)은 양쪽이 거의 1:1 동일하다.

## 차단·제어 가능 동작 매트릭스

| 기능 | Claude Code (event) | Codex CLI (event) |
|---|---|---|
| 도구 차단 | PreToolUse(`permissionDecision:deny`), PermissionRequest(`decision.behavior:deny`), PostToolUse(`decision:block`) | PreToolUse(`permission_decision:deny`), PermissionRequest(`behavior:deny`), PostToolUse(`decision:block`) |
| 프롬프트 차단 | UserPromptSubmit(`decision:block`+`reason`) | UserPromptSubmit(`decision:block`, exit 2) |
| 자동 승인/거부 | PermissionRequest(`behavior:allow`), PermissionDenied(`retry:true`) | PermissionRequest(`behavior:allow`) |
| 입력 재작성 | PreToolUse(`modifiedToolInput`) | PreToolUse(`updated_input`) |
| 세션 재개 유도 | Stop/SubagentStop(`decision:block`+`reason`) | Stop/SubagentStop(`continuation_fragments`, exit 2 → continuation_prompt) |
| MCP elicitation 응답 | Elicitation(`action`+`content`) | X (미지원) |
| 세션 메타 제어 | SessionStart(`sessionTitle`,`watchPaths`,`reloadSkills`) | X |

## Input 페이로드 — event별 고유 필드 (검증분)

### Claude Code
공통: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `model`

| Event | 고유 input 필드 |
|---|---|
| SessionStart | `source`(startup/resume/clear/compact), `agent_type?` |
| UserPromptSubmit | `prompt`(string) |
| PreToolUse / PermissionRequest | `tool_name`, `tool_input` |
| PostToolUse | `tool_name`, `tool_input`, `tool_result` |
| PostToolUseFailure | `tool_name`, `tool_input`, `error` |
| SubagentStart / SubagentStop | `agent_id`, `agent_type` |
| FileChanged | `file_path` |
| InstructionsLoaded | `file_path`, `memory_type`, `load_reason` |

### Codex CLI
공통: `session_id`, `turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `agent_id?`, `agent_type?`

| Event | 고유 input 필드 |
|---|---|
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id` |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `tool_use_id` |
| SessionStart | `source` |
| UserPromptSubmit | `prompt` |
| SubagentStop | `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` |
| Stop | `stop_hook_active`, `last_assistant_message` |
| PreCompact / PostCompact | `trigger`(manual/auto) |

## Codex hook handler type (3종)

`codex-rs/hooks` 코드 기준 handler type은 `Command`, `Prompt`, `Agent` 3종. exit code 처리는 event별로 다르다:
- PreToolUse: exit 2 → stderr = block_reason
- PostToolUse: exit 2 → stderr = feedback_message (stop 아님)
- UserPromptSubmit: exit 2 → block + stop
- Stop / SubagentStop: exit 2 → stderr = continuation_prompt (재개 트리거)

Codex 특이사항: SubagentStart는 컨텍스트 주입 전용으로 `continue:false`가 무시된다(중단 불가). PermissionRequest의 `updated_input`/`updated_permissions`/`interrupt`는 wire에 존재하나 현재 전달 시 fail-closed("예약됨").

## Claude Code hook output 종합 (검증분)

| Event | 사용 가능한 주요 output |
|---|---|
| SessionStart | `additionalContext`, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| UserPromptSubmit | `decision:block`, `reason`, `additionalContext`, `continue`, `stopReason`, `suppressOutput`, `systemMessage` |
| PreToolUse | `permissionDecision`(allow/deny/ask), `permissionDecisionReason`, `additionalContext`, `modifiedToolInput`(부분 문서화) |
| PermissionRequest | `decision.behavior`(allow/deny), `updatedInput` |
| PermissionDenied | `retry` |
| PostToolUse / PostToolBatch | `decision:block`, `reason`, `additionalContext` |
| Stop / SubagentStop | `decision:block`, `reason`, `additionalContext`(Stop) |
| Elicitation / ElicitationResult | `action`(accept/decline/cancel), `content` |
| MessageDisplay | `displayContent` |
| WorktreeCreate | `worktreePath` |

## 핵심 차이점

1. 컨텍스트 주입은 사실상 동등 — `additionalContext`/`additional_context`가 양쪽 핵심 무기이며 지원 event도 거의 일치한다.
2. Codex 편의 기능 — SessionStart·UserPromptSubmit·SubagentStart에서 plain stdout을 자동으로 컨텍스트로 수집(별도 JSON 불필요), PostToolUse `feedback_message`로 모델 피드백.
3. Claude Code 우위 영역 — 세션 메타 제어(`sessionTitle`/`watchPaths`/`reloadSkills`), MCP `Elicitation` 응답, `MessageDisplay`(`displayContent`) 등 event 종류가 더 많다.
4. 재개 메커니즘 차이 — Claude은 Stop에서 `decision:block`+`reason`, Codex는 전용 `continuation_fragments` 구조.
5. Codex 입력 식별자 — `turn_id`·`tool_use_id`로 도구 호출 단위 추적이 더 명시적.

## 관련 항목

- [[wiki:guide-004-cli-subagent-injection]] — 외부 CLI spawn 시 native subagent 주입 메커니즘 비교 (동일 Claude/Codex 비교 계열)