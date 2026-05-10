# Fleet Engines

> 이 디렉토리는 Fleet 핵심 엔진 패키지 모음입니다.
> 각 패키지는 선언된 경계 안에서 직접 개발·수정할 수 있으며, 변경 후에는 해당 wave의 빌드/테스트 게이트를 통과해야 합니다.

## Domain Agnosticism (최상위 규칙)

> **Engines는 Fleet 도메인을 알지 않는다.**
>
> 이 규칙은 본 문서의 다른 모든 항목에 우선한다. `Scope Boundaries`·`Working Rules`와 충돌할 경우 이 규칙이 승리한다.

- 이 디렉토리의 모든 패키지(`fleet-coding-agent`, `fleet-ai`, `fleet-agent-core`, `fleet-tui`)는 Fleet 도메인 식별자·로직·의미를 코드·타입·상수·문서에 포함하지 않는다.
- **금지 대상**: carrier ID(`nimitz`, `kirov`, `genesis`, `ohio`, `sentinel`, `vanguard`, `tempest`, `chronicle` 등), `host:<cli>` 키 패턴, `admiral`/`fleet_*`/`carrier_*` 등 Fleet 페르소나·프로토콜·매핑을 직접 가리키는 메서드·필드·문자열·타입.
- **Fleet 도메인 영속·확장이 필요할 때**: 엔진은 도메인 무지의 **generic 확장 지점**만 제공한다. 예: `SessionManager.appendCustomEntry(customType, data)`, `CustomEntry`/`CustomMessageEntry`의 `customType` 문자열, 제네릭 `details?: T`. `customType` 문자열의 의미는 호출자(`fleet-core`)에서만 정의·해석하며, 엔진 코드는 이 문자열을 해석하지 않는다.
- **호환성 시험**: 엔진 API에 시그니처를 추가·변경할 때마다 "Fleet 외부의 임의 컨슈머가 동일 엔진을 그대로 사용할 수 있는가"를 자가 점검한다. 답이 "아니오"이면 그 시그니처는 도메인이 침투한 것이며 거절한다.
- **위반 예**: `appendCarrierMapping()`·`getCarrierMapping()` 같은 Fleet-aware 메서드 추가, 엔진 내부에 `customType: "fleet_carrier_mapping"` 상수 박기, 엔진 타입에 `carrierId`·`hostCli` 필드 추가, 엔진 문서/주석에 carrier ID 예시를 박아 기본 사용처로 암시하기.
- **준수 예**: fleet-core가 `sessionManager.appendCustomEntry("fleet/carrier-map", { op, key, sid })`로 호출하고, 엔진은 그 customType 문자열의 의미를 전혀 모름.
- **운영 지점**: 신규 엔진 PR/wave에서는 도메인 무지 자가 점검 결과를 변경 노트에 1줄로 명시한다(예: "no fleet-domain identifiers introduced").

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
- `fleet-harness`은 `fleet-core`의 public API를 통해서만 이 런타임에 접근합니다.
- 이 디렉토리 내에서 `@mariozechner/pi-*` 또는 `@anthropic-ai/*` 등 Pi 전용 패키지로의 직접 import는 허용되지 않습니다 (이미 업스트림에서 제거됨).

## Working Rules

- 엔진 패키지 수정은 허용되지만, 각 wave에서 요구한 빌드/테스트/grep 게이트를 먼저 닫아야 합니다.
- 패키지명, 빌드 도구, tsconfig 경로 맵은 엔진 subtree 전반에서 Fleet 컨벤션과 일치해야 합니다.
- 업스트림 계보나 과거 차이는 `CHANGELOG.md`와 관련 문서에서 다루되, 이 디렉토리 자체를 읽기 전용 영역으로 취급하지 않습니다.
