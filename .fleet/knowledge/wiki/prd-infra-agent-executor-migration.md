---
id: "prd-infra-agent-executor-migration"
title: "PRD: Agent Executor 엔진의 인프라 계층 이전"
tags: ["fleet-core", "fleet-infra", "agent-executor", "package-migration", "architecture", "dependency-injection"]
created: "2026-05-23T05:39:14.652Z"
updated: "2026-05-23T05:40:45.905Z"
version: 1
rawSourceRef: "raw/2026-05-23-prd-infra-agent-executor-migration-source-6de036c4.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-infra-agent-executor-migration-source-6de036c4.md\",\"title\":\"PRD: Agent Executor 엔진의 인프라 계층 이전\",\"hash\":\"6de036c4\"}]"
---
---
id: prd-infra-agent-executor-migration
title: "PRD: Agent Executor 엔진의 인프라 계층 이전"
tags:
  - fleet-core
  - fleet-infra
  - agent-executor
  - package-migration
  - architecture
  - dependency-injection
feature_area: architecture
lifecycle: shipped
created: "2026-05-23T06:00:00.000Z"
updated: "2026-05-23T06:00:00.000Z"
version: 1
---

## Overview

fleet-core의 agent executor 도메인은 런타임 인프라 성격의 코드를 포함하고 있었다. pool 관리, 세션 영속화, drift 감지, 연결 복구 등의 책임은 fleet-infra가 이미 담당하는 auth, job, log, settings와 동일한 host-agnostic runtime infrastructure 계층에 속한다. 이 결정은 해당 executor 엔진과 관련 타입, 내부 모듈을 fleet-infra로 이전하여, "도메인 로직은 fleet-core, 런타임 인프라는 fleet-infra"라는 단일 원칙을 복원한다. 소비자 코드의 import 경로 변경 없이 달성된다.

## Problem

fleet-core의 admiral/agent/ 도메인은 executor 엔진, 세션 영속화, 모델 코덱, 연결 풀 관리 등 런타임 인프라 성격의 코드를 포함하고 있었다. 이들은 fleet-infra가 이미 담당하는 auth, job, log, settings와 동일한 host-agnostic runtime infrastructure 계층에 속함에도, 역사적으로 fleet-core의 admiral 도메인에 남아 있었다.

이로 인해 "도메인 로직"과 "런타임 인프라"의 경계가 모호해져, 새 기여자가 agent 코드를 수정할 때 어느 패키지가 해당 책임의 집인지 판단하기 어려웠다. 구조적 원인은 fleet-infra가 fleet-core에서 처음 분리될 때, executor 엔진이 carrier 도메인과 정적 import로 결합되어 있어 분리 대상에서 제외되었기 때문이다. executor 엔진의 본질적 역할은 인프라 서비스이지 도메인 로직이 아님에도 불구하고, 역사적 관성으로 인해 도메인 패키지에 잔류해 있었다.

## Goals

- fleet-infra가 완전한 runtime infrastructure 계층이 되어, 새 기여자가 코드 위치를 즉시 판단할 수 있게 한다.
- 소비자(fleet-agent)의 import 경로 변경 없이 달성한다.
- executor 엔진의 인프라적 본질을 패키지 경계에 반영한다.

## Non-Goals

- 부트스트랩과 도구 등록 로직의 위치 변경 — 이들은 carrier 메타데이터 읽기와 도구 등록이라는 fleet-core 도메인 책임을 수행하므로 잔류한다.
- public API의 시그니처 변경.
- 새로운 기능 추가나 동작 변경.

## User Stories

- As a new contributor, when I need to fix a session persistence bug, then I can immediately know that the fix belongs in fleet-infra without guessing between fleet-core and fleet-infra.
- As a fleet-agent consumer, when I upgrade the package, then my existing executor import paths continue to work unchanged.
- As a core maintainer, when I review a PR touching pool management, then I expect it to target fleet-infra, not fleet-core.

## Functional Requirements

- Executor 엔진, 연결 관리, 모델 코덱, 세션 런타임, 내부 유틸리티는 fleet-infra의 agent subdomain에 속한다.
- TrackStatus 타입의 단일 진실 공급원(SSoT)은 fleet-infra에 위치하며, fleet-core는 재수출만 한다.
- 외부 MCP 서버 카탈로그 조회는 executor 엔진과 함께 co-migration되어 인프라 계층의 일부가 된다.
- 도구 호출 함수는 fleet-mcp-server를 직접 참조한다.
- carrier 메타데이터 기반의 도구 목록 조회와 MCP 서버 ID 조회는 boot-time 의존성 주입 인터페이스를 통해 제공된다.
- fleet-core의 public barrel은 이전된 모듈을 재수출하여 소비자 경로를 유지한다.

## Acceptance Criteria

- [ ] 소비자(fleet-agent)의 executor 관련 import 경로 변경이 0건인가?
- [ ] 새 기여자가 "인프라는 fleet-infra, 도메인은 fleet-core"라는 단일 원칙으로 코드 위치를 판단할 수 있는가?
- [ ] TrackStatus 타입의 SSoT가 fleet-infra에 위치하고, fleet-core는 재수출만 하는가?
- [ ] executor 엔진이 carrier 메타데이터를 직접 참조하지 않고, boot-time에 주입받는가?
- [ ] 부트스트랩과 도구 등록 로직이 fleet-core에 잔류하여 도메인-인프라 경계를 명확히 하는가?
- [ ] public API 시그니처가 변경되지 않았는가?

## Related

- [[wiki:prd-core-infra-extraction]] — 선행 fleet-infra 추출 PRD
- [[wiki:prd-carrier-persona-extraction]] — 유사 도메인 외부화 패턴