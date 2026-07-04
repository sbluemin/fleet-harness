---
id: "prd-remove-system-prompt-injection-source"
created: "2026-07-04T19:26:26.475Z"
sourceType: "inline"
title: "System Prompt Injection 제거 작전 증거 (Vanguard + Genesis + Sentinel, 최종 disposition 반영)"
tags: ["decision-history", "fleet-admiral", "fleet-infra", "fleet-cli", "agent-cli", "system-prompt", "cognitive-debt", "terminal-plugin"]
contentHash: "fadb48c3"
---
## Vanguard 기능 지도 (carrier:aca92db8)

### replaceSystemPrompt 토글 구조
- 타입: `GlobalOptionsData.replaceSystemPrompt?: boolean` (packages/fleet-infra/src/global-options/types.ts:3)
- 기본값: undefined(=false=Append). 로드 실패 폴백도 false.
- false(기본): Claude → `--append-system-prompt-file`, Codex → developer_instructions(항상)
- true(Replace): Claude → `--system-prompt-file`. Codex/OpenCode/Cursor는 플래그 무시.

### CLI별 실효성
- Claude Code: append / replace 모두 지원(토글 실효)
- Codex: 항상 developer_instructions → replaceSystemPrompt 무시
- OpenCode: firstPromptPending prepend → replaceSystemPrompt 무시
- Cursor: ACP systemPrompt 전달 → replaceSystemPrompt 무시
→ 4개 CLI 중 Claude Code 한 개에만 실효하는 비대칭 옵션

### 노출 표면
1. Console Terminal 플러그인 Settings UI: SettingToggleRow "System Prompt Injection" (client/agent/index.tsx:482-523)
2. fleet-cli Mission Control: "System prompt" 행 (id: option:system-prompt, controller.ts)
3. 환경 변수: FLEET_REPLACE_SYSTEM_PROMPT
4. 저장소: ~/.fleet/settings.json의 replaceSystemPrompt 키
5. 3-레이어 전달: env override → globalOptions → default false

## Genesis 구현 결과 (carrier:1e2d1e9c)

### 변경 파일 28개, 5개 패키지
- packages/fleet-admiral: AgentCliInjectionContext/InjectAgentCliProfileOptions에서 replaceSystemPrompt 제거. builders/claude.ts 조건부 systemPromptArg → "--append-system-prompt-file" 하드코딩.
- packages/fleet-infra: GlobalOptionsData 타입에서 replaceSystemPrompt 제거. sanitizeGlobalOptionsData allowedKeys = ["version", "enableMetaphor"]으로 축소 → 기존 파일의 replaceSystemPrompt 키 자동 드롭(changed=true), 별도 마이그레이션 없음.
- runtime/fleet-cli: SessionOptions/SessionOptionsRuntime에서 replaceSystemPrompt/toggleReplaceSystemPrompt 제거. resolver.ts에서 FLEET_REPLACE_SYSTEM_PROMPT env 처리 블록 전체 제거. controller.ts에서 System prompt 행 제거. 네비게이션 인덱스 조정(4→3, 7→6, 6→5, 3→2회 down).
- runtime/fleet-plugins/terminal: TerminalSettingsState 1-키 계약(enableMetaphor만). client UI에서 SettingToggleRow "System Prompt Injection" 블록 완전 제거.
- runtime/fleet-console: 관련 테스트 갱신.

### enableMetaphor 무변경 보존
env → globalOptions → default false 체인, 영속, UI 토글, GET/PUT 라우트 모두 원형 유지.

### core-unified-agent 무수정
OpenCode의 firstPromptPending prepend, Cursor의 ACP systemPrompt, AGENTS.md #7의 provider-aware 영구 주입은 replaceSystemPrompt 경로와 독립적인 별개 메커니즘이므로 수정하지 않음.

### 초기 테스트 결과
- fleet-admiral: 31/31 통과
- fleet-infra: 57/57 통과(후속 +1 추가로 58/58)
- fleet-cli: 227/227 통과
- fleet-plugins/terminal: 99/99 통과
- fleet-console: 514통과/22스킵(536 전체)
- 소스 파일 내 replaceSystemPrompt 잔존 참조 없음(grep 확인)

## Sentinel QA (carrier:039ea32e)

### 판정: PASS — Critical 0, High 0
Medium 2건(커버리지 누락), Low 2건(stale 문서). 기능 회귀 및 잔재 없음.

Medium 1: global-options-store.test.ts — boolean replaceSystemPrompt:true 입력 → enableMetaphor 보존 + changed:true 드롭 시나리오 미검증(동작은 정확, 회귀 방어선 부재).
Medium 2: 동시 쓰기 테스트가 cross-field 동시성에서 same-field last-write-wins로 축소.
Low 1: terminal/AGENTS.md "System Prompt / Metaphor" 블록명 stale(실제는 Metaphor만 남음).
Low 2: runtime/fleet-cli/AGENTS.md:33 "Mode, System prompt, and Metaphor" → "Mode and Metaphor" 미수정.

### 최종 Disposition (제독 게이트 확정, PR #174 커밋 92ee77f41)
- Medium-1: 수정 완료. packages/fleet-infra/tests/global-options-store.test.ts에 "drops the legacy replaceSystemPrompt option while preserving enableMetaphor" 테스트 추가(input {version:1, replaceSystemPrompt:true, enableMetaphor:false} → {changed:true, data:{version:1, enableMetaphor:false}}). fleet-infra 58/58.
- Medium-2: 기각(수용). 유효 옵션 필드가 enableMetaphor 단일뿐이라 cross-field 테스트에 필요한 두 번째 실 필드가 없음. atomic merge 원자성은 fs-store가 소유·검증. 오버피팅 판단으로 미도입.
- Low-1: 수정 완료. terminal/AGENTS.md "System Prompt / Metaphor" → "System Prompt"(카드 aria-label과 일치).
- Low-2: 수정 완료. fleet-cli/AGENTS.md:33 "Mode, System prompt, and Metaphor" → "Mode and Metaphor".

### Positive 확인
- buildClaudeNativeArgs 항상 "--append-system-prompt-file" 출력(분기 완전 제거)
- 터미널 설정 계약 정합: isTerminalSettingsBody = 1키 {enableMetaphor:boolean} 강제
- backward compat 동작: sanitizeGlobalOptionsData allowedKeys 축소로 기존 파일 replaceSystemPrompt 안전 드롭
- Mission Control 네비게이션 인덱스 산술 일치