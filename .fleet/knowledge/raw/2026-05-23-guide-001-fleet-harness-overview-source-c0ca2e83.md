---
id: "guide-001-fleet-harness-overview-source"
created: "2026-05-23T14:46:55.449Z"
sourceType: "inline"
title: "Guide - 001 fleet-harness 소개"
tags: ["guide", "fleet-harness", "overview", "onboarding", "current"]
contentHash: "c0ca2e83"
---
2026-05-23 fleet-harness Guide 001 현행화

## 변경사항

1. pi-coding-agent 참조 제거 (commit af7c04fe: remove pi-coding-agent references from codebase)
2. Tempest 캐리어 CLI 수정: Gemini → Claude (gemini CLI 제거, Tempest는 기본 CLI claude 사용)
3. 깨진 링크 제거: fleet-wiki-cli-onboarding 엔트리 부재
4. PI CLI 참조 정리: 현재 아키텍처에 맞게 수정

## 검증 근거

- CLI_BACKENDS: claude, claude-zai, claude-kimi, codex, opencode-go, cursor (6개)
- Tempest 기본 CLI: packages/fleet-carriers/src/personas/index.ts 확인 결과 `cli: "claude"`
- gemini CLI 제거: commit 5c278ea8 feat(unified-agent)!: remove Gemini CLI provider support