---
id: "carrier-handoff-by-id"
title: "Carrier 결과 핸드오프 — paraphrase 대신 job_id 참조"
tags: ["carrier", "dispatch", "prompt-economy", "handoff", "antipattern", "carrier-jobs", "brevity"]
created: "2026-05-04T18:08:56.485Z"
updated: "2026-05-04T18:08:56.485Z"
version: 1
rawSourceRef: "raw/2026-05-04-carrier-handoff-by-id-source.md"
---
# Carrier 결과 핸드오프 — job_id 참조 패턴

## 문제

Host PI(Admiral)가 캐리어를 연쇄 호출할 때, 선행 캐리어(예: Vanguard/Tempest 정찰)의 결과를 다음 캐리어(예: Genesis/Ohio)의 request 본문에 paraphrase·복사하는 안티패턴이 흔하다. 결과:

- request 본문이 수백~수천 단어로 비대해짐 (자기 컨텍스트의 paraphrase 누적)
- 토큰 낭비 + 캐리어 자율 추론 박탈 (`trust the carrier's own reasoning` 원칙 위반)
- 사실 왜곡 위험 (Host PI의 paraphrase가 원본의 정확한 라인·식별자 인용을 손상)

## 아이디어 — 한 문장

선행 캐리어 결과를 다음 캐리어에 **paraphrase 없이 carrier `job_id`만 전달**하고, 다음 캐리어가 `carrier_jobs(action:"result", format:"full", job_id:...)`로 직접 조회하게 한다.

## 메커니즘 (기존 인프라 재활용)

새 인프라는 필요하지 않다 — 이미 존재하는 채널을 정책으로 활성화하면 된다:

- `carrier_jobs`는 finalized 결과를 **read-many for 3h** 노출 (process-memory summary cache + JobStreamArchive).
- 따라서 "Host PI가 결과 본문을 복사해서 다음 캐리어에 넣는다" 대신 **"Host PI는 `job_id` 한 줄만 전달, 다음 캐리어가 필요 시 직접 fetch한다"** 가 즉시 가능.

## 현재 진행 상태 — 전체 채널화 완료 (2026-05-05)

핸드오프 아이디어의 Prompt-level + Channel-level 도입이 모두 완료되었다. 아래 "적용 surface 후보" 섹션의 1·2·3번이 전부 적용됨 상태로 전환되었으며, Executor MCP 채널 또한 활성화되어 캐리어가 실제로 `carrier_jobs` 도구에 접근할 수 있다.

### Executor MCP 채널 활성화 (적용 완료, 2026-05-04)

`executeWithPool` / `executeOneShot` 세션이 connect 시점에 whitelist-scoped MCP 서버(`EXECUTOR_MCP_TOOL_IDS`, 초기 allowlist `["carrier_jobs"]`)를 수신한다. 캐리어가 실제로 `carrier_jobs(action:"result", format:"full", job_id:...)` 호출이 가능하며, 아카이브 만료(TTL 초과 / `full_invalidated` true) 시 `format:"summary"` fallback도 가능하다.

### Prompt soft 정책 (적용됨, 2026-05-04)

### 적용 좌표 (fleet-core)

- **상수 정의**: `packages/fleet-core/src/admiral/carrier/prompts.ts`에 `export const CARRIER_REQUEST_BREVITY_GUIDELINE` 도입 — `carrier_dispatch` / `carrier_squadron` / `carrier_taskforce` 의 공용 brevity 정책 SSoT.
- **wiring (3 dispatch 계열 도구)**:
  - `admiral/carrier/tool-spec.ts` — `buildCarrierDispatchToolSpec().usageGuidelines` 마지막 항목으로 push
  - `admiral/squadron/prompts.ts` — `SQUADRON_DOCTRINE.usageGuidelines` 마지막 항목으로 push
  - `admiral/taskforce/prompts.ts` — `TASKFORCE_DOCTRINE.usageGuidelines` 마지막 항목으로 push
- **검증**: `pnpm --filter @sbluemin/fleet-core exec tsc --noEmit` → exit 0.

### 상수 본문

> Each request body MUST be ≤ ~300 words and each request block MUST be ≤ 5 sentences. MUST NOT paraphrase or copy your own analysis, reconnaissance output, or system-prompt content into the request — reference prior carrier results by job_id or summarize in one sentence, and trust the carrier to proceed.

해당 텍스트는 `<fleet section="tool-guide" tool="carrier_dispatch">` / `<fleet section="tool-guide" tool="carrier_squadron">` / `<fleet section="tool-guide" tool="carrier_taskforce">` 블록의 Usage guidelines 절에 자동 렌더되어 Host PI 매 세션 system prompt에 노출된다.

### 한계 — 왜 채널 도입이 여전히 필요한가

- Prompt soft 정책은 **권고**이며 LLM 준수 신뢰성에 의존. 동인 자체(자기 컨텍스트 paraphrase)를 채널 차원에서 차단하지는 못함.
- "job_id로 참조하라"는 권고는 있지만, 다음 캐리어가 실제 어떻게 조회하는지의 채널 명시·강제는 부재.
- 따라서 본 엔트리의 핵심 아이디어(새 request-block 또는 캐리어 system prompt Tier2 정책으로 채널화)는 여전히 후속 작업으로 유효.

## 적용 surface 현황

1. **새 선택 request-block** — `<prior_jobs?>` 공용 블록 도입. `PRIOR_JOBS_REQUEST_BLOCK` 상수가 `carrier/prompts.ts`에 정의되고 `CARRIER_COMMON_REQUEST_BLOCKS`를 통해 모든 carrier의 request-block 가이드에 자동 병합됨. `CarrierMetadata.commonRequestBlocks?` 인터페이스 확장으로 per-carrier 공용 블록 추가 가능. **적용 완료** (2026-05-05).
2. **캐리어 system prompt(Tier2) 정책** — `CARRIER_JOBS_SELF_CALL_HINT` SSoT 상수 (`carrier/prompts.ts`)가 8개 built-in persona `principles` 배열에 **공용 상수 참조**로 주입됨 (기존 `principles`가 있으면 spread `[CARRIER_JOBS_SELF_CALL_HINT, ...existing]`, sentinel/tempest는 신규 단일 원소 배열로 선언 — 문자열 복사 없이 단일 SSoT를 참조). `format:"full"` + `format:"summary"` fallback 계약 명시. **적용 완료** (2026-05-05).
3. **공용 brevity 정책에 명시 (Host PI 측 prompt soft 가드)** — `CARRIER_REQUEST_BREVITY_GUIDELINE`이 `<prior_jobs>` 블록을 통한 job_id 전달 패턴 + `carrier_jobs(action:"result", format:"full", job_id:...)` / `format:"summary"` 폴백 계약을 명시. **적용 완료** (2026-05-04→05).

## 기대 효과

- request 비대화의 가장 큰 동인(자기 컨텍스트 복사)을 채널 차원에서 제거.
- 캐리어 결과의 fidelity 보존 (paraphrase에 의한 정보 손실 없음).
- 정찰 → 실행 캐리어 체인의 자연스러운 핸드오프 패턴 확립.

## 미결 / 후속 검토 필요

- Executor MCP 채널 및 `<prior_jobs>` 블록의 실제 사용 사례 축적 후 prompt 텍스트 조정 여부 검토.
- 3h TTL 만료 이후 summary도 소멸된 경우의 fallback — 현재 교리는 `format:"summary"` 시도이나, summary 자체가 없는 엣지 케이스 처리는 캐리어 자율에 맡김.

## 동기

본 아이디어는 캐리어 호출 시 Host PI가 비대한 request를 생성하는 안티패턴에 대한 진단 보고에서 도출된 근본 개선 방안 중 하나다. prompt-level brevity 가드(soft 정책)는 동기를 약화시키지만 동인 자체를 제거하지는 못하므로, 채널 차원의 핸드오프가 보강 수단으로 검토 가치가 있다.