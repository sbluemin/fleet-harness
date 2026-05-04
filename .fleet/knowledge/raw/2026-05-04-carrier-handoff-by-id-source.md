---
id: "carrier-handoff-by-id-source"
created: "2026-05-04T18:08:56.485Z"
sourceType: "inline"
title: "Fleet Carrier Request Bloat Review — Idea ① + Applied Brevity Guideline (2026-05-04)"
tags: ["carrier", "dispatch", "prompt-economy", "handoff", "antipattern", "carrier-jobs", "brevity"]
---
근본 개선 방안 ① — Reference-by-ID 핸드오프 (+ 현재 적용된 ② 부분 보강)

## 핵심 아이디어 (①)

정찰 결과를 다음 캐리어가 직접 조회하도록 carrier job_id로 referencing 한다.

- 새 선택 태그: <recon_ref>carrier:xxxx</recon_ref> (Vanguard/Tempest job_id)
- 캐리어 측 system prompt에 "선행 정찰 결과는 carrier_jobs(action:result, format:full, job_id:…)로 직접 조회"를 명시
- 결과: Host LLM이 정찰 본문을 paraphrase·복사할 동기 자체가 사라진다.

## 기존 인프라 재활용

- carrier_jobs(action:"result", format:"full")는 finalized 결과를 read-many for 3h 노출.
- process-memory summary cache + JobStreamArchive 채널 사용.
- 새 인프라 없이 prompt 정책 + 선택 태그 도입만으로 활성화 가능.

## 현재 적용 사실 (2026-05-04 세션, ② 부분 적용)

본 핸드오프 아이디어의 채널 도입 전 단계로, prompt soft 정책 1줄이 이미 fleet-core에 적용되어 Host PI 시스템 프롬프트에 "job_id 참조" 권고가 노출 중.

적용 좌표:
- 상수 정의: packages/fleet-core/src/admiral/carrier/prompts.ts → export const CARRIER_REQUEST_BREVITY_GUIDELINE
- wiring 3개:
  - admiral/carrier/tool-spec.ts buildCarrierDispatchToolSpec().usageGuidelines
  - admiral/squadron/prompts.ts SQUADRON_DOCTRINE.usageGuidelines
  - admiral/taskforce/prompts.ts TASKFORCE_DOCTRINE.usageGuidelines
- 검증: pnpm --filter @sbluemin/fleet-core exec tsc --noEmit → exit 0.

상수 본문(영문 원문):
"Each request body MUST be ≤ ~300 words and each request block MUST be ≤ 5 sentences. MUST NOT paraphrase or copy your own analysis, reconnaissance output, or system-prompt content into the request — reference prior carrier results by job_id or summarize in one sentence, and trust the carrier to proceed."

이 텍스트는 <fleet section="tool-guide" tool="carrier_dispatch"> / carrier_squadron / carrier_taskforce 블록의 Usage guidelines 절에 자동 렌더되어 Host PI 매 세션 시스템 프롬프트에 노출된다.

## ① 핵심 아이디어가 여전히 유효한 이유

- soft 정책은 LLM 준수 신뢰성에 의존하는 권고. 동인 자체를 채널 차원에서 차단하지는 못함.
- "job_id로 참조하라"는 문구는 Host PI 측 권고이며, 캐리어 측이 실제 어떻게 조회하는지의 채널 명시·강제는 부재.
- 따라서 새 request-block 도입 또는 캐리어 system prompt(Tier2) 정책으로의 채널화는 후속 작업으로 유효.

## 기대 효과

- request 비대화의 가장 큰 동인(자기 컨텍스트 복사) 제거.
- 캐리어 결과의 fidelity 보존 (paraphrase 손실 없음).
- 정찰 → 실행 캐리어 체인의 자연스러운 핸드오프 패턴 확립.

## 미결

- 캐리어가 carrier_jobs에 접근 가능한지(MCP 토큰 라우팅) 확인 필요.
- 새 태그 도입 시 roster 렌더 + validateRequiredRequestBlocks 정합 검토.
- 3h 만료 후 graceful fallback 정책.

본 엔트리는 카리어 호출 시 비대한 request 생성에 대한 진단 보고("Carrier Request Prompt Bloat Analysis", 2026-05-04, Admiral 세션)의 ① 아이디어 + ②의 prompt soft 가드 부분만 ingest 대상이다. 다른 방안(active-only 프로토콜 렌더링, few-shot exemplar, persona description 압축)은 본 엔트리의 범위가 아니다.