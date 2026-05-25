---
id: "prd-fleet-cli-update-mechanism"
title: "PRD: fleet-cli 자동 업데이트 체크 및 설치 메커니즘"
tags: ["fleet-cli", "update", "npm", "mission-control", "prd", "decision-history", "cognitive-debt"]
created: "2026-05-25T08:53:07.523Z"
updated: "2026-05-25T08:54:05.439Z"
version: 1
rawSourceRef: "raw/2026-05-25-prd-fleet-cli-update-mechanism-source-c2b03b04.md"
template_id: "prd"
confidence: "high"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-25-prd-fleet-cli-update-mechanism-source-c2b03b04.md\",\"title\":\"PRD: fleet-cli 자동 업데이트 체크 및 설치 메커니즘\",\"hash\":\"c2b03b04\"}]"
---
## Overview

fleet-cli와 fleet-wiki-ui는 글로벌 npm 패키지로 배포되며, 사용자가 오래된 버전을 계속 사용하는 상황이 빈번하다. 별도의 업데이트 알림 채널이 없으므로 신규 기능이나 패치가 배포되어도 사용자는 이를 인지하지 못한다. 이 PRD는 Mission Control 환영 화면과 `fleet update` 서브커맨드를 중심으로, 사용자가 자신의 설치 상태를 인지하고 최신 버전으로 전환할 수 있게 하는 업데이트 메커니즘의 설계 결정을 기록한다.

## Problem

- fleet-cli 사용자는 현재 설치된 버전이 최신인지 알 수 없다.
- npm 레지스트리에 신규 버전이 게시되어도, 사용자가 수동으로 `npm view`나 문서를 확인하지 않는 한 이 사실을 인지할 방법이 없다.
- fleet-cli와 fleet-wiki-ui는 동일한 릴리스 사이클을 공유하므로, 하나만 업데이트되고 다른 하나는 낡은 버전이 남아 있는 불일치 상태가 발생할 수 있다.
- 기존에는 업데이트를 유도하는 UI 요소가 전혀 없었다.

## Goals

1. **시각적 인지**: Mission Control 환영 화면에서 현재 버전과 최신 버전을 한눈에 비교할 수 있게 한다.
2. **명령 기반 설치**: `fleet update` 서브커맨드로 패키지 매니저를 자동 감지해 직접 설치를 실행한다.
3. **일관성 유지**: fleet-cli 업데이트 시 동일 버전의 fleet-wiki-ui도 함께 갱신하여 두 패키지 간 버전 불일치를 방지한다.
4. **방해 최소화**: 업데이트 체크는 비동기로 수행되며, 네트워크 실패나 레지스트리 지연은 fleet-cli 본동작에 영향을 주지 않는다.

## Non-Goals

- 로컬 프로젝트 내 의존성(`node_modules` 하위)의 자동 업데이트는 지원하지 않는다. 글로벌 설치 대상만을 다루며, 로컬 범위로의 오판은 치명적일 수 있다.
- Canary 채널 사용자를 Stable로, 또는 그 역으로의 채널 전환은 지원하지 않는다. 동일 채널 내에서의 최신 버전 갱신만을 다룬다.
- `beta` dist-tag를 별도로 인식하거나 fallback으로 사용하지 않는다. 지원 대상은 `latest`와 `canary` 두 태그로 한정한다.
- 업데이트 알림 이외의 버전 관리 기능(롤백, 패치 노트 렌더링, 변경 로그 조회 등)은 포함하지 않는다.

## User Stories

- **Operator**: Mission Control에 진입하면 현재 버전 아래에 "업데이트 가능" 여부가 시선 분리된 강조 라인으로 표시된다. 이는 기존 메뉴 항목과 섞이지 않아 인지 부하가 적다.
- **Operator**: `fleet update`를 입력하면 패키지 매니저가 자동으로 감지되고, 권한이 충분할 경우 설치가 직접 실행된다. 권한이 부족하면 안내 메시지와 함께 필요한 명령을 출력한다.
- **Operator**: 네트워크가 불안정하거나 레지스트리에 접근할 수 없어도, fleet-cli의 다른 모든 동작은 정상적으로 작동한다. 업데이트 체크는 조용히 실패한다.

## Functional Requirements

### UI 표현

- 환영 화면의 counts 라인 아래에 별도의 강조 라인으로 업데이트 알림을 표시한다.
- 인라인 배지나 화살표 기호 대신, 독립된 라인으로 시선 분리를 명확히 한다. 이는 기존 메뉴 항목들과의 혼동을 방지한다.

### 버전 조회

- npm 레지스트리에 native `fetch`와 `AbortController`(3초 타임아웃)를 사용하여 dist-tag 메타데이터를 조회한다.
- `Accept: application/vnd.npm.install-v1+json` 헤더를 사용해 응답 크기를 최소화하고, 정식 설치 메타데이터와 동일한 신뢰도를 확보한다.
- `execSync("npm view")` 대신 HTTP 직접 조회를 선택한 이유는, Node 런타임 내에서 npm CLI의 proxy/auth 상속을 신뢰할 수 없으며, 프로세스 생성 오버헤드와 blocking 특성이 시작 성능을 저하시키기 때문이다.

### 캐싱

- 조회 결과는 1시간 디스크 캐시에 저장한다. 이는 업계 표준(CLI 도구의 일반적인 캐시 주기)을 따르며, 과도한 레지스트리 요청과 느린 시작을 동시에 방지한다.
- 24시간 캐시는 버전 정보가 지나치게 낡을 수 있고, 동기 blocking 조회는 TUI 진입을 지연시키므로 둘 다 채택하지 않았다.
- 캐시 위치는 `getFleetDataDir()` 기반의 `update-check.json`으로, fleet-infra의 설정·인증·로그 파일들과 동일한 디렉터리 컨벤션을 따른다.

### 설치 실행

- `fleet update`는 패키지 매니저를 자동 감지한다. 감지 우선순위와 근거는 Nimitz Task Force의 권고를 따른다.
- 글로벌 설치 여부는 `npm root -g` 및 `pnpm root -g`를 fallback으로 조회한 뒤, realpath prefix 매칭으로 확인한다. 불확실할 경우 설치를 중단하고 안전하게 명령만 출력한다. 이는 사용자 프로젝트의 `node_modules`를 의도치 않게 변경하는 사고를 방지하기 위한 것이다.
- 권한 부족 시 설치를 시도하지 않고, 사용자가 필요한 명령을 직접 실행하도록 안내한다.

### Semver 비교

- `semver` 패키지를 추가 의존성으로 도입하지 않는다. 게시 정책이 `X.Y.Z[-canary.N]` 형태로 단순하므로, 30~40줄 내외의 자체 비교 로직으로 충분하다고 판단했다. 의존성 추가의 가치가 명확하지 않은 상황에서 패키지 설치 foot-print를 늘리는 것을 피한다.

### 채널 판정

- 현재 설치된 버전 문자열에 `-`가 포함되면 `canary` 채널로, 그렇지 않으면 `latest` 채널로 판정한다. 이는 canary 빌드가 사전 릴리스 태그를 항상 포함한다는 게시 규칙에 기반한다.

## Acceptance Criteria

- [ ] Mission Control 환영 화면에 현재 버전과 업데이트 가능 여부가 별도 강조 라인으로 표시된다.
- [ ] `fleet update` 실행 시 패키지 매니저가 자동 감지되고, 권한이 충분하면 설치가 직접 수행된다.
- [ ] 네트워크 실패 시 fleet-cli의 다른 동작에 영향을 주지 않으며, 오류는 조용히 무시된다.
- [ ] 버전 조회 결과는 1시간 캐시에 저장되어 동일 기간 내 반복 조회를 방지한다.
- [ ] fleet-cli 업데이트 시 동일 버전의 fleet-wiki-ui도 함께 갱신된다.
- [ ] 외부 의존성(`semver` 등)이 새로 추가되지 않는다.

## Open Questions

- 캐시 파일 형식(`update-check.json`)이 향후 다른 메타데이터(예: 마지막으로 무시한 버전)를 수용할 수 있도록 확장 설계가 필요한가?
- yarn berry(`yarn dlx` 기반 글로벌 설치) 사용자의 감지 로직은 별도 이슈로 분리하는 것이 적절한가?

## Related

- [[wiki:prd-tui-mission-control]] — 전용 CLI Mission Control 도입
- [[wiki:prd-cli-argv-to-preset]] — fleet-cli CLI argument의 인터랙티브 메뉴 + preset 영속 모델로의 전환