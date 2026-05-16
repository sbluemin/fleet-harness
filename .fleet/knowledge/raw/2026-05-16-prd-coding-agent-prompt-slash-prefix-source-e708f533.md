---
id: "prd-coding-agent-prompt-slash-prefix-source"
created: "2026-05-16T15:53:01.036Z"
sourceType: "inline"
title: "prd-coding-agent-prompt-slash-prefix-source"
tags: ["coding-agent", "prompts", "slash-command", "naming-convention", "ux", "shipped"]
contentHash: "e708f533"
---
Fleet Wiki에 새 PRD 엔트리 생성 요청:
- entry id: prd-coding-agent-prompt-slash-prefix
- feature area: coding-agent / prompt template invocation
- 배경: bare /{name} 호출 형식이 skill과 비대칭적이며 인지 부채 발생
- 변경: /prompt:{name} 접두사 도입
- 날짜: 2026-05-17
- 상태: shipped
- 브랜치: feat-prefix-prompts