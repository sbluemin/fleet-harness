---
id: "guide-unified-agent-cursor-composer-25"
title: "Guide - unified-agent Cursor Composer 2.5 모델 등록 및 ACP 연결"
tags: ["unified-agent", "cursor", "composer-2.5", "acp", "models"]
created: "2026-05-26T14:36:11.226Z"
updated: "2026-05-26T14:37:03.523Z"
version: 1
rawSourceRef: "raw/2026-05-26-guide-unified-agent-cursor-composer-25-source-db68c1a5.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-26-guide-unified-agent-cursor-composer-25-source-db68c1a5.md\",\"title\":\"Guide - unified-agent Cursor Composer 2.5 모델 등록 및 ACP 연결\",\"hash\":\"db68c1a5\"}]"
---
---
id: guide-unified-agent-cursor-composer-25
title: Guide - unified-agent Cursor Composer 2.5 모델 등록 및 ACP 연결
tags: [unified-agent, cursor, composer-2.5, acp, models]
created: 2026-05-26
updated: 2026-05-26
version: 1
---

# Guide - unified-agent Cursor Composer 2.5 모델 등록 및 ACP 연결

> 이 가이드는 `unified-agent` 패키지에서 Cursor provider로 Composer 2.5 모델을 등록하는 방법과 ACP(Agent Client Protocol) 연결 방식의 요점을 설명한다.

## Overview

Cursor의 Composer 2.5 에이전트는 Moonshot Kimi K2.5 기반으로 2026-05-18에 공개되었다. `unified-agent`는 이 모델을 `models.json` 정적 레지스트리에 등록하고, ACP를 통해 `cursor-agent` CLI 프로세스와 통신한다. 이 문서는 등록된 모델의 의미, 데이터 주도 라우팅 원리, ACP 연결 흐름, 런타임 모델 전환 동작, 능력 제약, 그리고 향후 모델 추가 절차를 다룬다.

## Registered Models

`packages/unified-agent/models.json`의 `providers.cursor.models` 배열에 다음 두 모델이 등록되어 있다:

| modelId | name | 의미 |
|---------|------|------|
| `composer-2.5-fast` | Composer 2.5 Fast | Cursor 기본값. 빠른 응답, 고비용. |
| `composer-2.5` | Composer 2.5 Standard | 비용 효율형. Kimi K2.5 기반. |

- `composer-2.5-fast`는 Cursor 서버의 기본 모델로, Fast tier에 해당한다.
- `composer-2.5`는 Standard tier로, 동일한 Kimi K2.5 체크포인트를 사용하지만 더 낮은 가격대를 제공한다.
- 두 모델 모두 `effort.supported: false`이므로 `spawnModelTemplate`이 없다.

## Data-Driven Routing

모델 정보는 아래 경로로 흐른다:

```
models.json
  → schemas.ts (Zod 검증)
  → ModelRegistry.ts (정적 레지스트리)
      ├── UnifiedCursorAgentClient.ts  (getProviderModels, getCursorSpawnEffortInfo)
      ├── CliConfigs.ts                (createSpawnConfig, resolveCursorSpawnModel)
      └── index.ts                     (export)
```

`ModelRegistry`는 런타임에 `models.json`을 읽어 Provider별 모델 목록을 제공하며, `UnifiedCursorAgentClient`와 `CliConfigs`는 이 목록을 기반으로 spawn 인자와 세션 설정을 결정한다.

## ACP Connection Flow

Cursor와의 통신은 `@agentclientprotocol/sdk`를 통해 ACP로 수립된다.

### 1. Spawn

`CliConfigs.ts`에서 다음 설정으로 프로세스를 생성한다:

- `cliCommand: 'cursor-agent'`
- `protocol: 'acp'`
- `acpArgs: ['acp']`
- `usesNpxBridge: false`
- `requiresModelAtSpawn: true`

실제 spawn 명령어:

```bash
cursor-agent --model <modelId> acp
```

`createSpawnConfig()`는 `resolveCursorSpawnModel()` 결과를 args에 `unshift`하여 `--model` 인자를 삽입한다.

### 2. stdio → JSON-RPC Adaptation

`BaseConnection.ts`에서 `child_process.spawn`의 stdout/stdin을 Web Stream으로 변환한 뒤, ACP SDK의 `ndJsonStream()`으로 감싸 JSON-RPC 스트림을 형성한다.

### 3. Session Lifecycle

| 단계 | 메서드 | ACP RPC | 위치 |
|------|--------|---------|------|
| 연결 | `initializeConnection()` | `agent/initialize` | `AcpConnection.ts` |
| 세션 생성 | `createSession()` | `session/new` | `AcpConnection.ts` |
| 메시지 전송 | `sendPrompt()` | `session/prompt` | `AcpConnection.ts` |
| 취소 | `cancelSession()` | `session/cancel` | `AcpConnection.ts` |
| 모델 변경 | `setModel()` | `session/set_model` (unstable) | `AcpConnection.ts` |
| 모드 변경 | `setMode()` | `session/set_mode` | `AcpConnection.ts` |
| 설정 변경 | `setConfigOption()` | `session/set_config_option` | `AcpConnection.ts` |
| 세션 종료 | `endSession()` | `session/close` | `AcpConnection.ts` |
| 세션 리셋 | `reconnectSession()` | `session/new` 재호출 | `AcpConnection.ts` |

## Model Switching Behavior

Cursor에서는 **spawn-time `--model`만 신뢰적으로 동작**한다.

- 런타임에 `session/set_model`을 시도할 수 있으나, Cursor ACP 구현에서 불안정하다.
- `UnifiedCursorAgentClient`는 `setConfigOption('model')` 또는 `setConfigOption('effort')` 호출 시 `buildReconnectOptions()`로 다음 옵션을 구성한 뒤, 기존 프로세스를 종료하고 `connect(nextOptions)`로 **프로세스를 재시작**한다.
- 이는 `supportsSessionClose: false` 때문에 세션 리셋(`reconnectSession()`)이 불가능하기 때문이다.

## Capability Constraints

Cursor provider는 다음 제약을 가진다:

| 제약 | 값 | 영향 |
|------|-----|------|
| `supportsSessionClose` | `false` | `reconnectSession()` throw — 프로세스 재시작만 가능 |
| `mode` | `'agent'` 단일 | `setMode()`는 무의미 |
| `requiresModelAtSpawn` | `true` | spawn 시 반드시 `--model` 인자 필요 |
| `effort` | 없음 | effort level 설정 불가 |

## Adding New Cursor Models

새로운 Cursor 모델을 `unified-agent`에 추가하려면 아래 관문 5개를 통과해야 한다:

1. **`models.json`** — `providers.cursor.models[]`에 `{ modelId, name, effort }` 객체 추가
2. **`tests/unit/ModelRegistry.test.ts`** — 기대 배열(`toEqual([...])`)에 새 `modelId` 추가
3. **`tests/unit/CliConfigs.test.ts`** (선택) — 새 모델의 spawn 인자 검증 테스트 추가
4. **`tests/unit/UnifiedCursorAgentClient.test.ts`** (선택) — 새 모델 전환 reconnect 시나리오 추가
5. **`CHANGELOG.md`** — `[Unreleased]`에 `[unified-agent]` 프리픽스로 한 줄 추가

## defaultModel Policy

`providers.cursor.defaultModel`은 현재 `auto`를 유지한다. 이는 Cursor 서버가 상황에 맞는 최적 모델을 자동 선택하도록 하는 정책이며, Composer 2.5 추가 이후에도 변경되지 않았다.

`defaultModel`은 반드시 `models[]` 중 하나의 `modelId`와 일치해야 한다(`ProviderSchema` Zod 검증).

## Related

- [[wiki:guide-003-fleet-wiki]] — Fleet Wiki 사용법
- [[wiki:prd-agent-core-model-bypass]] — fleet-agent `--model` 옵션과 forwarded 카테고리 도입