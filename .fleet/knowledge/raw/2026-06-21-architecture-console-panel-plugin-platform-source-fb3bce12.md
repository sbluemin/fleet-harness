---
id: "architecture-console-panel-plugin-platform-source"
created: "2026-06-21T11:36:23.857Z"
sourceType: "inline"
title: "Console 패널 플러그인 플랫폼 확정 아키텍처 raw source"
tags: ["architecture", "fleet-console", "plugin-platform", "operations", "panel-tree", "decision-history"]
contentHash: "fb3bce12"
---
# Objective

Fleet Console의 패널 기능을 확정 아키텍처 그대로 플러그인 플랫폼으로 전환한다. 목표 권위본은 Nimitz taskforce `4cf248a3` 합의와 대원수 결재본이며, 이 계획은 재설계 문서가 아니라 Ohio가 순차 실행할 수 있는 implementation plan이다.

- 패널을 `operations` 리소스로 일반화하고 단일 `OperationNode` 엔티티로 수렴시킨다.
- built-in `agent`/`shell` 패널을 `runtime/fleet-plugins/{agent,shell}` 동적 로드 플러그인으로 분리한다.
- `runtime/fleet-console/sdk/{client,server}` public SDK와 host-owned router SDK를 제공한다.
- `runtime/fleet-plugins/shared`를 플러그인도 SDK도 아닌 제3범주 workspace package `@fleet-plugins/shared`로 둔다.
- console-core는 operations lifecycle, Theater, Settings shell, plugin-host, static serving, host-owned route registry만 소유한다.
- 서드파티 플러그인은 `~/.fleet/plugins/**`에 built-in과 동일한 `plugin.json + routes.ts + api/ + client/` 구조로 설치되어 동적 로드된다.
- durable state는 v1에서 v2로 일방 마이그레이션한다. 호환층, dual-write, hidden fallback은 금지한다.
- FloatingStreaming은 agent operation의 일반 child panel/tree로 통합하고 중앙 floating overlay 시스템은 제거한다.

## Shared Mutable Resource Lock

| Resource | Owning wave | Single owner rule |
| --- | --- | --- |
| `runtime/fleet-console/src/server.ts` | Wave 0 | RouteRegistry/UpgradeRegistry 전환은 Genesis-Core 단일 소유. Wave 1/2는 plugin `routes.ts` 등록 경로만 사용하고 core switch를 되살리지 않는다. |
| `runtime/fleet-console/src/durable-state.ts` | Wave 0 | v2 schema/migration은 Genesis-Core 단일 소유. Wave 2 agent 상태는 `OperationNode.payload` 또는 plugin-owned store로만 확장한다. |
| `runtime/fleet-console/src/api-types.ts` and `runtime/fleet-console/client/src/api.ts` | Wave 0 | operations DTO와 SDK export 안정화 전에는 plugin wave가 시작되지 않는다. |
| `runtime/fleet-console/client/src/canvas/**` generic host files | Wave 0 | Canvas는 generic Operation renderer host로 먼저 일반화한다. Shell/agent content extraction은 Wave 1/2에서만 수행한다. |
| `runtime/fleet-console/sdk/**` | Wave 0, then additive only | Wave 0에서 minimal public contract를 고정하고, Wave 1/2는 breaking rename 없이 필요한 descriptor field만 additive로 요청한다. |
| `runtime/fleet-plugins/shared/**` | Wave 1 | pty/xterm 공통 구현은 Genesis-Shell/Shared 단일 소유. shared는 console-core를 import하지 않는다. |
| `runtime/fleet-plugins/shell/**` | Wave 1 | shell plugin owner only. console-core shell direct routes/imports 제거까지 같은 wave에서 닫는다. |
| `runtime/fleet-plugins/agent/**` | Wave 2 | agent plugin owner only. observability/job/session UI 및 agent CLI launch gating을 모두 이동한다. |
| `scripts/check-plugin-boundary.mjs`, ESLint boundary config, boundary tests | Wave 3 | Freeze owner only. W1/W2는 임시 `rg` static gate를 통과해야 하고, W3에서 CI-grade gate로 승격한다. |

## Waves

### Wave 0 — Core Operations Platform And Host Skeleton

- Introduce `OperationNode` with `{ id, theaterId, parentId|null, type, pluginId, title, renamedTitle?, payload, geometry, state, ts }`.
- Implement `/operations/*` CRUD in console-core: create, rename, move, delete, listChildren, theater scoping, parentId tree, and initial depth=2 enforcement.
- Convert durable state to v2 with a one-way startup migration. Store tree/state server-side; keep geometry/z-index/minimized in client local/session storage.
- Add `createSanitizedOpDto()` on the server boundary and move browser DTO stripping out of client-only guards.
- Replace static path-switch routing in `server.ts` with host-owned `RouteRegistry` and `UpgradeRegistry`.
- Add plugin-host boot discovery for `runtime/fleet-plugins/**` except `shared`, plus `~/.fleet/plugins/**`; parse `plugin.json`; import `routes.ts` in dev through `tsx`; import `dist/fleet-plugins/*/routes.mjs` in build; register HTTP under `/plugins/<pluginId>/*` and WS under `/plugins/<pluginId>/ws/*`.
- Add public SDK aliases `@fleet-console/sdk/client` and `@fleet-console/sdk/server`.
- Add Vite `virtual:fleet-plugins` as the only client plugin loading paradigm.

### Wave 1 — Shell Plugin And Shared Extraction

- Create `@fleet-plugins/shared` workspace package with no `plugin.json`.
- Create shell `plugin.json` and shell `routes.ts`. Register HTTP under `/plugins/shell/*` and WS under `/plugins/shell/ws/*` through the server SDK.
- Move shell client rendering into `runtime/fleet-plugins/shell/client/**` using `definePanelKind`.
- Replace console canvas shell branches with descriptor-based loading through `virtual:fleet-plugins`.

### Wave 2 — Agent Plugin And Child Operation Streaming

- Create agent `plugin.json` and server/client entries using the same host loading path proven by shell.
- Move agent CLI detection, launch metadata, launch gating, session capture, attention/turn/auto-name hooks, observability store/routes, and job stream APIs into the agent plugin backend.
- Replace FloatingStreaming with normal child `OperationNode` panels.
- Remove direct `/observer` and agent CLI browser API functions for operations panels.

### Wave 3 — Boundary Freeze And Third-Party Proof

- Add `check:plugin-boundary` script and ESLint `no-restricted-imports`.
- Add a demo notepad/memo panel plugin fixture.
- Update AGENTS/docs and one `.changelog.d/*.md` fragment.

---

## Memory: project_console_panel_plugin_platform

2026-06-21 패널 플러그인화 재작전. 이전 5계획 무계획 진행→코드산만으로 롤백 후 정공법 재수행. Nimitz 2-backend 합의(taskforce:4cf248a3) + 대원수 결재로 아키텍처 LOCKED.

**목표**: 패널을 fleet-console 'operations' 리소스로 일반화 + built-in(agent·shell)을 동적 디스커버리·로드 플러그인으로 분리 + 플러그인용 public SDK(프론트/백)·router SDK 제공. 서드파티가 자체 패널 제공 가능하게.

**6계층**: console-core(operations 수명주기·Theater·Settings·plugin-host·static 서빙) / public SDK(`runtime/fleet-console/sdk/{client,server}`, 별도 npm 아님·path alias `@fleet-console/sdk/*`) / plugin-host(디스커버리→plugin.json 파싱→routes.ts 동적 import→라우터 등록) / `runtime/fleet-plugins/shared`(공통 pty/xterm·plugin.json 없음·built-in 전용 **제3범주**) / built-in(`runtime/fleet-plugins/{agent,shell}`) / 서드파티(`~/.fleet/plugins/**`, 동일 로딩경로).

**operations 일반화·트리**: 단일 `OperationNode`(id·theaterId·**parentId**·type·pluginId·title·renamedTitle·payload(opaque)·geometry·state). terminal/shell/agent/custom 수렴. durable v1→v2 **일방 마이그레이션(호환층 금지)**. geometry/z/minimized=클 라 저장소, 서버 durable=트리/상태만. 트리 depth=2 초기.

**동적 로딩**: 서버=`tsx`로 routes.ts(.ts) 직접 import(dev)·`dist/fleet-plugins/*.mjs`(build). 클라=Vite `virtual:fleet-plugins` 단일 paradigm + `resolve.dedupe(react,react-dom)` 단일 인스턴스. 부트 1회 디스커버리(hot-reload 후속 스코프).

**public SDK 경계**: client=`definePanelKind`/`PanelContext`/`useOperations`. server=`definePlugin`/`registerRouter`/`registerWsHandler`/`createSanitizedOpDto`. 플러그인 허용 import=SDK(+built-in 한정 `@fleet-plugins/shared`)뿐. ESLint `no-restricted-imports`+boundary 스크립트로 **양방향 차단**(console→plugin 직접 import 금지).

**router SDK**: `server.ts` 정적 path-switch+`TERMINAL_TICKET_PATH` → host-owned `RouteRegistry`+`UpgradeRegistry`. 플러그인=`/plugins/<id>/*`+`/plugins/<id>/ws/*`. console-core=`/operations·/theaters·/settings·/health·/console`만. Token Boundary=`createSanitizedOpDto` fail-closed(cwd·providerSession·ticket·token·transcriptPath strip).

**대원수 3결정(2026-06-21)**: ①FloatingStreaming(중앙 오버레이+하단 라인)→agent operation **일반 child 패널로 통합** ②서드파티=**풀 백엔드**(api/+routes.ts router SDK 개방·로컬 trusted in-process·샌드박스 없음) ③agent-CLI 탐지/실행/launch 게이팅→**agent 플러그인 이관**(console=agent 지식 0·Settings는 플러그인 기여 슬롯).