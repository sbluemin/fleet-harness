---
id: "prd-core-dismantling-di-architecture"
title: "PRD: fleet-core 도메인 재편과 의존성 주입 아키텍처 확립"
tags: ["fleet-core", "fleet-admiral", "fleet-admiralty", "fleet-carriers", "fleet-infra", "fleet-agent", "dependency-injection", "architecture", "package-dissolution"]
created: "2026-05-23T07:44:05.795Z"
updated: "2026-05-23T07:52:08.995Z"
version: 1
rawSourceRef: "raw/2026-05-23-prd-core-dismantling-di-architecture-source-e3b0c442.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-core-dismantling-di-architecture-source-e3b0c442.md\",\"title\":\"PRD: fleet-core 해체 및 순수 팩토리 DI 아키텍처 전환\",\"hash\":\"e3b0c442\"}]"
---
## Overview

fleet-core를 완전히 해체하고, 그 역할을 fleet-admiral과 fleet-admiralty 두 패키지로 재편하며, 전체 워크스페이스를 순수 팩토리 기반 DI 패턴으로 통일하는 결정입니다. 이 결정은 fleet-core의 인프라 계층 분리, 에이전트 실행기 이전, 캐리어 런타임 이전, 페르소나 외부화라는 네 건의 선행 구조 조정이 마련한 자리에서, 남은 중심 패키지를 완전히 제거하고 최종적인 의존성 구조를 확립하는 것입니다.

## Problem

- **책임 과부하**: fleet-core가 단일 함대 오케스트레이션, 다중 함대 조정, 캐리어 런타임, 페르소나 메타데이터를 동시에 소유하여, 기여자가 코드 위치를 판단하는 데 반복적인 탐색 비용이 발생했습니다.
- **순환 긴장**: fleet-core와 fleet-carriers가 서로를 참조하는 양방향 의존이 지속되어, 캐리어 변경 시 항상 두 패키지를 동시 수정해야 하는 cognitive debt가 발생했습니다.
- **전역 상태 오염**: 모듈 레벨 싱글톤, globalThis, import 시점 자동 등록이 패키지 전반에 퍼져 테스트 격리가 불가능하고, 부팅 순서가 묵시적 의존성에 의해 결정되었습니다.

구조적 원인은 fleet-core가 오케스트레이션, 인프라, 캐리어 런타임, 페르소나라는 네 종류의 관심사를 동시에 소유하고 있었기 때문입니다. 특히 인프라와 캐리어 런타임이 이미 각자의 패키지로 이전된 후에도, 남은 오케스트레이션 로직이 여전히 넓은 범위의 책임을 띠고 있어 단일 패키지로서의 정체성이 모호해졌습니다. 이는 패키지가 "무엇을 하는가"가 아닌 "무엇이 남았는가"로 정의되는 상태를 만들었고, 이것이 신규 기여자의 학습 곡선을 가팔라게 만든 핵심 cognitive debt였습니다.

## Goals

- fleet-core를 완전히 제거하고, 단일 함대 오케스트레이션 책임은 fleet-admiral에, 다중 함대 조정 책임은 fleet-admiralty에 할당합니다.
- 모든 패키지가 Port 인터페이스 + Config 타입 + 팩토리 함수(create*)를 export하는 순수 팩토리 DI 패턴으로 통일합니다.
- fleet-agent가 유일한 Composition Root가 되어 모든 서비스를 조립합니다.
- 모듈 레벨 싱글톤, globalThis 상태, import 시점 자동 등록을 완전히 제거합니다.
- 영속화를 I/O 게이트웨이 계층과 도메인 저장소 계층의 이중 구조로 분리하여 충돌을 방지합니다.
- 패키지 간 의존성을 단방향으로 확립하여 순환 긴장을 영구히 해소합니다.

## Non-Goals

- fleet-core를 thin re-export facade로 유지하는 중간 단계 — 이 결정은 즉시 완전 제거를 목표로 합니다.
- 외부 소비자를 위한 별도 마이그레이션 가이드 — fleet-agent가 유일한 소비자이므로 하위 호환성은 모노레포 단일 소비자 구조에서 별도 관리가 불필요합니다.
- 새로운 기능 추가나 동작 변경 — 아키텍처 재편에 집중하며, 기존 동작은 그대로 유지합니다.
- fleet-carriers의 페르소나 카탈로그 구조 변경.
- fleet-infra의 인프라 서비스 API 변경.

## User Stories

- **As a** 함대 운영자, **when** 새로운 캐리어를 추가할 때, **then** fleet-carriers 패키지 안에서 페르소나 정의와 런타임 등록을 완료할 수 있으며, 다른 패키지를 열 필요가 없습니다.
- **As a** 개발자, **when** 단일 함대의 오케스트레이션 로직을 수정할 때, **then** fleet-admiral만 열고, 다중 함대 조정 로직은 fleet-admiralty에 있다는 것을 즉시 알 수 있습니다.
- **As a** 기여자, **when** 코드베이스를 처음 탐색할 때, **then** "fleet-admiral은 단일 함대, fleet-admiralty는 다중 함대, fleet-carriers는 캐리어, fleet-infra는 인프라"라는 단일 규칙으로 코드 위치를 즉시 판단할 수 있습니다.
- **As a** 테스트 작성자, **when** 캐리어 프레임워크 단위 테스트를 작성할 때, **then** 전역 상태 없이 fresh 인스턴스를 생성하고 격리하여 안전하게 병렬 실행할 수 있습니다.
- **As a** 함대 운영자, **when** TaskForce 설정을 변경할 때, **then** 도메인 저장소 파일만 편집하고, I/O 게이트웨이 파일은 건드리지 않습니다.

## Functional Requirements

- **완전 해체**: fleet-core는 재수출 파사드 없이 완전히 삭제됩니다. 모든 도메인은 fleet-admiral 또는 fleet-admiralty로 이전됩니다.
- **fleet-admiral 범위**: 단일 함대 오케스트레이션, 프로토콜 정의, 프롬프트 정책, MCP 생명주기, 에이전트 부트스트랩을 소유합니다.
- **fleet-admiralty 범위**: 다중 함대 조정, IPC, Grand Fleet 상태, 보고를 소유합니다.
- **팩토리 DI 패턴**: 모든 패키지는 Port 인터페이스, Config 타입, 팩토리 함수(create*)를 export합니다. 서비스 인스턴스는 호출자가 생성하여 주입합니다.
- **유일한 조립 루트**: fleet-agent가 유일한 Composition Root로서, 모든 팩토리를 호출하고 서비스를 조립합니다.
- **전역 상태 금지**: 모듈 레벨 싱글톤, globalThis 상태, import 시점 자동 등록은 허용되지 않습니다. 모든 상태는 인스턴스 내부에 캡슐화됩니다.
- **단방향 의존성**: fleet-agent → fleet-admiralty → fleet-admiral → fleet-carriers → fleet-infra 방향으로 의존성이 흐르며, 역방향 참조는 없습니다.
- **저장소 이중 계층**: I/O 게이트웨이는 fleet-infra에 위치하여 파일 잠금과 원자적 쓰기를 담당합니다. 도메인 저장소는 fleet-carriers에 위치하여 모델 선택, CLI 타입, TaskForce 설정 등의 도메인별 영속화를 담당합니다.
- **동작 보존**: 기존 public API의 서명과 런타임 동작은 변경되지 않습니다. 소비자가 감지할 수 있는 차이는 없어야 합니다.

## Acceptance Criteria

- [ ] fleet-core 패키지가 완전히 삭제되고, 남은 코드가 fleet-admiral 또는 fleet-admiralty로 이전되었는가?
- [ ] 모든 패키지가 Port 인터페이스 + Config 타입 + 팩토리 함수 형태로 서비스를 export하는가?
- [ ] fleet-agent가 유일한 Composition Root로서 모든 서비스를 조립하는가?
- [ ] 모듈 레벨 싱글톤, globalThis 상태, import 시점 자동 등록이 완전히 제거되었는가?
- [ ] 저장소가 I/O 게이트웨이(fleet-infra)와 도메인 저장소(fleet-carriers)로 분리되어 운영되는가?
- [ ] 패키지 간 의존성이 fleet-agent → fleet-admiralty → fleet-admiral → fleet-carriers → fleet-infra 단방향으로 확립되었는가?
- [ ] 소비자(fleet-agent)의 기존 동작에 회귀가 없는가?
- [ ] 테스트 환경에서 fresh 인스턴스 생성 및 격리가 가능한가?

## Open Questions

- 없음. 아키텍처 방향은 Nimitz Task Force 3백엔드 교차검증(claude, codex, cursor)을 통해 확정되었으며, DI 패턴과 2:1 다수결로 저장소 이중 계층 및 즉시 삭제 전략이 채택되었습니다.

## Related

- [[wiki:prd-core-infra-extraction]] — 인프라 계층 분리 선행 결정
- [[wiki:prd-infra-agent-executor-migration]] — 실행기 엔진 이전 선행 결정
- [[wiki:prd-carrier-runtime-migration]] — 캐리어 런타임 이전 선행 결정
- [[wiki:prd-carrier-persona-extraction]] — 페르소나 외부화 선행 결정