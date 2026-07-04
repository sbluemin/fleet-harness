---
id: "prd-remove-system-prompt-injection"
title: "PRD: System Prompt Injection 토글 전면 제거 — Append 하드코딩 고정"
tags: ["decision-history", "fleet-admiral", "fleet-infra", "fleet-cli", "agent-cli", "system-prompt", "cognitive-debt", "terminal-plugin"]
created: "2026-07-04T19:26:26.475Z"
updated: "2026-07-04T19:26:26.475Z"
version: 1
rawSourceRef: "raw/2026-07-04-prd-remove-system-prompt-injection-source-fadb48c3.md"
template_id: "prd"
rawSourceRefs: "[{\"ref\":\"raw/2026-07-04-prd-remove-system-prompt-injection-source-fadb48c3.md\",\"title\":\"System Prompt Injection 제거 작전 증거 (Vanguard + Genesis + Sentinel, 최종 disposition 반영)\",\"hash\":\"fadb48c3\"}]"
---
## Overview

`replaceSystemPrompt` 불리언 토글(Append ↔ Replace)과 이를 노출하는 모든 표면을 전면 제거하고, **Claude = Append, Codex = Developer Instructions**의 고정 계약을 하드코딩했다. 이전 기본값(false = Append)이 옳은 동작이었으므로, Replace를 명시적으로 활성화하지 않은 사용자는 변화를 인지할 수 없다.

- **브랜치**: `feature/remove-system-prompt-injection`
- **PR**: #174 (base: canary), 커밋 `92ee77f41`
- **구현 완료**: 2026-07-05
- **영향 패키지**: fleet-admiral, fleet-infra, fleet-cli, fleet-plugins/terminal, fleet-console
- **검증**: full build green, 5개 패키지 테스트 green(fleet-infra 58/58 포함, 총 929+), Sentinel QA PASS(Critical/High 0)

---

## Problem

### 비대칭 옵션 — Claude Code 한 개에만 실효

`replaceSystemPrompt` 토글은 Claude Code의 CLI 플래그 선택(`--append-system-prompt-file` vs `--system-prompt-file`)을 전환하는 것이 전부였다. 나머지 3개 CLI는 구조적으로 이 토글을 무시한다.

| CLI | 실제 동작 | 토글 실효 여부 |
|-----|----------|--------------|
| Claude Code | append 또는 replace 분기 | **실효** |
| Codex | 항상 `developer_instructions` profile | **무시** |
| OpenCode | 항상 `firstPromptPending` prepend | **무시** |
| Cursor | 항상 ACP `systemPrompt` | **무시** |

4개 CLI 중 1개에만 실효하면서 3개 표면(Console UI, fleet-cli Mission Control, env)과 5개 패키지에 걸쳐 타입·저장·전달·UI가 분산된 구조는 유지 비용 대비 가치가 없었다.

### Replace 모드는 CLI 기본 역량을 훼손하는 예외 경로

Replace 모드는 Claude Code 내장 시스템 프롬프트(코드 검색 안내, 도구 사용 설명 등)를 Fleet 독트린으로 통째로 교체한다. Fleet의 표준 동작은 CLI 내장 시스템 프롬프트 **위에** Fleet 독트린을 계층화(append)하는 것이다. Replace는 이 표준에서 벗어나는 예외적·저가치 경로였으며, 실수로 활성화할 경우 Claude 기본 역량 저하로 이어질 수 있었다.

### 3-레이어 전파 복잡성

토글은 `FLEET_REPLACE_SYSTEM_PROMPT` 환경 변수 → `~/.fleet/settings.json` globalOptions → 하드코딩 기본값 false의 3단 우선순위로 전파되었다. 기본값이 항상 옳은 동작인 상황에서 이 복잡성을 유지할 근거가 없었다.

---

## Goals

1. `replaceSystemPrompt` 필드와 관련 전달 경로를 모든 레이어에서 완전 제거한다.
2. Claude Code는 항상 `--append-system-prompt-file`로 하드코딩 고정한다.
3. 기존 `~/.fleet/settings.json`의 `replaceSystemPrompt` 키는 sanitizer의 `allowedKeys` 축소로 자동 드롭(changed=true)한다. 별도 마이그레이션 코드는 작성하지 않는다.
4. `enableMetaphor` 옵션은 모든 계층에서 무변경 유지한다.
5. 영향 5개 패키지 전체 테스트가 green을 유지한다.

---

## Non-Goals

- **`core-unified-agent` 수정**: OpenCode의 `firstPromptPending` prepend, Cursor의 ACP `systemPrompt` 전달, AGENTS.md #7의 provider-aware 영구 주입은 `replaceSystemPrompt` 경로와 독립적인 별개 메커니즘이므로 이번 변경 범위에 포함하지 않는다.
- **Replace 모드의 대체 도입**: 다른 형태로 CLI별 주입 방식을 조작하는 새 설정 항목 추가.
- **명시적 마이그레이션 스크립트**: 기존 `replaceSystemPrompt: true` 설정 파일 사용자를 위한 별도 변환 코드. sanitizer 자동 드롭으로 충분하다.
- **릴리스 타이밍 결정**: 이 엔트리는 구현과 검증 사실만 기록하며 릴리스 시점은 다루지 않는다.

---

## User Stories

이 변경은 운영자-facing 설정 항목 삭제이다. Replace 모드를 명시적으로 활성화하지 않은 모든 사용자(기본값 사용자)는 변화를 인지할 수 없다. Replace를 선택했던 사용자는 설정 저장소에서 키가 드롭되며 Append 모드로 전환된다.

---

## Functional Requirements

### 제거된 표면

| 표면 | 위치 |
|------|------|
| Console Terminal 플러그인 "System Prompt Injection" 토글 | `runtime/fleet-plugins/terminal/client/agent/index.tsx` |
| fleet-cli Mission Control "System prompt" 행 | `runtime/fleet-cli/src/mission-control/controller.ts` |
| `FLEET_REPLACE_SYSTEM_PROMPT` 환경 변수 오버라이드 | `runtime/fleet-cli/src/mission-control/options/resolver.ts` |
| `GlobalOptionsData.replaceSystemPrompt` 타입 필드 | `packages/fleet-infra/src/global-options/types.ts` |
| `AgentCliInjectionContext.replaceSystemPrompt` 타입 필드 | `packages/fleet-admiral/src/agent-cli/types.ts` |

### 고정된 동작

- **Claude Code**: `buildClaudeNativeArgs`에서 `"--append-system-prompt-file"` 무조건 출력. 조건부 분기 완전 제거.
- **Codex**: 변경 없음 — 원래부터 `developer_instructions` profile로 고정.
- **설정 파일 하위호환**: `sanitizeGlobalOptionsData` `allowedKeys = new Set(["version", "enableMetaphor"])` → 기존 `replaceSystemPrompt` 키 자동 드롭, `changed: true` 반환.

### 보존된 표면

`enableMetaphor` 옵션은 env 오버라이드 → globalOptions → default false 우선순위 체인, `~/.fleet/settings.json` 영속, Console UI 토글, settings-routes GET/PUT, fleet-cli Mission Control 행 전 계층 원형 유지.

---

## Acceptance Criteria

- [x] 소스 파일(`.ts`/`.tsx`) 내 `replaceSystemPrompt`, `FLEET_REPLACE_SYSTEM_PROMPT`, `toggleReplaceSystemPrompt`, `--system-prompt-file`(비-append) 잔존 참조 없음 — Sentinel 그렙 확인
- [x] `buildClaudeNativeArgs`가 항상 `"--append-system-prompt-file"` 출력 — fleet-admiral 31/31
- [x] `sanitizeGlobalOptionsData` allowedKeys 축소, `replaceSystemPrompt: true` → `changed: true`로 드롭 — fleet-infra 58/58 (backward-compat 핀 테스트 "drops the legacy replaceSystemPrompt option while preserving enableMetaphor" 포함)
- [x] Mission Control 네비게이션 카운트 정합(System prompt 행 1개 제거 반영) — fleet-cli 227/227
- [x] Terminal 설정 API 1-키 계약(`enableMetaphor`만) — fleet-plugins/terminal 99/99
- [x] fleet-console 514/514 통과

**Sentinel Findings — 최종 Disposition (PR #174, 커밋 92ee77f41)**:

- **Medium-1** (backward-compat 테스트 미pin) → **수정 완료** — `packages/fleet-infra/tests/global-options-store.test.ts`에 테스트 추가(input `{version:1, replaceSystemPrompt:true, enableMetaphor:false}` → `{changed:true, data:{version:1, enableMetaphor:false}}`). fleet-infra 57→58.
- **Medium-2** (cross-field 동시성 → same-field 축소) → **기각(수용)** — 유효 옵션 필드가 `enableMetaphor` 단일뿐이라 두 번째 실 필드가 없음. atomic merge 원자성은 fs-store가 소유·검증. 오버피팅으로 판단해 미도입.
- **Low-1** (terminal AGENTS.md 블록명 stale) → **수정 완료** — "System Prompt / Metaphor" → "System Prompt"(카드 aria-label과 일치).
- **Low-2** (fleet-cli AGENTS.md:33 stale) → **수정 완료** — "Mode, System prompt, and Metaphor" → "Mode and Metaphor".

---

## Open Questions

이 결정은 완결됐으며 열린 질문 없음. Sentinel Low 2건은 PR #174에서 정리 완료. Medium-2(cross-field 동시성)는 오버피팅 기각 결정이며 잔존 부채가 아님.

---

## Related

- [[wiki:guide-004-cli-subagent-injection]] — 외부 CLI spawn 시 native subagent 주입 메커니즘 비교(각 CLI 주입 방식 원본 가이드; 이 결정의 기술적 전제)
- [[wiki:prd-admiral-protocol-single-immutable-fleet-action]] — Admiral Protocol 단일화(Fleet 독트린 Append 계층화 원칙의 선례)