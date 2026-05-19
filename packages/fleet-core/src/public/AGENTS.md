# public/ — Adapter-Facing Composition Surface

fleet-core의 외부 소비자에게 노출되는 서비스 조립 계층. 비즈니스 로직은 포함하지 않는다.

## Core Rules

1. **조립만, 로직 없음** — 내부 도메인 facade를 `readonly` 서비스 인터페이스로 집계. 변환/래핑/분기 금지.
2. **도메인 1:1 매핑** — 하나의 `*-services.ts`가 하나의 도메인만 담당. 파일 추가·제거는 상위 교리의 승인 필요.
3. **동결된 인터페이스** — 각 `FleetXxxServices` 타입이 공개 API 계약. 시그니처 변경은 breaking change.
4. **runtime.ts가 유일한 진입점** — `createFleetCoreRuntime()`이 모든 서비스를 초기화. 호스트는 이 함수만 호출.
5. **Host-agnostic** — Pi, 커스텀 CLI, 테스트 모두 동일 방식으로 소비 가능. 특정 호스트 의존 금지.
6. **포트 제거 우선** — 호스트 포트는 기본적으로 두지 않는다. 새 포트 추가는 금지.

## File-Role Mapping

| File | Domain |
|------|--------|
| `runtime.ts` | Composition root — 전체 초기화 + shutdown |
| `admiral-services.ts` | 캐리어 오케스트레이션, agent/session/executor, carrier jobs |
| `admiralty-services.ts` | 다중 인스턴스 그랜드 플릿 |
| `infra-services.ts` | auth/data-dir/job/log/settings/tool-registry |

## Prohibited

- 도메인 로직 (내부 모듈에 위임)
- 특정 호스트 타입 import (`@mariozechner/pi-*`, `@anthropic-ai/*`)
- 서비스 인터페이스에 mutable 상태 노출
- 새 포트 인터페이스 추가 (기존 포트는 제거 방향)
