---
id: "guide-005-cli-hooks-io-comparison-source"
created: "2026-06-07T03:27:07.329Z"
sourceType: "inline"
title: "Guide - 005 Claude Code vs Codex CLI Hook Input/Output 활용 기능 비교"
tags: ["guide", "hooks", "claude-code", "codex", "cli", "comparison", "current"]
contentHash: "385c9ab6"
---
# Claude Code vs Codex CLI — Hook Input/Output 활용 기능 비교

> 검증 출처: Codex=openai/codex Rust 소스(codex-rs/hooks, protocol HookEventName enum) 직접 인용, Claude Code=공식 docs code.claude.com/docs/en/hooks 필드 대조(Deep Dive로 발명 필드 11종 배제). UserPromptSubmit 입력은 prompt(문자열).

핵심 활용 기능 4축: 컨텍스트 주입(additionalContext / additional_context), 도구·프롬프트 차단(permissionDecision:deny / decision:block), 입력 재작성(modifiedToolInput / updated_input), 실행 중단·재개(continue:false+stopReason / continuation_fragments).

additionalContext 지원 event: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart (양 플랫폼 거의 동일). Codex는 SessionStart/UserPromptSubmit/SubagentStart에서 plain stdout 자동 수집.

Claude Code 고유: sessionTitle/watchPaths/reloadSkills, Elicitation(action+content), MessageDisplay(displayContent). Codex 고유: feedback_message, continuation_fragments, turn_id/tool_use_id.

제목 일관성 정정: frontmatter title을 'Guide - 005 ...' 넘버링 패턴으로 변경(기존 guide-001~004와 일관).