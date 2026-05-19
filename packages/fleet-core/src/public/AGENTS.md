# public/ — Adapter-Facing Lifecycle Surface

fleet-core의 외부 소비자에게 노출되는 lifecycle boot 계층. 비즈니스 로직과 도메인 서비스 컨테이너를 포함하지 않는다.

## Core Rules

1. **lifecycle only** — `runtime.ts`는 부트 side effect와 shutdown handle만 소유한다.
2. **서비스 컨테이너 금지** — `admiral`, `admiralty`, `infra`를 묶어 반환하는 공개 runtime context를 만들지 않는다.
3. **facade 직접 소비** — 소비자는 `@sbluemin/fleet-core` root barrel의 `admiral`, `admiralty`, `infra` facade를 직접 import한다.
4. **Host-agnostic** — Pi, 커스텀 CLI, 테스트 모두 동일 lifecycle boot를 사용한다. 특정 호스트 의존 금지.
5. **포트 제거 우선** — 호스트 포트는 기본적으로 두지 않는다. 새 포트 추가는 금지.

## File-Role Mapping

| File | Domain |
|------|--------|
| `runtime.ts` | Lifecycle boot/shutdown only |
| `admiral-services.ts` | Legacy facade type alias/factory surface; 새 소비 경로로 확장하지 않는다 |
| `admiralty-services.ts` | Legacy facade type alias/factory surface; 새 소비 경로로 확장하지 않는다 |
| `infra-services.ts` | Legacy facade type alias/factory surface; 새 소비 경로로 확장하지 않는다 |

## Prohibited

- 도메인 로직 (내부 모듈에 위임)
- 특정 호스트 타입 import (`@mariozechner/pi-*`, `@anthropic-ai/*`)
- `admiral`, `admiralty`, `infra`를 재포장하는 runtime/service container 타입
- 새 포트 인터페이스 추가 (기존 포트는 제거 방향)
