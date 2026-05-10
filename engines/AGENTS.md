# Fleet Engines

> 이 디렉토리는 Fleet 핵심 엔진 패키지 모음입니다.
> 각 패키지는 선언된 경계 안에서 직접 개발·수정할 수 있으며, 변경 후에는 해당 wave의 빌드/테스트 게이트를 통과해야 합니다.

## Identity

| 항목 | 값 |
|------|-----|
| 엔진 기반 | `pi-coding-agent` 파생 Fleet 엔진 컬렉션 |
| 현재 엔진 버전 기준선 | **`0.74.0`** |
| 정렬 일자 | 2026-05-09 기준 |
| 로컬 패키지 스코프 | `@sbluemin/fleet-*` |

## Engine Packages

| 로컬 패키지명 | 엔진 경로 | 버전 |
|---------------|---------------|------|
| `@sbluemin/fleet-coding-agent` | `packages/coding-agent/` | `0.74.0` |
| `@sbluemin/fleet-ai` | `packages/ai/` | `0.74.0` |
| `@sbluemin/fleet-agent-core` | `packages/agent/` | `0.74.0` |
| `@sbluemin/fleet-tui` | `packages/tui/` | `0.74.0` |

## Scope Boundaries

- `fleet-core`는 이 디렉토리를 직접 import하지 않습니다 — 오직 `workspace:*` 링크를 통해 종속성으로 참조합니다.
- `fleet-harness-extension`은 `fleet-core`의 public API를 통해서만 이 런타임에 접근합니다.
- 이 디렉토리 내에서 `@mariozechner/pi-*` 또는 `@anthropic-ai/*` 등 Pi 전용 패키지로의 직접 import는 허용되지 않습니다 (이미 업스트림에서 제거됨).

## Working Rules

- 엔진 패키지 수정은 허용되지만, 각 wave에서 요구한 빌드/테스트/grep 게이트를 먼저 닫아야 합니다.
- 패키지명, 빌드 도구, tsconfig 경로 맵은 엔진 subtree 전반에서 Fleet 컨벤션과 일치해야 합니다.
- 업스트림 계보나 과거 차이는 `CHANGELOG.md`와 관련 문서에서 다루되, 이 디렉토리 자체를 읽기 전용 영역으로 취급하지 않습니다.
