---
id: "carrier-metadata-emphasis-ladder-source"
created: "2026-05-04T10:30:25.872Z"
sourceType: "inline"
title: "Session 019df205 — carrier metadata emphasis consistency design"
tags: ["carrier", "metadata", "doctrine", "prompt-design", "consistency"]
---
Session 019df205-7f41-71ea-8572-cdda97bcdfa1 의 합의 내용. 8개 carrier persona metadata에 일관된 강조 표현 사다리 적용 결정.

기존 혼란: Nimitz "Must NOT" + "CRITICAL:" 혼용, Sentinel 강조 누락, Kirov 소문자 must, Tempest는 ALWAYS/NEVER 별도 표현, Genesis/Ohio/Chronicle은 자기 이름 반복 (Genesis MUST NOT).

확정 사다리 — admiral 결정:
- L1 CRITICAL: ... (안전 invariant — 위반 시 시스템/책임 분리 깨짐) → permissions 영역 전용
- L2 MUST ... / MUST NOT ... (binding 의무 — Admiral 결정 따름, plan 따름, 도메인 침범 금지) → permissions/principles 양쪽
- L3 평서문 (가이드/권고)
- whenToUse / whenNotToUse 영역에는 강조 사용 금지 (영역 자체가 분류 의도이므로 중복)
- 자기 이름 반복 제거: Genesis MUST → MUST