---
id: "prd-admiral-protocol-single-immutable-fleet-action"
title: "PRD: Admiral Protocol 영역의 Multi-Protocol 추상화 폐기 — Fleet Action을 단일 불변 프롬프트로 단일화"
tags: ["admiral", "protocols", "doctrine", "decision-history", "cognitive-debt"]
created: "2026-05-24T07:51:25.117Z"
updated: "2026-05-24T07:54:50.816Z"
version: 2
rawSourceRef: "raw/2026-05-24-prd-admiral-protocol-single-immutable-fleet-action-source-8a31833c.md"
template_id: "prd"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-24-prd-admiral-protocol-single-immutable-fleet-action-source-b0ee5e98.md\",\"title\":\"PRD: Admiral Protocol 영역의 Multi-Protocol 추상화 폐기 — Fleet Action을 단일 불변 프롬프트로 단일화\",\"hash\":\"b0ee5e98\"},{\"ref\":\"raw/2026-05-24-prd-admiral-protocol-single-immutable-fleet-action-source-8a31833c.md\",\"title\":\"PRD body fix — strip duplicated frontmatter\",\"hash\":\"8a31833c\"}]"
---
## Overview

fleet-harness의 Admiral 프로토콜 영역(`runtime/fleet-cli/src/admiral/protocols/`)에서 기존에 존재하던 **multi-protocol 가정**과 이를 지탱하던 카탈로그/스위칭 추상화를 전면 폐기하고, **Fleet Action Protocol**을 유일하고 불변(immutable single)한 운영 프로토콜로 단일화한 결정의 WHY를 기록한다.

과거에는 여러 프로토콜이 추가될 것을 감안해 `AdmiralProtocol` 인터페이스, `PROTOCOLS` 배열, `getAllProtocols` / `getActiveProtocol` / `setActiveProtocol` API, 그리고 settings.json의 `"admiral"` 키를 둔 카탈로그/스위칭 추상화가 존재했다. 실사용 결과 이 추상화는 **dead code** 상태였으며, doctrine와 코드가 어긋나는 cognitive debt를 야기했다.

## Problem

### 1. 추상화가 실제 사용되지 않음

- **`setActiveProtocol`** — `src/` 전체에서 호출자가 **0건**이었다.
- **`PROTOCOLS` 배열** — 단일 요소(`FLEET_ACTION`)만 포함하는 1-element array였다. `getProtocolById()`는 1개 항목에 대한 linear search였다.
- **`getAllProtocols()`** — system prompt assembler(`admiral/prompts.ts`)에서만 호출되었고, 그마저도 단일 항목을 catalog 형태로 래핑하는 불필요한 구조만 생산했다.
- **`getActiveProtocol()`** — HUD(`fleet-status-section.ts`)와 runtime status API(`runtime/provider.ts`)에서 호출되었으나, 항상 동일한 단일 프로토콜을 반환했다.

### 2. Doctrine-Code mismatch

`AGENTS.md`는 다음을 약속했으나 실제 코드에 전혀 구현되지 않았다:

- `border-bridge` UI 통합 (`setEditorRightLabel`, `setEditorBottomRightLabel`, editor border color API)
- `Alt+1` ~ `Alt+9` 프로토콜 슬롯 전환 키바인딩
- Settings Popup의 "Admiral" 섹션에서의 프로토콜 선택 UI

이는 문서상의 허상(phantom feature)으로, 기여자가 코드를 읽을 때 예상치 못한 불일치를 유발했다.

### 3. 유지 비용 > 확장 옵션 가치

추상화를 유지하면서 얻는 미래 확장 옵션(두 번째 프로토콜 추가 가능성)은, 당시까지 0건의 사용 증거와 함께 다음 비용을 초래했다:

- 불필요한 타입 정의(`AdmiralProtocol`, `ProtocolSettings`)
- 중복 설정 인터페이스(`AdmiralSettings`가 `ProtocolSettings`를 미러)
- system prompt의 불필요한 catalog 래핑 (`## Available Protocols` + per-protocol metadata)
- HUD의 동적 프로토콜 상태 관리 착각 유발

## Goals

1. **Cognitive debt 제거**: 존재하지 않는 기능을 암시하는 추상화와 문서를 제거하여 코드가 실제 동작을 정직하게 반영하도록 한다.
2. **단일 불변 프로토콜 확립**: Fleet Action Protocol을 유일한 운영 프로토콜로 명시하고, 그 본문은 컴파일 시간 상수로 고정한다.
3. **System prompt 평탄화**: protocol catalog 래핑을 제거하고, 프로토콜 본문을 `<fleet section="protocols">`에 직접 인라인한다.
4. **HUD 단순화**: 프로토콜 라벨/색상을 compile-time 상수로 임포트하여 동적 상태 조회를 제거한다.

## Non-Goals

1. **새로운 두 번째 프로토콜 설계** — 본 결정의 시점에는 multi-protocol 확장이 필요하지 않다.
2. **Protocol switching UI 구현** — `Alt+N` 슬롯 전환, Settings Popup 프로토콜 선택 등 과거에 문서만 존재하던 기능을 실제로 구현하지 않는다.
3. **Grand Fleet 프로토콜과의 통합** — `grand-fleet/prompts.ts`의 `FLEET_ACP_PROTOCOL_PROMPT`는 독립된 inline 문자열로 남는다. 이는 Admiral protocol과 다른 관심사를 갖는다.
4. **Standing Orders 구조 변경** — Standing Orders는 cross-cutting이며 protocol-agnostic하므로 그대로 유지된다.

## User Stories

- **기여자**는 `admiral/protocols/` 디렉터리를 열었을 때, 단 하나의 프로토콜 파일(`fleet-action.ts`)과 Standing Orders 디렉터리만 보고 "이 프로젝트는 하나의 프로토콜만 사용하는구나"를 즉시 이해할 수 있다.
- **기여자**는 `AGENTS.md`를 읽었을 때 약속된 기능이 실제 코드에 없는 혼란을 겪지 않는다.
- **향후 maintainer**는 두 번째 프로토콜이 정말 필요해질 경우, 본 엔트리를 참조해 **의식적으로** 추상화를 재도입할지 판단할 수 있다.

## Functional Requirements

### 제거 대상

| 항목 | 위치 | 사유 |
|------|------|------|
| `AdmiralProtocol` interface | `types.ts` (삭제됨) | 단일 구현체를 위한 인터페이스 불필요 |
| `PROTOCOLS` 배열 | `index.ts` (삭제됨) | 1-element catalog |
| `getAllProtocols()` | `index.ts` (삭제됨) | 단일 항목 반환 함수 |
| `getActiveProtocol()` | `index.ts` (삭제됨) | 항상 동일 결과 |
| `setActiveProtocol(id)` | `index.ts` (삭제됨) | 호출자 0건 |
| `getProtocolById(id)` | `index.ts` (삭제됨) | linear search on 1-element array |
| `ProtocolSettings` / `AdmiralSettings` | `index.ts`, `prompts.ts` (삭제됨) | unused settings key `"admiral"` |
| `runtime/provider.ts` | 전체 삭제 | `getActiveProtocol()` 의존 제거 |

### 남는 것 (변경 후)

| 항목 | 위치 | 역할 |
|------|------|------|
| `FLEET_ACTION_PROMPT` | `fleet-action.ts` | 유일한 프로토콜 본문 — system prompt에 직속 인라인 |
| `FLEET_ACTION_LABEL` | `fleet-action.ts` | HUD 표시용 라벨 |
| `FLEET_ACTION_COLOR` | `fleet-action.ts` | HUD ANSI 색상 |
| `standing-orders/` | 디렉터리 유지 | cross-cutting standing orders — protocol-agnostic |
| `completion-report.ts` | 유지 | 완료 보고서 빌더 — standing order와 유사한 위상 |

### 변경 사항

- **`fleet-action.ts`**: `AdmiralProtocol` 타입 의존 제거. `FLEET_ACTION` 객체 리터럴 대신 세 상수(`FLEET_ACTION_PROMPT`, `FLEET_ACTION_LABEL`, `FLEET_ACTION_COLOR`)만 export.
- **`index.ts`**: `PROTOCOLS` 배열, `getAllProtocols`, `getActiveProtocol`, `setActiveProtocol`, `getProtocolById` 제거. `standingOrders`와 completion report 빌더만 re-export.
- **`prompts.ts`**: `getAllProtocols()` 호출 제거. `<fleet section="protocols">` 내부에 `FLEET_ACTION_PROMPT`를 직접 인라인. `AdmiralSettings` 인터페이스 제거.
- **`fleet-status-section.ts`**: `getActiveProtocol()` 대신 `FLEET_ACTION_LABEL` / `FLEET_ACTION_COLOR`를 직접 import.
- **`AGENTS.md`**: 단일 불변 프로토콜 전제로 전면 갱신. border-bridge, Alt+N 슬롯, Settings Popup 등 미구현 기능에 대한 언급 제거.

## Acceptance Criteria

- [x] `AdmiralProtocol` 인터페이스가 `src/`에서 완전히 제거된다.
- [x] `PROTOCOLS` 배열의 길이가 1이 아니라 **존재하지 않는다**.
- [x] `setActiveProtocol`의 호출자가 0건인 상태가 아니라, **함수 자체가 존재하지 않는다**.
- [x] `settings.json`의 `"admiral"` 키를 읽거나 쓰는 코드가 없다.
- [x] `fleet-status-section.ts`가 동적 프로토콜 조회 없이 compile-time 상수를 직접 사용한다.
- [x] System prompt에 `## Available Protocols` catalog가 없고, `FLEET_ACTION_PROMPT`가 직접 인라인된다.
- [x] `AGENTS.md`가 약속한 기능과 실제 코드가 일치한다.

## Open Questions

1. **두 번째 프로토콜 필요성**: 향후 Admiral 영역에 정말로 두 번째 프로토콜(예: 특수 목적 프로토콜, 실험적 프로토콜)이 필요해질 경우, 본 엔트리를 참조해 **의식적으로** `AdmiralProtocol` 인터페이스와 카탈로그를 재도입할 것. 부주의한 부활(unconscious re-introduction)을 방지하는 것이 본 wiki 엔트리의 핵심 목적이다.
2. **Grand Fleet와의 경계**: `grand-fleet/prompts.ts`의 `FLEET_ACP_PROTOCOL_PROMPT`는 Admiral protocol과 별개의 관심사를 갖는다. 향후 이 둘을 통합할 필요가 생긴다면, 그것은 별도의 architectural decision이며 본 결정의 범위를 벗어난다.

## Related

- [[wiki:guide-001-fleet-harness-overview]] — fleet-harness 전체 구조
- [[wiki:prd-core-dismantling-di-architecture]] — fleet-core 도메인 재편과 DI 아키텍처 확립 (동일 시기의 구조적 단순화 흐름)
- `runtime/fleet-cli/src/admiral/protocols/AGENTS.md` — Protocols Doctrine (변경 후 현행 문서)