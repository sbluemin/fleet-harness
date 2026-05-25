---
id: "prd-cli-argv-to-preset"
title: "PRD: fleet-cli CLI argument의 인터랙티브 메뉴 + preset 영속 모델로의 전환"
tags: ["prd", "cli", "ux", "preset", "fleet-infra", "argv", "override-model", "fleet-cli", "decision-history"]
created: "2026-05-25T04:05:11.571Z"
updated: "2026-05-25T04:06:59.871Z"
version: 1
rawSourceRef: "raw/2026-05-25-prd-cli-argv-to-preset-source-f74aa089.md"
template_id: "prd"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-25-prd-cli-argv-to-preset-source-f74aa089.md\",\"title\":\"prd-cli-argv-to-preset\",\"hash\":\"f74aa089\"}]"
---
## Overview

fleet-cli의 TUI Welcome 화면과 실행 흐름에서 CLI argument(`--cli`, `--model`, `--native` 등)가 단일 진입점의 1회성 오버라이드로만 작동하던 구조를, **인터랙티브 메뉴를 통해 사용자가 의도를 영속화할 수 있는 preset 모델**로 전환한다. 이 전환은 CLI 인자의 "일회성 실험" 의미와 메뉴 변경의 "기본값 승격" 의미를 명확히 분리하여, 사용자가 fleet을 켰을 때 매번 같은 인자를 타이핑하지 않아도 되는 동선을 만든다.

## Problem

### 1. 인자 중복 입력 피로
사용자가 매일 `fleet --cli codex --model o4-mini`처럼 반복적으로 동일한 인자를 입력하거나, alias를 만들어 우회하는 패턴이 관찰되었다. 이는 CLI 인자가 "실험/오버라이드" 도구가 아니라 "일상적 기본값 설정" 도구로 오용되고 있음을 의미한다.

### 2. 인자 vs 메뉴 변경의 의미 혼란
기존에는 argv로 전달한 값과 TUI 난 내에서 `o` 키 등으로 바꾼 값 사이에 영속성 차이가 없었다. 사용자는 "이번에만 바꿨는데 다음에도 적용될까?"를 추론할 수 없었고, 이 불확실성은 매 실행마다 인자를 다시 타이핑하게 만들었다.

### 3. `states.json`의 도메인 오염
carrier 런타임 상태(`states.json`)가 CLI 기본값(model, native 플래그 등)도 겸임하고 있었다. runtime state는 carrier 생명주기(lock, retry, 세션 식별)와 결합된 영역인데, 사용자 의도(user intent)까지 함께 저장하니 의미 중복과 혼란이 발생했다.

### 4. 설정 범람(settings catch-all) 위험
`settings.json`은 범용 섹션 CRUD이므로 새로운 도메인 규칙(preset 승격 정책, 우선순위 체인, 역방향 sync 금지)을 매번 섹션 단위로 숨기면 응집도가 떨어진다. settings가 catch-all bucket이 되는 것을 막아야 한다.

## Goals

1. **의미 분리**: argv는 1회성 오버라이드로, 메뉴 변경은 사용자 기본값(preset)으로 명확히 구분한다.
2. **영속화 단일 진입점**: preset 승격은 `S` 키라는 단일 게이트에서만 발생한다. argv 자동 영속화는 절대 금지.
3. **우선순위 체인 확립**: `argv > env(FLEET_AGENT_CLI 등) > preset[cliId] > hardcoded default` 순서를 코드와 문서 양쪽에서 동일하게 적용한다.
4. **도메인 응집**: preset 정책과 저장 메커니즘을 `fleet-infra` 내 신규 도메인으로 격리하여, settings catch-all화를 방지하고 향후 named preset·workspace-scope preset 확장의 여력을 확보한다.
5. **states.json 경계 복원**: preset이 carrier 최초 기동 시 단방향 시드로만 작동하고, 역방향 sync는 금지한다.
6. **역방향 디스커버리**: TUI 옵션 라벨에서 argument 흔적을 제거하고, "Equivalent CLI" 힌트로 CLI↔메뉴 양방향 학습을 유도한다.

## Non-Goals

- `FLEET_DATA_DIR` 환경변수 도입 또는 data-dir 해상도 변경
- `settings.json`·`auth.json` 전체에 대한 atomic write 보강(별도 사조)
- `fleet-mcp-server`·`fleet-wiki`·`unified-agent`가 preset을 직접 소비하도록 선제 개선
- named preset(프로파일 개념) 구현
- workspace-scope preset(CWD 기준 다중 preset) 구현
- `config?: Record<string, never>` stub의 기능적 부활(stub 제거는 포함)

## User Stories

### 첫 사용자
> Alice가 처음 fleet을 실행한다. Welcome 화면에서 옵션 칩을 보고 `*` 마크가 "이번 실행만 적용되는 오버라이드"임을 직관적으로 이해한다. 원하는 CLI를 선택한 뒤 `S` 키를 눌러 다음 번 실행에도 동일하게 적용되도록 저장한다.

### 일상 사용자
> Bob은 매일 Codex를 기본으로 사용한다. 한 번 `S` 키로 저장한 뒤로는 `fleet`만 타이핑핏 Default로 Codex가 뜬다. 가끔 Claude로 실험할 때는 `--cli claude`를 붙이고, 이 값이 자동으로 저장되지 않아서 다음 날 다시 Codex가 뜨는 것을 확인한다.

### 중급자
> Carol은 Drawer(`o` 키)를 열어 각 옵션의 현재 출처(`← arg` / `← env` / `← preset`)를 확인한다. `R` 키로 preset만 초기화하고 argv/env는 유지한 채 기본값으로 돌아가 본다.

### 파워 유저 / Multi-instance
> Dave는 동시에 여러 터미널에서 fleet을 띄운다. 메뉴에서 preset을 바꿀 때 atomic write + advisory lock로 인해 last-write-wins는 여전하지만, 파일 깨짐은 방지된다. Multi-instance 동시 편집이 빈번해지면 별도 사조로 승격된다.

### Auth / Wiki 사용자
> Eve는 `fleet auth`나 `fleet wiki` 서브커맨드를 사용한다. 이 경로들은 `parseFleetCliOptions()`에 도달하기 전에 `process.exit()` 하므로 preset 해석과 무관하다.

## Functional Requirements

### FR-1: Preset 도메인 형상
- `packages/fleet-infra/src/preset/` 신규 디렉토리를 추가하고, `@dotobokuri/fleet-infra/preset` 서브패스 export를 등록한다.
- 저장 파일: `~/.fleet/presets.json`
- 스키마(버전 관리):
  ```
  { version, defaultCliId, byCli: { <cliId>: { model, native, replaceSystemPrompt, enableMetaphor, cursorSync } } }
  ```
- atomic write: temp 파일 작성 후 `rename`으로 교체. `read → mutate → write` 전체를 advisory lock 아래에서 보호한다.

### FR-2: 우선순위 체인(4-Layer Resolver)
실행 시점의 effective option은 다음 4계층을 순서대로 평가한다:

1. **argv** — `parseFleetCliOptions()` 결과. 1회성 오버라이드.
2. **env** — `FLEET_AGENT_CLI`, `FLEET_CURSOR_SYNC` 등. 환경 의존적 오버라이드.
3. **preset** — `presets.json`의 `byCli[cliId]` 및 `defaultCliId`. 사용자 영속 기본값.
4. **hardcoded default** — 소스코드 내 상수 기본값.

### FR-3: Preset 승격 정책
- 메뉴에서 값을 변경하면 **메모리 상태만** 즉시 반영된다.
- `S` 키를 명시적으로 눌러야만 현재 메모리 상태가 `presets.json`에 기록된다.
- argv로 전달된 값은 어떤 경로로도 자동 영속화되지 않는다.

### FR-4: UX 3-Tier
- **T1 Welcome**: 옵션 칩 목록. 각 칩 옆에 `*` 표시는 "이번 실행에 argv/env로 오버라이드됨"을 의미. argument 명 흔적 제거.
- **T2 Drawer**(`o` 키): 각 행에 `← arg` / `← env` / `← preset` 출처 라벨. `S`로 save, `R`로 reset(preset만 초기화).
- **T3 Menu**(`m` 키): auth, wiki, diagnostics, about 등 기존/신규 항목. preset 편집 UI는 Drawer로 일원화.

### FR-5: states.json 단방향 시드
- `presets.json`이 carrier 최초 기동 시 `states.json`의 초기값을 시드한다.
- `states.json` → `presets.json` 역방향 sync는 절대 없다.
- `states.json` 내 기존 중복 필드는 호환용 fallback로 유지하되, 신규 의미 추가는 금지.

### FR-6: Deprecated Stub 제거
- `createInfraServices(deps)` 시그니처의 `config?: Record<string, never>` stub을 제거한다. preset은 별도 도메인으로 분리되므로 stub을 부활시키지 않는다.

### FR-7: 역방향 디스커버리
- TUI 옵션 라벨에서는 `--model`, `--native` 같은 argument 명을 노출하지 않는다.
- 대신 Drawer나 푸터에 "Equivalent CLI: fleet --cli codex --model o4-mini" 형태의 힌트를 노출하여, 메뉴에서 본 설정을 CLI로도 재현할 수 있음을 가르친다.

## Acceptance Criteria

- [ ] `fleet` (인자 없음) 실행 시 Welcome 화면에서 현재 effective option이 옵션 칩으로 표시되며, argv/env 오버라이드 시 `*` 마크가 붙는다.
- [ ] `o` 키로 Drawer를 열면 각 옵션의 출처(arg/env/preset/default)가 행 레벨로 노출된다.
- [ ] Drawer에서 값을 변경하고 `S` 키를 누르면 `~/.fleet/presets.json`에 기록되며, 다음 실행에도 동일 기본값이 적용된다.
- [ ] `fleet --cli codex --model o4-mini`로 실행한 뒤 `S`를 누르지 않으면, 다음 `fleet` 실행 시 preset 값이 그대로 유지되고 argv 값은 1회성으로 소멸된다.
- [ ] `R` 키는 preset 값만 초기화하며, argv/env 오버라이드는 그대로 유지한다.
- [ ] Multi-instance 동시 쓰기 시 `presets.json` 파일 깨짐이 발생하지 않는다(atomic write + lock).
- [ ] `fleet auth`, `fleet wiki` 서브커맨드 경로에서 preset 해석이 개입하지 않는다.
- [ ] `states.json`에 preset이 역방향으로 기록되지 않는다.

## Open Questions

1. **Multi-instance lost-update 감수 한계**: Advisory lock은 파일 깨짐을 막지만 last-write-wins는 여전하다. 동시 편집이 실사용에서 관측되면 settings 전체에 distributed lock 또는 파일 기반 mutex를 도입하는 별도 사조로 승격할 것인가?
2. **Named preset 확장 시점**: 현재는 per-cliId 단일 preset만 지원한다. 프로파일 개념(`work`, `personal`) 도입 시 `presets.json` 스키마를 어떻게 버저닝할 것인가?
3. **unified-agent 직접 소비**: standalone `ait` 등이 preset을 읽어야 할 때, `fleet-infra → unified-agent` 의존 방향이 AGENTS.md와 충돌할 수 있다. 그때 의존 역전 정리가 선행 조건인가, 아니면 별도 최하층 패키지 분리가 필요한가?

## Related

- [[wiki:prd-agent-core-model-bypass]] — `--model` 옵션과 forwarded 카테고리 도입 배경
- [[wiki:prd-tui-mission-control]] — Welcome 화면과 Mission Control 구조
- [[wiki:prd-core-infra-extraction]] — fleet-infra 패키지 분리 결정
- [[wiki:guide-002-carrier-status]] — Carrier Status 패널과 키바인딩

---

## Nimitz Trade-off 결정 근거

preset 모듈의 배치를 두고 Nimitz task force(claude vs codex)가 갈렸다.

| 대안 | 위치 | 추정 공수 | 근거 |
|---|---|---|---|
| Claude | `settings.json` 신규 섹션 `cli-presets` | Short(1-4h) | settings와 의미 도메인 동일(사용자 환경 기본값). 기존 JSON CRUD·security 패턴 재사용. |
| Codex | `fleet-infra/src/preset/` 신규 도메인 | Medium(1-2d) | ① settings catch-all bucket화 방지 ② preset 정책 진화(named preset, workspace-scope) 흡수 여력 ③ multi-instance lost-update 방지를 atomic write와 같은 사조에 포함하는 것이 정공법 |

**제독 결정**: Codex안 채택.

**채택 근거**:
1. **도메인 응집**: preset은 단순한 "설정"이 아니라 "사용자 의도의 영속화"라는 독자적 정책 도메인이다. settings 섹션으로 묻으면 `S` 키 승격 게이트, 우선순위 체인, 역방향 sync 금지 같은 규칙이 숨는다.
2. **진화 여력**: named preset, workspace-scope preset 확장이 예상되는데, 별도 도메인이면 스키마 버저닝과 파일 구조를 독립적으로 진화시킬 수 있다.
3. **정공법**: multi-instance 동시 쓰기를 방어하려면 atomic write(temp+rename)뿐 아니라 `read → mutate → write` 전체를 lock 아래에 두어야 한다. 이 메커니즘을 preset 도메인 내에 같은 사조로 묶는 것이 자연스럽다. settings 전체를 뜯어고치는 것은 범위 초과다.

**Rejection 근거(Claude안)**:
- settings에 추가하면 기존 섹션 CRUD 코드를 재사용할 수 있지만, 그 결과 settings가 점점 더 catch-all이 되어 응집도가 떨어진다.
- `config?: Record<string, never>` stub을 preset으로 "부활"시키는 형태가 되어 이름과 책임이 모호해진다.