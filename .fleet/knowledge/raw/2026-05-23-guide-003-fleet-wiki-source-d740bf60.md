---
id: "guide-003-fleet-wiki-source"
created: "2026-05-23T14:47:42.640Z"
sourceType: "inline"
title: "Guide - 003 fleet-wiki 사용법"
tags: ["guide", "fleet-wiki", "fleet-wiki-web", "workflow", "onboarding", "current"]
contentHash: "d740bf60"
---
2026-05-23 fleet-harness Guide 003 현행화

## 변경사항

1. SPA 경로 구조를 multi-workspace 형식으로 수정 (/w/:ws/ 기반)
2. CLI 옵션에서 --host 제거 (127.0.0.1 고정)
3. per-user daemon 설명 추가
4. 레거시 경로 리다이렉션 설명 추가

## 검증 근거

- commit 1f6e6882: feat(wiki-web): introduce per-user daemon with multi-workspace serving
- fleet-wiki-web CLAUDE.md: SPA Routes 섹션 확인