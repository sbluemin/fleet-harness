---
id: "prd-tui-keyboard-protocol-architecture"
title: "PRD: Fleet TUI Keyboard Protocol & Keybinding Registry Architecture"
tags: ["fleet-tui", "fleet-agent", "keyboard-protocol", "keybinding", "dependency-injection", "architecture", "shipped"]
created: "2026-05-23T14:33:13.966Z"
updated: "2026-05-23T14:44:24.303Z"
version: 2
rawSourceRef: "raw/2026-05-23-prd-tui-keyboard-protocol-architecture-source-9a350656.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-tui-keyboard-protocol-architecture-source-d31b5299.md\",\"title\":\"prd-tui-keyboard-protocol-architecture-source\",\"hash\":\"d31b5299\"},{\"ref\":\"raw/2026-05-23-prd-tui-keyboard-protocol-architecture-source-9a350656.md\",\"title\":\"prd-tui-keyboard-protocol-architecture-restructured\",\"hash\":\"9a350656\"}]"
---
## Overview

Fleet TUI는 외부 터미널의 키보드 프로토콜을 직접 제어하고, 호스트 키바인딩 레지스트리를 입력 라우팅 계층에 배치하는 아키텍처를 확립했다. 이 결정은 다중 자식 프로세스가 동시에 활성화된 터미널 환경에서 발생하는 프로토콜 상태 충돌, 키 입력 무단 가로채기, 정규화 오류 등의 인지 부채를 해소하기 위해 남겨졌다.

## Problem

이전에는 다음과 같은 마찰이 지속적으로 발생했다.

프로토콜 상태 추적의 복잡성이 있었다. 외부 터미널의 키보드 확장 프로토콜 상태를 여러 자식 프로세스 각각이 개별적으로 관리하려 했으며, 이로 인해 상태 불일치와 예측 불가능한 키 입력 해석이 빈번했다.

키 입력 충돌 위험이 있었다. 호스트 단축키와 전용 CLI에 전달되어야 할 키 시퀀스를 구분하는 정책이 없어, 호스트가 의도치 않게 전용 CLI의 입력을 가로채거나 역으로 전용 CLI가 호스트 단축키를 소비하는 사례가 반복됐다.

이중 갱신 지점이 존재했다. 새로운 단축키를 추가할 때 레거시 형식 표현과 CSI-u 형식 표현을 별도의 두 위치에서 수동으로 갱신해야 했기 때문에 Single Source of Truth 원칙이 깨지고 누락이 발생했다.

도메인 경계 혼란이 있었다. keybinding 레지스트리와 도메인별 단축키 정의를 어떤 패키지가 소유해야 하는지에 대한 합의가 없어, 인프라 계층과 TUI 엔진 사이에 책임이 흐트러져 있었다.

이러한 마찰의 구조적 원인은 책임 분리 원칙의 미확립이었다. 터미널 키보드 프로토콜은 TUI 엔진의 입력 표면에 속하는데, 이를 자식 프로세스에게 위임하려는 시도는 누가 외부 터미널을 제어하는가라는 근본 질문에 대한 답을 회피한 것이었다. 키 입력 정규화 범위를 전역으로 확대하려는 접근은 어떤 키 시퀀스가 호스트용이고 어떤 것이 자식용인가를 구분하지 않은 결과였다. keybinding 정의를 인프라 패키지에 두려는 시도는 carrier-status 전환, 모드 토글 같은 도메인 정책을 host-agnostic 인프라에 밀어넣는 도메인 경계 침범이었다. 두 가지 표현 형식을 독립적으로 관리하는 방식은 단축키의 의미는 하나인데 표현은 두 개라는 사실을 데이터 모델에 반영하지 못한 설계 결함이었다.

## Goals

- 다중 자식 프로세스 환경에서 키보드 프로토콜 상태의 일관성을 확보하여, 상태 불일치로 인한 예측 불가능한 입력 해석을 제거한다.
- 호스트 단축키와 전용 CLI 입력을 명확히 분리하여, 키 입력의 의도치 않은 가로채기 및 충돌을 방지한다.
- 단축키 정의의 Single Source of Truth를 확립하여, 새 단축키 추가 시 하나의 정의 지점만 갱신하게 한다.
- keybinding 레지스트리, 도메인 정의, 인프라 계층의 책임을 명확히 분리하여 코드 배치 결정과 패키지 간 의존성 판단을 단순화한다.

## Non-Goals

- 외부 터미널 에뮬레이터나 멀티플렉서 자체의 키보드 프로토콜 표준 변경.
- 전용 CLI의 낮은 수준 키 입력 해석 동작 변경.
- 키바인딩 표현 형식 자체의 새로운 표준 도입.
- TUI 엔진 이외의 입력 표면 확장.

## User Stories

- **As a** 운영자, **when** 다중 자식 프로세스가 동시에 활성화된 터미널에서 Fleet TUI를 사용할 때, **then** 키 입력이 의도치 않게 가로채지거나 충돌하지 않는다.
- **As a** 기여자, **when** 새로운 호스트 단축키를 추가할 때, **then** 하나의 정의 지점만 갱신하면 되며 별도의 파생 표현을 수동으로 동기화할 필요가 없다.
- **As a** 기여자, **when** 키 입력 라우팅 관련 코드를 탐색할 때, **then** keybinding 레지스트리와 도메인 정의, 인프라 계층의 책임이 명확히 분리되어 있어 코드 위치를 즉시 판단할 수 있다.
- **As a** 운영자, **when** tmux 내 터미널에서 Fleet TUI를 사용할 때, **then** 확장 키가 정상적으로 작동한다.

## Functional Requirements

- Fleet TUI는 외부 터미널의 키보드 확장 모드를 직접 활성화하고 비활성화한다. 자식 프로세스를 통한 간접 제어는 배제된다.
- modifyOtherKeys mode 2와 kitty keyboard protocol progressive enhancement push를 동시에 활성화하여, tmux 환경과 네이티브 터미널 환경 모두에서 확장 키를 커버한다.
- 호스트 단축키로 등록된 키 조합에 대해서만 선택적으로 정규화를 적용하며, 전용 CLI로 전달되는 고급 키 시퀀스는 손상되지 않도록 보존한다.
- keybinding 레지스트리는 TUI 입력 라우팅 계층에 배치되며, 인프라 계층이 아닌 TUI 엔진의 핵심 구성 요소로 취급된다.
- 도메인 특화 단축키 정의는 host assembly 지점에 배치되며, keybinding의 기계적 라우팅과 단축키가 수행하는 도메인 동작이 분리된다.
- 정규화에 필요한 레거시-CSI-u 대응 맵은 수동으로 이중 관리하지 않고, 등록된 keybinding 정의로부터 자동으로 파생된다.

## Acceptance Criteria

- [ ] TUI가 외부 터미널의 키보드 확장 모드를 직접 제어하는가?
- [ ] modifyOtherKeys와 kitty push가 동시에 활성화되어 tmux와 네이티브 터미널 모두에서 확장 키가 작동하는가?
- [ ] 호스트 단축키만 선택적으로 정규화되고 전용 CLI 입력은 손상되지 않는가?
- [ ] keybinding 레지스트리가 TUI 입력 계층에 위치하는가?
- [ ] 도메인 특화 단축키 정의가 host assembly 지점에 위치하는가?
- [ ] 단축키 추가 시 하나의 정의 지점만 갱신하면 되는가?

## Decision Context

이 결정은 다음과 같은 제약과 합의 하에 남겨졌다.

tmux 호환성이 강제되었다. Fleet TUI는 tmux 내 터미널 환경에서도 동작해야 했다. tmux는 kitty keyboard protocol의 progressive enhancement push를 인식하지 못하므로, 별도의 확장 키 트리거 메커니즘이 필요했다.

전용 CLI 입력 보존이 요구되었다. 전용 CLI는 CSI-u 형식의 고급 키 시퀀스를 직접 수신하고 해석할 수 있어야 했다. 따라서 호스트가 모든 CSI-u 시퀀스를 레거시로 되돌리는 방식은 수용 불가능했다.

Composition Root 원칙이 확립되어 있었다. 도메인별 keybinding 정의는 host assembly 지점에 배치되어야 한다는 원칙이 이미 존재했으며, 인프라 계층이나 TUI 엔진이 carrier-status나 모드 전환 같은 도메인 개념을 알게 해서는 안 된다는 것이 팀 내 합의였다.

Single Source of Truth가 엄수되어야 했다. keybinding 정의가 한 곳에만 존재해야 하며, 파생 표현은 자동으로 생성되어야 한다는 요구가 강화되었다.

이러한 제약 하에 다음과 같은 결정이 남겨졌다.

TUI가 외부 터미널의 키보드 프로토콜을 직접 소유하기로 했다. 자식 프로세스를 통해 간접 제어하는 proxy 방식을 배제하고, Fleet TUI가 외부 터미널의 키보드 확장 모드를 직접 활성화 및 비활성화한다. 이로써 N개 자식 프로세스의 개별 프로토콜 상태 추적 및 동기화라는 비선형적 복잡도를 제거하고, TUI가 키보드 제어권의 유일한 책임 주체가 되도록 했다.

이중 프로토콜 동시 활성화를 채택했다. modifyOtherKeys mode 2와 kitty keyboard protocol progressive enhancement push를 동시에 전송한다. tmux 환경에서는 tmux가 kitty push를 무시하고 modifyOtherKeys만 처리하여 확장 키를 트리거하며, 네이티브 터미널에서는 kitty push를 통해 더 풍부한 키 보고를 수신한다. 이로써 단일 코드 경로로 다양한 터미널 에뮬레이터 및 멀티플렉서를 커버한다.

선택적 CSI-u 정규화를 적용하기로 했다. 모든 CSI-u 시퀀스를 레거시 바이트로 되돌리는 broad normalization을 배제하고, Fleet 호스트 단축키로 등록된 키 조합에 대해서만 선택적으로 정규화를 적용한다. 전용 CLI로 전달되는 CSI-u 시퀀스는 손상되지 않도록 보존하여, 전용 CLI가 자체적으로 고급 키 입력을 해석할 수 있는 권한을 유지한다.

Keybinding 레지스트리는 TUI 입력 계층에 속하기로 했다. 인프라 계층이 아닌 TUI 입력 라우팅 계층에 배치하며, keybinding은 입력 라우팅 인프라이며 TUI 엔진의 핵심 구성 요소이지 host-agnostic 인프라의 범주가 아니라는 도메인 경계를 확립한다.

도메인별 keybinding 정의는 Composition Root에 속하기로 했다. carrier-status 전환, 모드 토글 등 도메인 특화 단축키 정의는 인프라 계층이나 TUI 엔진에서 분리하여 host assembly 지점에 배치한다. 이는 keybinding의 기계적 라우팅과 단축키가 수행하는 도메인 동작이라는 두 가지 관심사를 분리한다.

CSI-u 정규화 맵은 등록된 keybinding에서 자동 파생되기로 했다. 정규화에 필요한 레거시-CSI-u 대응 맵을 수동으로 이중 관리하지 않고, 레지스트리에 등록된 keybinding 정의로부터 자동으로 파생한다. 새로운 단축키를 추가할 때 별도의 두 번째 갱신 지점이 사라지고, 단축키 의미의 Single Source of Truth가 보장된다.

다음과 같은 대안은 검토 후 거부되었다.

자식 프로세스 프로토콜 proxy는 N개 자식의 개별 프로토콜 상태 추적 및 동기화 복잡도가 비선형적으로 증가하며, TUI의 키보드 제어권을 위임하는 구조적 모순이 있어 거부되었다.

kitty push only는 tmux가 kitty keyboard protocol push를 무시하므로 tmux 환경에서 확장 키가 전혀 작동하지 않아 거부되었다.

broad CSI-u normalization은 전용 CLI의 정상 입력을 파괴하여 거부되었다.

인프라 계층 keybinding 레지스트리는 도메인 경계 침범이어서 거부되었다.

인프라 계층 기본 단축키 정의는 도메인 지식을 인프라에 밀어넣는 것이어서 거부되었다.

하드코딩된 이중 대응 맵은 Single Source of Truth 위반이어서 거부되었다.

## Related

- [[wiki:prd-fleet-agent-composition-root-consolidation]] — Composition Root 확립과 module-level singleton 제거 원칙
- [[wiki:prd-core-dismantling-di-architecture]] — DI 아키텍처 확립과 도메인 경계 재편
- [[wiki:guide-002-carrier-status]] — Carrier Status 기능의 사용자 가이드