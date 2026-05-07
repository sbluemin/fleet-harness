---
id: "guide-002-carrier-status-source"
created: "2026-05-07T15:45:04.197Z"
sourceType: "inline"
title: "Carrier Status 사용법 가이드 원본"
tags: ["guide", "carrier-status", "keybind", "onboarding", "current"]
contentHash: "cb364687"
---
# Carrier Status 사용법 가이드 원본

## 개요

Alt+O로 열리는 Carrier Status 오버레이는 8개 캐리어의 CLI 백엔드, 모델, Sortie/Squadron/Task Force 설정을 관리하는 중앙 제어판이다.

## 레이아웃

그룹: Strategy / Planning / Operations / Uncategorized
각 행: 슬롯 번호, 캐리어 이름, 모델, Effort, 배지(sortie off / SQ / TF:N)

## 키바인드 (browse 모드)

- ↑↓: 선택 이동
- Enter: 모델 편집
- Tab: 상세 정보 토글
- c: CLI 타입 변경 (단일 캐리어)
- C: CLI 타입 일괄 변경
- R: 모든 캐리어 기본값으로 초기화
- d: Sortie 활성화/비활성화 토글
- S: Squadron 활성화/비활성화 토글
- t: Task Force 설정 오버레이 열기
- Esc / Alt+O: 닫기

## 6개 CLI 백엔드

claude, claude-zai, claude-kimi, codex, gemini, opencode-go

## Task Force 설정 (t 키)

6개 백엔드별 모델과 Effort를 독립적으로 설정.
carrier_taskforce 도구가 크로스 모델 검증 시 사용.
