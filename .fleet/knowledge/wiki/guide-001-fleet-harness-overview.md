---
id: "guide-001-fleet-harness-overview"
title: "Guide - 001 fleet-harness 소개"
tags: ["guide", "fleet-harness", "overview", "onboarding", "current"]
created: "2026-05-07T15:44:30.628Z"
updated: "2026-05-07T15:57:26.922Z"
version: 5
rawSourceRef: "raw/2026-05-07-guide-001-fleet-harness-overview-source-565723ea.md"
---
# fleet-harness 소개

fleet-harness는 [pi-coding-agent](https://github.com/badlogic/pi-mono) 기반의 멀티-LLM 오케스트레이션 키트다. Claude Code, Codex CLI, Gemini CLI 등 강력한 CLI AI 도구 8개를 **단일 인터페이스**에서 지휘한다.

---

## 핵심 차별점

단순한 병렬 API 호출 래퍼가 아니다. fleet-harness는 **해군 함대 메타포**를 통해 에이전트 간 역할과 책임을 명확히 구분한다.

| 일반 멀티-LLM 도구 | fleet-harness |
|---|---|
| 동일 모델 여러 인스턴스 | 8개 전문 역할 캐리어 |
| 수동 결과 취합 | Admiral이 합성·라우팅 |
| 순차 또는 단순 병렬 | 7단계 Fleet Action Protocol |
| 없음 | Agent Panel 실시간 스트리밍 모니터링 |
| 없음 | Fleet Wiki 지식 베이스 통합 |

---

## 제공 CLI

fleet-harness는 용도에 따라 4개의 CLI 진입점을 제공한다. fleet, fleet-dev, fleet-exp는 내부적으로 pi CLI를 감싸는 얇은 래퍼이며, 환경변수 조합으로 동작 모드가 결정된다.

### 주 CLI

| CLI | 설명 |
|---|---|
| fleet | **기본 운영 진입점.** 빌드된 프로덕션 익스텐션(dist/index.js)을 로드한다. 일상적인 작업에 사용한다. |
| fleet-dev | **개발 모드.** 소스(src/index.ts)를 직접 로드하며 FLEET_HARNESS_DEV=1 + PI_EXPERIMENTAL=1을 설정한다. RISEN 개발 컨텍스트와 Admiral 7단계 프로토콜이 활성화된다. 익스텐션 개발 시 사용한다. |
| fleet-exp | **실험적 모드.** 프로덕션 dist를 로드하되 PI_EXPERIMENTAL=1만 설정한다. 개발 슬레이트 없이 실험적 PI 기능을 사용할 때 쓴다. |

### 웹 UI

| CLI | 설명 |
|---|---|
| fleet-wiki | **Fleet Wiki 웹 UI 서버.** 로컬 HTTP 서버를 detached 프로세스로 기동하고 브라우저를 자동으로 연다. 127.0.0.1:3737 기본. --stop으로 종료. 자세한 사용법은 [[wiki:fleet-wiki-cli-onboarding]] 참조. |

### 모드별 환경변수 요약

| 환경변수 | 값 | 효과 |
|---|---|---|
| FLEET_HARNESS_DEV | 1 | Admiral RISEN 개발 컨텍스트 활성화 (7단계 Fleet Action Protocol 프롬프트) |
| PI_EXPERIMENTAL | 1 | PI 실험적 기능 활성화 |

---

## 계층 구조

```
대원수 (Admiral of the Navy)
  └─ 사용자. 전략적 목표를 제시한다.

제독 (Admiral)
  └─ PI 호스트 에이전트. 작전을 계획하고 캐리어를 파견한다.

함장 (Captain)
  └─ 각 캐리어의 페르소나. 전문 역할로 실행을 담당한다.
```

---

## 8개 캐리어

| 캐리어 | 역할 | 담당 CLI |
|---|---|---|
| **Nimitz** | 전략 판단 · 설계 결정 (읽기 전용) | Claude Code |
| **Kirov** | 실행 계획 수립 (plan_file 작성) | Claude Code |
| **Genesis** | 코드 구현 워크호스 | Codex |
| **Ohio** | 다단계 계획 실행 (plan_file 소비) | Codex |
| **Sentinel** | QA · 보안 감사 · 버그 사냥 | Codex |
| **Vanguard** | 코드베이스 정찰 · 내부 탐색 | Codex |
| **Tempest** | 외부 GitHub 저장소 정보 수집 | Gemini |
| **Chronicle** | 문서화 · 릴리즈 노트 · 변경 영향 요약 | Gemini |

---

## Fleet Action Protocol

모든 작업은 **7단계 프로토콜**을 따른다.

```
1. 정찰 (Vanguard 필수)
2. 설계 검토 (조건부)
3. 작업 계획
4. 실행
5. 리팩토링 (조건부)
6. 리뷰 사이클 (코드 + 보안)
7. 문서 업데이트
```

Alt+1로 Fleet Action Protocol을 활성화한다. Editor 상단 테두리에 ⚓ Fleet Action 라벨이 표시된다.

---

## 주요 단축키 한눈에 보기

| 키 | 기능 |
|---|---|
| Alt+1 | Fleet Action Protocol 전환 |
| Alt+O | Carrier Status 오버레이 (캐리어 설정) |
| Alt+P | Agent Panel 표시/숨김 |
| Alt+T | Bridge 모드 (단일 캐리어 직접 쉘) |
| Alt+/ | 설정 오버레이 |
| Alt+M | 입력 텍스트 Directive Refinement |
| Alt+G | Grand Fleet 상태 오버레이 |
| Alt+. | 키바인딩 목록 팝업 |

---

## 주요 슬래시 명령어

| 명령어 | 기능 |
|---|---|
| /fleet:wiki:menu | Fleet Wiki 허브 |
| /fleet:metaphor:settings | Worldview · 작전명 · Directive 설정 |
| /fleet:admiral:report | Admiral Completion Report 요청 |
| /fleet:jobs:settings | Carrier Jobs 설정 |

---

## 관련 항목

- [[wiki:guide-002-carrier-status]] — Carrier Status 사용법
- [[wiki:guide-003-fleet-wiki]] — fleet-wiki 사용법
- [[wiki:fleet-wiki-cli-onboarding]] — fleet-wiki 웹 서버 CLI 상세