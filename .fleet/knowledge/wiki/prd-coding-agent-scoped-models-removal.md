---
id: "prd-coding-agent-scoped-models-removal"
title: "코딩 에이전트 /scoped-models 제거"
tags: ["coding-agent", "scoped-models", "removal", "model-cycling"]
created: "2026-05-16T03:59:46.982Z"
updated: "2026-05-16T03:59:46.982Z"
version: 1
rawSourceRef: "raw/2026-05-16-prd-coding-agent-scoped-models-removal-source-848ab00e.md"
---
## Overview
본 문서는 `@sbluemin/fleet-coding-agent`에서 `/scoped-models` 슬래시 명령과 관련 UI 컴포넌트를 제거하는 사양을 정의한다. 이는 모델 관리 방식을 시작 시 정의된 글로벌 모델 풀로 단일화하여 사용자 인터페이스의 파편화를 해소하는 것을 목적으로 한다.

## Problem
기존의 `/scoped-models` 전용 UI와 슬래시 명령은 `/model` 명령 및 CLI 플래그와 기능적으로 중복되어 사용자의 설정 인지 부하를 높이고, 모델 관리 경로를 불필요하게 복잡하게 만드는 원인이 되었다.

## Goals
- `/scoped-models`와 관련된 모든 사용자 가시 진입로 및 UI 오버레이 제거.
- 모델 사이클링 풀을 시작 시점의 글로벌 설정(SSoT)으로 단순화.
- 사용되지 않는 관련 키바인딩 정의 삭제.

## Non-Goals
- 메인 에디터의 모델 사이클링(`Ctrl+P` / `Shift+Ctrl+P`) 기능 자체의 제거.
- 표준 모델 전환 명령인 `/model`의 변경.
- 세션 내 모델 사이클 순서 재설정 UI의 부활.

## User Stories
**As a** 사용자, **when** `/`를 입력하여 슬래시 명령 후보를 조회할 때, **then** `/scoped-models`가 더 이상 노출되지 않아 선택지가 간결해진다.
**As a** 운영자, **when** 모델 사이클링 풀을 제한하고 싶을 때, **then** 복잡한 TUI 설정 대신 기존의 `--models` CLI 플래그를 사용하여 일관되게 관리할 수 있다.

## Functional Requirements
- `/scoped-models` 슬래시 명령을 내부 명령어 레지스트리에서 제거한다.
- 전용 모델 선택기(Scoped Models Selector) 오버레이 UI 컴포넌트를 제거한다.
- 선택기 전용으로 할당되었던 키바인딩(`Ctrl+S`, `Ctrl+A`, `Ctrl+X`, `Alt+Up/Down`)을 비활성화하고 정의를 삭제한다.
- 시작 시 `--models` 플래그로 정의된 모델 풀을 보존하며, 이를 `Ctrl+P` 사이클링의 유일한 소스로 활용한다.

## Acceptance Criteria
- [ ] 에디터에서 `/` 입력 시 `/scoped-models` 명령이 자동 완성 목록에 노출되지 않음.
- [ ] `/scoped-models` 명령을 직접 입력하고 실행해도 UI가 호출되지 않거나 무동작함.
- [ ] 기존의 선택기 전용 단축키 입력 시 오버레이 UI가 호출되지 않으며 에러가 발생하지 않음.
- [ ] `--models` 플래그로 지정된 모델들에 대해 메인 에디터의 `Ctrl+P` 사이클링이 정상적으로 작동함.

## Open Questions
- 없음.

## Related
- [[wiki:prd-harness-btw-overlay]]: BTW 오버레이의 모델 선택기는 본 PRD의 제거 범위와 별개의 사용자 인터페이스 표면임.