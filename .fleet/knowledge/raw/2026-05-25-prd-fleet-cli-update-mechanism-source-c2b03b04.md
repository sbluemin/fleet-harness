---
id: "prd-fleet-cli-update-mechanism-source"
created: "2026-05-25T08:53:07.523Z"
sourceType: "inline"
title: "PRD: fleet-cli 자동 업데이트 체크 및 설치 메커니즘"
tags: ["fleet-cli", "update", "npm", "mission-control", "prd", "decision-history", "cognitive-debt"]
contentHash: "c2b03b04"
---
## 사용자 결정사항 (Admiral 결정)

1. UI: Option B 채택 — counts 라인 아래 별도 강조 라인 `◆ Update available — vX.Y.Z (channel)`. 인라인 배지(A/D)·화살표(C) 후보 중 시선 분리 명확성 우선.
2. `fleet update` 동작: 직접 설치 실행. 패키지 매니저 자동 감지, 권한 부족 시 안내 폴백.
3. 버전 체크: 비동기 + 1시간 디스크 캐시. 업계 표준 패턴 채택.
4. wiki-ui 동시 갱신: `@dotobokuri/fleet-wiki-ui`도 자동 동시 설치. 두 패키지 동일 버전 동기 게시.

## Nimitz Task Force(Claude+Codex) 권고 → Admiral 채택

- HTTP 조회: native `fetch` + AbortController 3s + `Accept: application/vnd.npm.install-v1+json`. `execSync("npm view")`는 proxy/auth 상속 우위 있으나 시작 성능·신뢰성에서 열위.
- semver 비교: 자체 30~40줄 구현. 게시 정책이 `X.Y.Z[-canary.N]`로 단순해 의존성 가치 불명확.
- 캐시 위치: `getFleetDataDir()`/`update-check.json` (~/.fleet). fleet-infra 설정/auth/logs와 동일 디렉터리 컨벤션.
- 글로벌 설치 감지: `npm root -g` + `pnpm root -g` fallback, realpath prefix 매칭. 불확실 시 안전 abort + 명령 출력만 — 사용자 프로젝트 node_modules 오변경 방지.

## Non-goals

- 로컬 의존성 자동 업데이트 (오판 위험).
- canary↔stable 채널 점프 (동일 채널 내 최신만).
- `beta` dist-tag 인식 (fallback 미사용).

## Constraints

- 네트워크 실패 시 fleet-cli 본동작 영향 0 (silent degrade).
- Node ≥ 18.
- 외부 deps 추가 0건.

## dist-tag 매핑

`version.includes("-") → canary`, else → `latest`.