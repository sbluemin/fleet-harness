---
id: "guide-002-carrier-status"
title: "Guide - 002 Carrier Status 사용법"
tags: ["guide", "carrier-status", "keybind", "onboarding", "current"]
created: "2026-05-07T15:45:04.197Z"
updated: "2026-05-07T15:45:04.197Z"
version: 1
rawSourceRef: "raw/2026-05-07-guide-002-carrier-status-source-cb364687.md"
---
# Carrier Status 사용법

`Alt+O`로 여는 **Carrier Status 오버레이**는 fleet-harness의 중앙 제어판이다. 8개 캐리어의 CLI 백엔드, 모델, Sortie · Squadron · Task Force 설정을 여기서 모두 관리한다.

---

## 오버레이 열기 / 닫기

- **열기**: `Alt+O`
- **닫기**: `Esc` 또는 `Alt+O` 재입력 (토글)

---

## 화면 구성

오버레이는 위→아래 순으로 표시된다.

```
╭─────────── Carrier Status ───────────╮
│  ◇ Strategy         [서비스 상태]    │
│    #1  nimitz   claude-sonnet ...     │
│    #2  kirov    claude-sonnet ...     │
│                                      │
│  ◇ Planning                          │
│    ...                               │
│                                      │
│  ◇ Operations                        │
│    ...                               │
├──────────────────────────────────────┤
│  [키바인드 힌트]                      │
╰──────────────────────────────────────╯
```

### 그룹 색상

| 그룹 | 색상 | 소속 캐리어 |
|---|---|---|
| Strategy | 파랑 | Nimitz, Kirov |
| Planning | 보라 | Ohio |
| Operations | 초록 | Genesis, Sentinel, Vanguard, Tempest, Chronicle |

### 캐리어 행 구성

```
#1  genesis   claude-sonnet-4-20250514  ·  high  [TF:6] [SQ]  (Chief Engineer)
│   │         │                            │      │      │     └ 역할 설명
│   │         │                            │      │      └ Squadron 활성화 중
│   │         │                            │      └ Task Force: 6개 백엔드 설정됨
│   │         │                            └ Reasoning Effort
│   │         └ 현재 모델
│   └ 캐리어 이름
└ 슬롯 번호
```

**배지:**
- `✕ sortie off` (빨강) — 해당 캐리어가 비활성화됨. 도구 위임 시 제외된다.
- `→SQ` / `[SQ]` (보라) — Squadron 활성화 중. `carrier_squadron` 대상이다.
- `[TF:N]` (파랑) — Task Force에 N개 백엔드가 설정됨.

---

## 키바인드 레퍼런스

### Browse 모드 (기본)

| 키 | 동작 |
|---|---|
| `↑` / `↓` | 캐리어 선택 이동 |
| `Tab` | 선택된 캐리어 상세 정보 토글 |
| `Enter` | 모델 편집 모드 진입 |
| `c` | CLI 타입 변경 (선택된 캐리어 단독) |
| `C` | CLI 타입 일괄 변경 (FROM → TO 2단계 선택) |
| `R` | 모든 캐리어 CLI를 기본값으로 초기화 |
| `d` | Sortie 활성화/비활성화 토글 |
| `S` | Squadron 활성화/비활성화 토글 |
| `t` | Task Force 설정 오버레이 열기 |
| `Esc` / `Alt+O` | 오버레이 닫기 |

### 모델 편집 모드 (`Enter` 진입)

모델 목록에서 `↑↓`로 선택, `Enter`로 확정. 선택한 모델이 Reasoning Effort를 지원하면 자동으로 Effort 선택 단계로 전환된다.

---

## CLI 타입 변경 (`c` / `C`)

### 단일 변경 (`c`)

선택된 캐리어 하나의 CLI 백엔드를 변경한다. 6개 옵션 중 선택:

| CLI | 설명 |
|---|---|
| `claude` | Claude Code (기본) |
| `claude-zai` | Claude Code with Z.AI GLM |
| `claude-kimi` | Claude Code with Moonshot Kimi |
| `codex` | OpenAI Codex |
| `gemini` | Google Gemini CLI |
| `opencode-go` | OpenCode Go CLI |

### 일괄 변경 (`C`)

2단계로 진행된다.
1. **FROM**: 변경할 CLI 타입 선택 (현재 그 CLI를 쓰는 캐리어가 모두 대상)
2. **TO**: 변경할 목표 CLI 타입 선택

저하(Degraded) 상태의 CLI가 우선 표시되므로 빠른 폴백(fallback) 전환에 유용하다.

---

## Sortie 토글 (`d`)

Sortie를 **off**로 설정하면 해당 캐리어는 도구 위임(`carrier_dispatch`, `carrier_squadron` 등)에서 제외된다. 캐리어 이름과 배지가 모두 흐리게 표시된다.

Status Bar(Editor 위 상태줄)에도 실시간으로 반영된다.

---

## Squadron 토글 (`S`)

`[SQ]` 배지가 붙은 캐리어는 `carrier_squadron` 도구의 대상이 된다. Admiral이 병렬 서브태스크를 fan-out할 때 해당 캐리어 인스턴스가 사용된다.

---

## Task Force 설정 (`t`)

Task Force 서브오버레이에서 6개 CLI 백엔드 각각에 대해 독립적인 모델과 Effort를 설정한다.

```
╭── Task Force 설정: genesis ──╮
│  claude       sonnet-4  high  │
│  claude-zai   glm-4     —     │
│  codex        o4-mini   low   │
│  gemini       pro-2.5   —     │
│  ...                          │
╰───────────────────────────────╯
```

| 키 | 동작 |
|---|---|
| `↑` / `↓` | 백엔드 선택 |
| `Enter` | 선택된 백엔드 모델 편집 |
| `r` | 선택된 백엔드를 origin 기본값으로 리셋 |
| `Esc` | 닫기 |

`carrier_taskforce` 도구를 사용할 때 각 백엔드가 이 설정으로 실행된다.

---

## 서비스 상태 표시

각 그룹 헤더 옆에 해당 CLI 계열의 실시간 헬스 상태가 표시된다.

| 배지 | 의미 |
|---|---|
| `OP` (초록) | 정상 운영 |
| `DEG` (노랑) | 성능 저하 |
| `OUT` (빨강) | 서비스 중단 |
| `MNT` (주황) | 점검 중 |
| `UNK` (회색) | 상태 불명 |

---

## 관련 항목

- [[wiki:guide-001-fleet-harness-overview]] — fleet-harness 전체 소개
- [[wiki:guide-003-fleet-wiki]] — fleet-wiki 사용법