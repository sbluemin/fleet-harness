---
id: "guide-002-carrier-status-source"
created: "2026-05-23T14:47:14.664Z"
sourceType: "inline"
title: "Guide - 002 Carrier Status 사용법"
tags: ["guide", "carrier-status", "keybind", "onboarding", "current"]
contentHash: "1e912bd9"
---
2026-05-23 fleet-harness Guide 002 현행화

## 변경사항

1. 서비스 상태 참조 제거 (UI에서 제거됨)
2. Sortie 토글 기능 제거 (commit a17155b5: remove sortie toggle feature)
3. Squadron 토글 기능 제거 (UI에서 제거됨)
4. 서비스 상태 배지 섹션 제거 (OP/DEG/OUT/MNT/UNK)
5. 키바인드 테이블에서 d, S 키 제거
6. CLI 타입 목록 수정: gemini 제거, cursor 추가 (commit 12f19a76: add cursor agent backend)
7. 배지 설명에서 sortie off, SQ 제거
8. 캐리어 이름 편집 기능(N) 추가
9. carrier_taskforce → carrier_dispatch 자동 승격 설명 수정

## 검증 근거

- overlay-input.ts: d, S 키 미존재
- TASKFORCE_CLI_TYPES: claude, claude-zai, claude-kimi, codex, opencode-go, cursor (6개)
- overlay-renderer.ts: 서비스 상태 헤더 미존재