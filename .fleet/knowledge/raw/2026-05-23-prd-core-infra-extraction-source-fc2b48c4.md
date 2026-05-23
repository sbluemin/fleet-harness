---
id: "prd-core-infra-extraction-source"
created: "2026-05-23T04:57:00.412Z"
sourceType: "inline"
title: "fleet-core 인프라 계층 독립 패키지 분리"
tags: ["fleet-core", "fleet-infra", "fleet-agent", "package-extraction", "architecture", "shipped"]
contentHash: "fc2b48c4"
---
# Raw Evidence: fleet-core infra extraction decision

## CHANGELOG [Unreleased] (source of truth for shipped state)

### Added
- Added `@sbluemin/fleet-infra` as the host-agnostic infrastructure package for auth, data-dir, job, log, and settings services.

### Breaking Changes
- Removed `@sbluemin/fleet-core/infra` and fleet-core root infra re-exports; consumers must import infrastructure APIs from `@sbluemin/fleet-infra`.

## Decision Context

fleet-core가 인프라 계층(auth storage, data-dir migration, detached job lifecycle, log store, settings runtime)과 오케스트레이션 계층(admiral, carrier dispatch, protocol execution)을 단일 패키지 안에 혼합하고 있었음. 인프라는 host-agnostic 서비스이지만 fleet-core 안에 묻혀 있어 fleet-agent 같은 소비자가 인프라만 필요할 때도 전체 fleet-core를 통해 간접 접근해야 했음. 이로 인해 패키지 경계가 불분명하고, 의존성 그래프에서 "인프라 서비스" vs "오케스트레이션 로직"의 소유권 구분이 불가능했음. 캐리어 페르소나 외부화와 같은 구조적 분리 철학의 연장선상에서 인프라를 독립 패키지로 분리하기로 결정.

## Effect

- fleet-core는 오케스트레이션 전용 패키지로 책임이 명확해짐
- fleet-agent가 인프라를 직접 참조하여 의존 경로가 단순해짐
- 인프라 변경의 blast radius가 fleet-infra 패키지로 격리됨