---
id: "prd-agent-core-model-bypass"
title: "PRD: fleet-agent --model 옵션과 forwarded 카테고리 도입"
tags: ["agent-core", "fleet-agent", "dedicated-cli", "cli-options", "model-forwarding", "shipped"]
created: "2026-05-23T04:42:11.057Z"
updated: "2026-05-23T04:42:11.057Z"
version: 1
rawSourceRef: "raw/2026-05-23-prd-agent-core-model-bypass-source-028ce468.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-agent-core-model-bypass-source-028ce468.md\",\"title\":\"PRD: fleet-agent --model 옵션과 forwarded 카테고리 도입\",\"hash\":\"028ce468\"}]"
---
## Overview

fleet-agent에 `--model <name>` 옵션이 도입되어, 사용자가 dedicated CLI를 spawn할 때 모델을 CLI 인자 한 줄로 지정할 수 있게 되었다. 이와 함께 `--help` 출력이 "Fleet Agent Options"와 "Underlying CLI Options (forwarded to selected CLI)" 두 카테고리로 영구히 분리되어, 옵션의 소유권 경계가 사용자에게 시각적으로 드러나게 되었다.

이 결정은 fleet-agent가 사용자 인자를 오직 자체 옵션으로만 소비한다는 묵시적 전제를 해체하고, dedicated-cli 경계로 흘려보내는 옵션들의 독립적 카테고리를 공식화한 것이다.

## Problem

fleet-agent가 dedicated-cli를 spawn할 때, 사용자는 첫 spawn 시점에 모델을 고정할 표준 입구가 없었다. dedicated-cli 내부의 `/model` 슬래시 명령이나 별도의 환경 설정에 의존해야 했으며, 자동화나 스크립트 환경에서는 fleet-agent 외부에서 시작 모델을 결정할 수 없었다.

더 깊은 문제는 fleet-agent의 옵션 목록이 모두 fleet-agent 자체가 소비한다는 암묵적 전제에 있었다. 사용자는 "이 옵션이 fleet-agent에 영향을 주는지, 아니면 하위 CLI로 흘러가는지"를 학습할 때 구분할 표면이 없었고, 옵션이 늘어날수록 인지 부담이 누적되었다.

이 증상의 구조적 원인은 fleet-agent의 인자 해석 경계가 dedicated-cli 경계와 명시적으로 분리되어 있지 않았다는 점이다. "사용자가 준 인자는 모두 fleet-agent 자체 옵션이다"라는 묵시적 모델이 옵션 forwarding 통로의 부재를 만들었고, 이는 옵션 소유권을 분리해 보여줄 표면이 없는 상태로 사용자의 학습 비용을 가중시켰다.

## Goals

- dedicated-cli spawn 시점에 모델을 CLI 인자로 직접 지정할 수 있게 한다.
- 옵션 목록을 소비 주체에 따라 시각적으로 분리하여 학습 비용을 낮춘다.
- fleet-agent가 백엔드별 모델 카탈로그를 유지하지 않도록 하여, 새 모델 출시 시에도 fleet-agent 변경을 불필요하게 만든다.
- 사용자가 주입한 모델 값이 fleet-agent의 다른 동작을 우연히 변경하지 않는다는 보장을 확보한다.

## Non-Goals

- unified-agent ConnectionOptions의 전반적인 모델 의미 통일. fleet-agent는 dedicated-cli spawn 경로에만 영향을 준다.
- `-m` short flag 도입. fleet-agent 자체 옵션 확장을 위한 short flag 네임스페이스 보존.
- fleet-agent 내부에서 모델명 유효성 검증. 잘못된 값은 하위 CLI 자체의 에러 메시지로 처리한다.
- dedicated-cli가 아닌 다른 실행 경로에 대한 옵션 forwarding 확장.

## User Stories

- **As a** 사용자, **when** fleet-agent로 dedicated-cli를 띄울 때, **then** `--model claude-sonnet-4-6` 한 줄로 시작 모델을 고정할 수 있다.
- **As a** 운영자, **when** CI 스크립트에서 fleet-agent를 호출할 때, **then** 환경변수나 외부 설정 없이 CLI 인자만으로 모델을 제어할 수 있다.
- **As a** 사용자, **when** `--help`를 입력할 때, **then** "Fleet Agent Options"와 "Underlying CLI Options"가 분리되어 어떤 옵션이 어디로 흘러가는지 한눈에 파악할 수 있다.
- **As a** 사용자, **when** 새로 출시된 모델명을 `--model` 값으로 줄 때, **then** fleet-agent를 업데이트하지 않아도 그 값이 안전하게 하위 CLI로 전달된다.
- **As a** 자동화 도구 운영자, **when** 외부 변수를 `--model` 값으로 주입할 때, **then** 그 값이 fleet-agent 자체의 다른 옵션 의미로 재해석되지 않는다는 보장이 있다.

## Functional Requirements

- `--model <name>` 옵션을 fleet-agent CLI 표면에 노출한다. 값은 dedicated-cli spawn 경로로만 흘러간다.
- `--help` 출력을 "Fleet Agent Options"와 "Underlying CLI Options (forwarded to selected CLI)" 두 섹션으로 분리한다.
- 모델명 값은 fleet-agent가 해석하거나 검증하지 않으며, 사용자가 입력한 문자열 그대로 하위 CLI에 전달된다.
- 사용자가 입력한 모델 값이 fleet-agent의 다른 옵션 파싱 규칙과 충돌하지 않도록 안전하게 격리된다.

## Acceptance Criteria

- [ ] `--model <name>` 옵션을 사용하여 dedicated-cli가 지정된 모델로 시작하는가?
- [ ] `--help` 출력에서 옵션이 두 개의 카테고리로 명확히 분리되어 표시되는가?
- [ ] 존재하지 않는 모델명을 `--model`에 전달했을 때, fleet-agent 자체는 에러를 내지 않고 하위 CLI의 에러 메시지를 그대로 노출하는가?
- [ ] `--model` 값에 특수문자나 긴 문자열이 포함되어도 fleet-agent의 다른 옵션 동작을 변경하지 않는가?

## Related

- [[wiki:guide-001-fleet-harness-overview]] — fleet-harness 전체 구조 입구.