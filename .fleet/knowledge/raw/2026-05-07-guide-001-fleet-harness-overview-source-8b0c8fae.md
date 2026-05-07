---
id: "guide-001-fleet-harness-overview-source"
created: "2026-05-07T15:44:30.628Z"
sourceType: "inline"
title: "fleet-harness 소개 가이드 원본"
tags: ["guide", "fleet-harness", "overview", "onboarding", "current"]
contentHash: "8b0c8fae"
---
# fleet-harness 소개 가이드 원본

## 개요

fleet-harness는 pi-coding-agent 기반의 멀티-LLM 오케스트레이션 키트다.
8개의 CLI 기반 AI 에이전트(캐리어)를 단일 인터페이스에서 지휘하는 시스템으로, 해군 함대 메타포를 사용한다.

## 차별점

단순 병렬 API 호출이 아닌, 역할과 책임이 명확히 구분된 8개 캐리어 운영.
Fleet Action Protocol로 7단계 체계적 작업 워크플로우 제공.
실시간 Agent Panel로 멀티 캐리어 동시 스트리밍 모니터링.

## 8개 캐리어

- Nimitz (전략 판단)
- Kirov (작전 계획)
- Genesis (구현)
- Ohio (다단계 실행)
- Sentinel (QA/보안)
- Vanguard (정찰)
- Tempest (외부 정보)
- Chronicle (문서화)

## 핵심 개념

- 대원수(ATN): 사용자
- 제독: PI 호스트 에이전트
- 함장: 캐리어 페르소나
- Fleet Action Protocol: 7단계 작업 워크플로우
