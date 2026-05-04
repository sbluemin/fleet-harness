---
id: "carrier-tier2-systemprompt-pattern-source"
created: "2026-05-04T10:31:50.329Z"
sourceType: "inline"
title: "Session 019df205 — Tier2 systemPrompt migration with token measurement"
tags: ["prompt-design", "token-optimization", "carrier", "systemprompt", "anthropic-caching"]
---
Session 019df205-7f41-71ea-8572-cdda97bcdfa1 의 합의 + 실측 결과.

문제: composeTier2Request 가 매 sendMessage 마다 carrier metadata (carrier_identity, permissions, principles, output_format) 를 user message 본문에 주입. 매 turn 마다 ~575 tokens 반복 전송. Anthropic prompt caching 도 user message 영역에는 미적용.

해결: buildCarrierSystemPrompt(metadata) 가 carrier session 의 systemPrompt 본문에 metadata 주입. composeTier2Request 제거. <system-reminder> XML 래핑도 제거 (systemPrompt 자체가 컨텍스트).

추가: SYSTEM_REMINDER_HINT 의 <system-reminder source="carrier-completion"> 안내는 admiral 신호이므로 carrier 시스템 프롬프트에서 잘못된 위치였음 — 제거. admiral 의 PROTOCOL_PREAMBLE 에 이미 정확한 안내 있음.

태그 명명: <carrier_*> → <your_*> (직접 호명, LLM attention 강화). output_format 만 <output_format> 그대로 (산출물 형식이라 your_ prefix 부적절).

Fleet 배경 anchor 추가: carrier 가 자기 위치(Fleet 의 일부, Admiral 휘하), task 출처(user message), 메타데이터의 의미를 인식하도록.

실측 토큰 절감 (영어 4 chars/token 보수적 추정):
- 평균 carrier metadata: Before 575 tok / After 654 tok (Fleet 배경 +79 tok)
- 1회 호출: -13.7% (살짝 손해)
- 5회 호출 (풀 재사용): 77.3% 절감
- 10회: 88.6% / 50회: 97.7% / 100회: 98.9% 절감
- Anthropic prompt caching 적용 (cached input 10% 비용): 100회 기준 87.6% 비용 절감