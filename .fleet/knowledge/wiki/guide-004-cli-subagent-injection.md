---
id: "guide-004-cli-subagent-injection"
title: "Guide - 004 외부 CLI spawn 시 native subagent 주입 메커니즘 비교 및 Codex 적용 방안"
tags: ["guide", "cli", "sub-agent", "native-subagent", "claude-code", "codex", "opencode", "spawn", "comparison", "fleet-cli", "dedicated-cli", "carrier", "current"]
created: "2026-05-31T09:21:56.506Z"
updated: "2026-06-01T14:35:35.364Z"
version: 3
rawSourceRef: "raw/2026-06-01-guide-004-cli-subagent-injection-source-a0d6c283.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-31-guide-004-cli-subagent-injection-source-64d34adf.md\",\"title\":\"Codex native subagent spawn-time research insights, 2026-05-31\",\"hash\":\"64d34adf\"},{\"ref\":\"raw/2026-06-01-guide-004-cli-subagent-injection-source-89c3a393.md\",\"title\":\"Carrier doc sortie — guide-004 prefix-free contract 정합화 근거, 2026-06-01\",\"hash\":\"89c3a393\"},{\"ref\":\"raw/2026-06-01-guide-004-cli-subagent-injection-source-a0d6c283.md\",\"title\":\"Carrier doc sortie — guide-004 Codex sidecar mechanism finalization, 2026-06-01\",\"hash\":\"a0d6c283\"}]"
---
# 외부 CLI spawn 시 native subagent 주입 메커니즘 비교 및 Codex 적용 방안

## Overview

Fleet이 Claude Code, Codex CLI, OpenCode 같은 외부 dedicated CLI를 spawn할 때 native subagent/persona를 주입하는 방법을 비교하고, Codex에 적용할 최종 구현 방안을 정리한다.

Codex CLI 0.135.0 계열은 native `multi_agent`/`spawn_agent`를 지원하지만 Claude Code의 `--agents <JSON>` 같은 인라인 정의 플래그는 없다. Fleet이 Codex spawn 시점에 custom subagent 역할을 등록하려면 글로벌 role TOML 파일과 sidecar instructions 파일을 작성하고, Codex 실행 인자에 `-c agents.<roleKey>.description=...` 및 `-c agents.<roleKey>.config_file=/absolute/path/to/<roleKey>.toml`을 주입해야 한다.

## 결론 요약

| 항목 | Claude Code | Codex CLI | OpenCode |
|---|---|---|---|
| 인라인 subagent 정의 | `--agents <JSON>` 지원 | 직접 인라인 정의 없음 | 직접 인라인 정의 없음 |
| spawn 시점 커스텀 정의 | JSON 인자로 전달 | role TOML + sidecar `.md` + `-c agents.<role>.config_file` | config/env 또는 파일 기반 |
| 역할 호출 방식 | Task 도구의 subagent type | Codex 네이티브 `spawn_agent(agent_type=...)` | `--agent <name>` 이름 선택 |
| Fleet 권장 패턴 | 기존 Claude native path 유지 (`--agents` 인라인 JSON) | 글로벌 TOML + sidecar `.md` 생성 후 Codex argv에 config override 주입 | 별도 wave에서 env/config 기반 검토 |

## Codex 적용 방안

### Role Key 규칙

Codex subagent의 role key는 bare carrier id를 그대로 사용한다. 이전 버전의 `fleet_` 접두사는 완전히 제거됐다.

- 예시: carrier id가 `vanguard`이면 role key는 `vanguard`, TOML 파일명은 `vanguard.toml`, sidecar 파일명은 `vanguard.md`, argv는 `-c agents.vanguard.*`
- role key는 dot path 파싱 문제를 피하도록 영문/숫자/underscore로 제한한다.
- **Reserved-name 가드**: Codex built-in role인 `default`, `explorer`, `worker`, `awaiter`와 동일한 carrier id가 있으면 injection 시도 시 에러로 차단한다. 이 가드는 유지된다.

### 저장 위치 및 I/O 소유

- 모든 role 파일은 글로벌 Fleet data dir 하위 `~/.fleet/codex-agents/`에 저장한다.
- **두 개의 파일**로 구성된다:
  - `<roleKey>.toml` — role descriptor(model, effort, `model_instructions_file` 참조).
  - `<roleKey>.md` — raw persona instructions. TOML escaping 없이 순수 텍스트/마크다운으로 기록된다.
- `.toml`은 `.md`를 `model_instructions_file` 필드로 참조한다.
- 디렉터리 권한 `0700`, 각 파일 권한 `0600`.
- 파일 I/O(write/remove/path 관리)는 `fleet-carriers` store가 단독으로 소유한다.
- 세션별 UUID 서브디렉터리, orphan sweep, per-session cleanup은 사용하지 않는다. subagent mode가 enabled인 동안 파일을 유지하고, disable 시 해당 `<roleKey>.toml`과 `<roleKey>.md`를 제거한다.

### Native=true 처리

carrier가 `native=true`로 설정된 경우 injection을 전체 skip한다. TOML 파일과 sidecar `.md`를 생성하지 않고 argv도 주입하지 않는다.

### [SA] 토글 표시색

native subagent(SA) 모드가 활성화된 carrier 행은 단일 시그니처색 Rose/Magenta(fg `[216,100,168]`, bg `[30,14,26]`)로 표시된다. Rose/Magenta는 두 색이 아니라 하나의 자홍색 이름이며, provider 색이 아닌 SA 모드 식별용 중립 단일색이다. `native=true`(injection 전체 skip)는 색상 축과 무관한 별개 개념이다.

### Role TOML 구조

role TOML에는 최소한 다음 필드를 둔다. `developer_instructions`는 더 이상 사용하지 않는다.

```toml
name = "vanguard"
description = "Vanguard carrier role for Fleet native Codex subagents."
model = "gpt-5.4-mini"
model_reasoning_effort = "low"
model_instructions_file = "/abs/path/to/.fleet/codex-agents/vanguard.md"
```

- `model`: Codex에 전달할 모델 identifier.
- `model_reasoning_effort`: 추론 강도 (`low` / `medium` / `high` / `xhigh`). 이전의 `effort` 필드는 폐기한다.
- `model_instructions_file`: 해당 role의 base instructions를 완전히 대체할 carrier persona sidecar 파일의 절대 경로. 호스트가 이미 동일 키로 `model_instructions_file`을 설정하고 있으나, role-layer 값이 이를 override한다.

### Codex Spawn argv 주입

```bash
codex \
  -c 'agents.vanguard.description="Vanguard carrier role for Fleet native Codex subagents."' \
  -c 'agents.vanguard.config_file="/abs/path/to/.fleet/codex-agents/vanguard.toml"'
```

argv는 `fleet-cli` Codex dedicated CLI builder가 store-owned config path를 받아 주입만 담당한다. 호스트 자체는 별도의 `model_instructions_file`을 설정하지만, role TOML 내의 동일 키가 우선하여 subagent의 base instructions는 carrier persona로 **완전히 대체**된다.

## Claude Code 경로

Claude Code는 기존 `--agents <JSON>` 인라인 주입 경로를 그대로 유지한다. Codex와 달리 TOML 파일 생성 단계 없이 spawn 인자에 JSON을 직접 전달한다.

## 왜 sidecar 파일인가

Codex role TOML의 `developer_instructions` 필드는 inline multi-line string으로 삽입할 수 있지만, 다음 이유로 sidecar `.md` 파일과 `model_instructions_file` 참조를 사용한다:

1. **TOML escaping 없음** — carrier persona는 마크다운 서식, 코드 블록, 인용부를 포함할 수 있다. TOML basic string으로 escaping하면 가독성이 떨어지고 오류 가능성이 높아진다.
2. **base instructions 완전 대체** — `model_instructions_file`은 해당 role의 base instructions를 통째로 교체한다. 이는 carrier persona가 단순한 developer message supplement가 아니라 subagent의 정체성 자체를 정의함을 의미한다.
3. **호스트 override 허용** — 호스트가 이미 `model_instructions_file`을 설정하고 있으므로, role-layer에서 동일 키로 override하는 방식은 Codex 설정 계층 구조를 존중하면서도 Fleet의 주입 목적을 달성한다.
4. **운영 안전성** — sidecar 파일은 atomic write + fsync + rename 패턴으로 작성되며, `0700` 디렉터리와 `0600` 파일 권한, path confinement, symlink 방지, root identity 검증을 동일하게 적용받는다.

## 패키지별 적용 경계

- `packages/fleet-carriers`: carrier persona와 subagent metadata를 provider-neutral role model로 변환하고, `~/.fleet/codex-agents/<roleKey>.toml`과 `<roleKey>.md`의 write/remove/path I/O를 담당한다.
- `runtime/fleet-cli`: Codex dedicated CLI builder에서 store-owned config path를 받아 `-c agents.<roleKey>.*` argv 주입만 담당한다.
- `packages/fleet-admiral`: Claude 전용 문구를 provider-neutral native subagent 안내로 조정하고, native subagent carrier는 일반 Fleet roster와 중복 노출되지 않도록 유지한다.
- `packages/unified-agent` 및 ACP: dedicated CLI wave와 분리한다. 이 scope에서 다루지 않으며 별도 설계 wave로 판단한다.

## 안전 체크리스트

- `config_file`은 절대 경로를 사용한다.
- role key는 bare carrier id를 그대로 사용하고, built-in 예약어(`default`/`explorer`/`worker`/`awaiter`)와 충돌 시 에러로 차단한다.
- role TOML의 `name` 필드가 registry key와 일치하는지 검증한다.
- role 파일은 `~/.fleet/codex-agents/`에 두고 `~/.codex`, project `.codex`, workspace `.fleet`를 오염시키지 않는다.
- TOML 및 sidecar `.md` write는 atomic write + fsync + rename 패턴을 사용한다.
- `effort` 필드를 role TOML에 포함하지 않는다 (Codex 거부).
- `developer_instructions`는 role TOML에 포함하지 않는다. 대신 sidecar `.md`와 `model_instructions_file` 참조를 사용한다.
- `native=true` carrier에는 TOML 파일과 sidecar `.md` 생성 및 argv 주입을 생략한다.
- Fleet `carrier_jobs` 결과 수집과 Codex 내부 native subagent 결과 수집은 같은 채널이 아니므로 혼동하지 않는다.

## 검증 근거

- 로컬 Codex CLI: `codex-cli 0.135.0`, `multi_agent stable true`, `multi_agent_v2 under development false`.
- 공식 문서: `https://developers.openai.com/codex/subagents`.
- upstream Codex source: `codex-rs/config/src/config_toml.rs`의 `AgentRoleToml`, `codex-rs/core/src/config/agent_roles.rs`의 role TOML 파서, `codex-rs/core/src/agent/role.rs`, `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`.
- Fleet research jobs: `carrier:795b1505-fd5c-4150-8515-8628b3a3b757`, `carrier:2fcf044f-b691-4d88-9776-10e95ff0896f`, `carrier:b5f304be-ab55-4ea7-8d76-12c328adc062`.
- Fleet review jobs: `taskforce:86aaeea8-2b3f-4538-9533-82a5c2611b0b`, `taskforce:0a53fd24-5104-4764-8a54-18a98d382f14`, `carrier:153a7bc7-3b5b-4b52-ba19-63c7485d7ceb`.
- Rejected patch: `bed601c0` (2026-06-01) — fleet_ 접두사 잔존으로 reject됨.
- Design contract update (this revision): role TOML에서 `developer_instructions` 제거, sidecar `.md` + `model_instructions_file` 도입, 두 파일 atomic 저장, role-layer override로 base instructions full replace.

## Related

- [[wiki:prd-tui-mission-control]]
- [[wiki:prd-agent-core-model-bypass]]
- [[wiki:prd-carrier-persona-extraction]]