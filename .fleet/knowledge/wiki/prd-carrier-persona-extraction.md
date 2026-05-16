---
id: "prd-carrier-persona-extraction"
title: "Architecture Decision — Carrier Persona Extraction to fleet-carriers"
tags: ["architecture", "carrier", "fleet-carriers", "fleet-core", "refactoring", "decision"]
created: "2026-05-16T05:06:42.017Z"
updated: "2026-05-16T05:06:42.017Z"
version: 1
rawSourceRef: "raw/2026-05-16-prd-carrier-persona-extraction-source-7bec0c22.md"
---
## Overview

Carrier 페르소나 카탈로그를 `packages/fleet-core`에서 분리하여 `packages/fleet-carriers`로 독립 패키지화하는 아키텍처 결정 및 실행 계획.

## Background

fleet-core의 `admiral/carrier/personas/`에 8개 캐리어 페르소나가 하드코딩되어 있음. 각 페르소나는 `CarrierMetadata` 객체(title, summary, category, whenToUse[], whenNotToUse[], requestBlocks[], permissions[], principles[], outputFormat)를 정의. fleet-wiki가 이미 leaf package로 추출되어 동일한 패턴 적용 가능.

## Architecture Decision

**Approach B (Narrow Moderate)** — Nimitz Task Force 3백엔드 만장일치.

### Extraction Scope

| 대상 | 출처 | 목적지 |
|------|------|--------|
| `personas/` 8개 파일 (genesis, kirov, nimitz, sentinel, vanguard, tempest, ohio, chronicle) | `fleet-core/src/admiral/carrier/personas/` | `fleet-carriers/src/personas/` |
| `personas/index.ts` (DEFAULT_CARRIER_PERSONAS, registerDefaultCarrierPersonas) | 동일 | 동일 |
| `CARRIER_JOBS_SELF_CALL_HINT` 상수 | `fleet-core/src/admiral/carrier/prompts.ts` | `fleet-carriers/src/constants.ts` |

### Fleet-core에 잔류하는 것들

- `framework.ts` (393L) — 등록/상태/오프라인/squadron/taskforce 관리
- `tool-spec.ts` (475L) — carrier_dispatch AgentToolSpec + ACP 실행 엔진
- `prompts.ts` 빌더 3개 — buildCarrierSystemPrompt, buildCarrierRoster, formatRequestBlocksGuide
- `prompts.ts` 상수 3개 — CARRIER_FLEET_BACKGROUND, CARRIER_REQUEST_BREVITY_GUIDELINE, PRIOR_JOBS_REQUEST_BLOCK
- `types.ts`, `overlay-types.ts`, `request-blocks.ts`, `sortie-execute.ts`, `status-overlay-controller.ts`, `framework-access.ts`

## Dependency Graph

```
fleet-core (framework/dispatch 유지)
    ↑
    │  workspace:*
    │
fleet-carriers (personas + SELF_CALL_HINT)
    ↑
    │  workspace:* (import만으로 self-register 트리거)
    │
fleet-harness (host wiring)
```

## Registration Pattern

fleet-wiki의 `agent-specs.ts` module-load-time side-effect 패턴을 답습:

1. `fleet-carriers/src/agent-specs.ts`에서 `admiral.carrier.registerCarrier()` 호출
2. `fleet-carriers/src/index.ts`에서 `import "./agent-specs.js"` — import만으로 자가등록
3. `fleet-harness/src/fleet.ts`에서 `import "@sbluemin/fleet-carriers"` 추가

## Execution Plan (5 Waves)

- **Wave 0**: AGENTS/현행 구조 preflight 검증
- **Wave 1**: fleet-carriers 패키지 scaffold (package.json, tsconfig, tsup, AGENTS.md)
- **Wave 2**: personas/ + CARRIER_JOBS_SELF_CALL_HINT 이동, agent-specs.ts 작성
- **Wave 3**: fleet-core persona surface 정리 (personas/ 삭제, prompts.ts 상수 제거)
- **Wave 4**: fleet-harness import wiring (package.json, fleet.ts)
- **Wave 5**: package tests, workspace QA, docs

## QA Gates

- 역방향 의존: `rg "@sbluemin/fleet-carriers" packages/fleet-core` → 0건
- Deep import: `rg "fleet-core/src" packages/fleet-carriers` → 0건
- 페르소나 추출: `fleet-core/src/admiral/carrier/personas/` 존재하지 않음
- 빌드/테스트: fleet-core, fleet-carriers, fleet-harness 각각 typecheck + test + build 통과

## Why Not A or C

- **A (Minimal)**: personas가 `CARRIER_JOBS_SELF_CALL_HINT`를 직접 import하므로 의존을 끊을 수 없음
- **C (Maximal)**: tool-spec.ts/framework.ts가 executor/store/infra/job/log와 깊은 결합 → 이동 시 AGENTS.md Domain Boundary + Facade-First Export Rule 위반. "admiralty 분리 금지" 조항과 충돌

## Related

- Kirov 실행 계획: `.fleet/plans/carrier-persona-extraction.md`
- fleet-wiki 자가등록 선례: [[wiki:guide-003-fleet-wiki]]
- Carrier Status 가이드: [[wiki:guide-002-carrier-status]]