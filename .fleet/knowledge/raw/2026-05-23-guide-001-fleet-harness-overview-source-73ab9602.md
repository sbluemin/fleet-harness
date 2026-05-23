---
id: "guide-001-fleet-harness-overview-source"
created: "2026-05-23T14:48:27.489Z"
sourceType: "inline"
title: "Guide - 001 fleet-harness 소개"
tags: ["guide", "fleet-harness", "overview", "onboarding", "current"]
contentHash: "73ab9602"
---
2026-05-23 fleet-harness Guide 001 현행화 (conflict 해결)

## 변경사항

1. pi-coding-agent 참조 제거 (commit af7c04fe)
2. Tempest 캐리어 CLI 수정: Gemini → Claude
3. 깨진 링크 제거: fleet-wiki-cli-onboarding → guide-003-fleet-wiki
4. PI CLI 참조 정리: fleet-exp 제거, PI_EXPERIMENTAL 환경변수 제거
5. 계층 구조 설명 수정: PI 호스트 → 호스트 에이전트

## 검증 근거

- CLI_BACKENDS: claude, claude-zai, claude-kimi, codex, opencode-go, cursor (6개)
- Tempest 기본 CLI: packages/fleet-carriers/src/personas/index.ts 확인 결과 `cli: "claude"`
- gemini CLI 제거: commit 5c278ea8