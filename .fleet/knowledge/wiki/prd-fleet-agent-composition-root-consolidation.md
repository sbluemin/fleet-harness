---
id: "prd-fleet-agent-composition-root-consolidation"
title: "PRD: fleet-agent 내부 Composition Root 확립과 module-level singleton 전면 제거"
tags: ["fleet-agent", "dependency-injection", "composition-root", "architecture", "singleton-elimination", "shipped"]
created: "2026-05-23T12:36:14.913Z"
updated: "2026-05-23T12:39:41.016Z"
version: 1
rawSourceRef: "raw/2026-05-23-prd-fleet-agent-composition-root-consolidation-source-8d7d8d61.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-fleet-agent-composition-root-consolidation-source-8d7d8d61.md\",\"title\":\"PRD: fleet-agent 난집 Composition Root 확립과 module-level singleton 전면 제거\",\"hash\":\"8d7d8d61\"}]"
---
## Overview

fleet-core를 해체하고 fleet-agent를 유일한 Composition Root로 만든다는 상위 아키텍처 방향이 확정된 후에도, fleet-agent 내부에는 여전히 숨은 전역 상태, 모놀리식 부팅 함수, 다중 책임 모듈이 잔존하여 DI 원칙이 형식적으로만 존재하고 실질적으로는 관철되지 않은 상태였다. 이 결정은 그 격차를 해소하여 fleet-agent가 명실상부한 Composition Root로 기능하게 만든 것이다.

## Problem

- **형식적 DI, 실질적 싱글톤**: fleet-agent가 Composition Root로서의 역할을 수행해야 함에도 불구하고, 내부 모듈들이 module-level mutable singleton으로 상태를 관리하여 인스턴스 격리가 불가능하고 테스트 간 상태 누수가 발생했다.
- **모놀리식 부팅**: 부팅 로직이 거대한 단일 함수에 집중되어, 개별 서비스의 초기화 순서와 의존성을 파악하기 어려웠고, 부팅 실패 시 디버깅 비용이 높았다.
- **다중 책임 모듈**: 지나치게 큰 모듈이 여러 도메인의 책임을 동시에 수행하여, 기여자가 코드 위치를 판단하는 데 반복적인 탐색 비용이 발생했다.

구조적 원인은 상위 아키텍처가 팩토리 기반 DI 패턴을 요구했지만, fleet-agent 내부의 구현 관성이 이를 따르지 않았기 때문이다. module-level singleton은 빠른 프로토타이핑과 전역 접근의 편의성을 제공했으나, 이는 fleet-agent가 유일한 조립 루트가 되어야 한다는 아키텍처 원칙과 직접적으로 충돌했다. 특히 fleet-agent가 다른 패키지들을 조립하는 동안 자신의 내부는 여전히 전역 상태에 의존하고 있어, "조립자"가 "조립되지 않은" 역설적 상황이 지속되었다.

## Goals

- fleet-agent 내부의 모든 module-level mutable singleton을 제거하여, 모든 상태가 인스턴스 내부에 캡슐화되게 한다.
- 모놀리식 부팅을 팩토리 기반의 명시적 조립으로 전환하여, 서비스 초기화 순서와 의존성을 투명하게 만든다.
- 다중 책임 모듈을 단일 책임 단위로 분해하여, 기여자가 코드 위치를 즉시 판단할 수 있게 한다.
- fleet-agent가 다른 패키지를 조립하는 것만큼 자신의 내부 구성 요소도 동일한 DI 규약으로 관리하게 한다.

## Non-Goals

- fleet-agent의 public API나 외부 동작 변경.
- 다른 패키지의 DI 패턴 재설계 — 이 결정은 fleet-agent 내부에 국한된다.
- 성능 최적화나 기능 추가.

## User Stories

- **As a** 기여자, **when** fleet-agent 내부에 새로운 서비스를 추가할 때, **then** "팩토리로 생성하고 조립 루트에서 주입한다"는 단일 규칙만 따르면 되며, 숨은 전역 상태를 탐색할 필요가 없다.
- **As a** 테스트 작성자, **when** fleet-agent의 서비스 단위 테스트를 작성할 때, **then** fresh 인스턴스를 생성하여 병렬 실행해도 상태 누수가 발생하지 않는다.
- **As a** 운영자, **when** fleet-agent 부팅이 실패할 때, **then** 개별 서비스 팩토리 단위로 원인을 즉시 추적할 수 있어, 모놀리식 부팅 함수 전체를 디버깅할 필요가 없다.
- **As a** 신규 기여자, **when** fleet-agent 코드베이스를 처음 탐색할 때, **then** 각 모듈이 단일 책임을 가지므로 코드 위치를 즉시 판단할 수 있다.

## Functional Requirements

- fleet-agent의 유일한 조립 루트가 모든 내부 서비스를 명시적 팩토리 호출로 생성하고, 생성된 인스턴스를 의존성 객체로 하향 전달한다.
- 모든 런타임 상태는 팩토리가 반환한 인스턴스 내부에 캡슐화되며, 모듈 수준의 공유 변수는 존재하지 않는다.
- 서비스 해제는 조립의 역순으로 수행되며, 조립 루트가 해제 순서를 명시적으로 관리한다.
- 다중 책임 모듈은 단일 책임 단위로 분해되되, 외부에 노출된 등록 인터페이스는 변경되지 않는다.

## Acceptance Criteria

- [ ] fleet-agent 내부에 module-level mutable singleton이 존재하지 않는가?
- [ ] 조립 루트에서 모든 서비스의 생성과 주입이 명시적으로 이루어지는가?
- [ ] 테스트 환경에서 fresh 인스턴스를 생성하여 상태 격리가 가능한가?
- [ ] 다중 책임 모듈이 단일 책임 단위로 분해되었는가?
- [ ] 기존 외부 동작에 회귀가 없는가?

## Decision Context

이 결정은 Nimitz Task Force 2-backend 교차검증을 통해 기술 경로가 확정되었으며, 4단계 순차 실행 계획으로 구현이 완결되었다. 교차검증에서 두 백엔드 모두 동일한 singleton 제거 순서와 분해 전략에 합의하였고, 독립적인 singleton부터 시작하여 의존성이 가장 넓은 핵심 런타임 singleton을 마지막에 처리하는 단계적 접근이 채택되었다.

## Related

- [[wiki:prd-core-dismantling-di-architecture]] — 상위 아키텍처 방향
- [[wiki:prd-core-infra-extraction]] — 인프라 계층 분리
- [[wiki:prd-carrier-runtime-migration]] — 캐리어 런타임 이전
- [[wiki:prd-infra-agent-executor-migration]] — 에이전트 실행기 이전
- [[wiki:prd-carrier-persona-extraction]] — 페르소나 외부화