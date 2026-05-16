---
id: "prd-carrier-persona-extraction-source"
created: "2026-05-16T05:06:42.017Z"
sourceType: "inline"
title: "Architecture Decision — Carrier Persona Extraction to fleet-carriers"
tags: ["architecture", "carrier", "fleet-carriers", "fleet-core", "refactoring", "decision"]
contentHash: "7bec0c22"
---
# Carrier Persona Extraction — Architecture Decision Record

## Decision Date: 2026-05-16

## Context
Carrier 페르소나 데이터(8개 캐리어 메타데이터 + 공유 상수)가 fleet-core에 내장되어 있어, 새로운 캐리어 추가 시 fleet-core 수정이 필요함. fleet-wiki가 이미 leaf package로 추출된 선례가 있어, 동일한 패턴으로 페르소나 카탈로그를 독립 패키지로 분리하기로 결정.

## Decision
Approach B (Narrow Moderate) 채택:
- personas/ 디렉토리 전체(8개 페르소나 + index.ts)와 CARRIER_JOBS_SELF_CALL_HINT 상수만 fleet-carriers로 이동
- framework.ts, tool-spec.ts, prompts.ts 빌더 함수는 fleet-core에 잔류
- fleet-wiki agent-specs.ts side-effect 자가등록 패턴 답습

## Extraction Scope
- 이동: personas/*.ts (8개), personas/index.ts, CARRIER_JOBS_SELF_CALL_HINT
- 잔류: framework.ts, tool-spec.ts, types.ts, prompts.ts (빌더 3개 + 상수 3개), overlay-types.ts, request-blocks.ts, sortie-execute.ts, status-overlay-controller.ts, framework-access.ts

## Dependency Direction
fleet-carriers → @sbluemin/fleet-core (단방향만 허용, 역방향 import 절대 금지)

## Alternatives Considered
- A (Minimal): personas만 이동 — 페르소나가 CARRIER_JOBS_SELF_CALL_HINT를 import하므로 의존을 못 끊음
- C (Maximal): carrier/ 전체 이동 — tool-spec/framework의 executor/store/infra 깊은 결합으로 AGENTS 위반