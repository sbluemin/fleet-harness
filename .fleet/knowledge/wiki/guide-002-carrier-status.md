---
id: "guide-002-carrier-status"
title: "Guide - 002 Carrier Status 사용법"
tags: ["guide", "carrier-status", "keybind", "onboarding", "current"]
created: "2026-05-07T15:45:04.197Z"
updated: "2026-05-23T14:47:14.664Z"
version: 2
rawSourceRef: "raw/2026-05-23-guide-002-carrier-status-source-1e912bd9.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-07-guide-002-carrier-status-source-cb364687.md\"},{\"ref\":\"raw/2026-05-23-guide-002-carrier-status-source-1e912bd9.md\",\"title\":\"Guide - 002 Carrier Status 사용법\",\"hash\":\"1e912bd9\"}]"
---
# Carrier Status 사용법

`Alt+O`로 여는 **Carrier Status 오버레이**는 fleet-harness의 중앙 제어판이다. 8개 캐리어의 CLI 백엔드, 모델, Task Force 설정을 여기서 모두 관리한다.

---

## 오버레이 열기 / 닫기

- **열기**: `Alt+O`
- **닫기**: `Esc` 또는 `Alt+O` 재입력 (토글)

---

## 화면 구성

오버레이는 위→아래 순으로 표시된다.

```
╭─────────── Carrier Status ───────────╮
│  ◇ Strategy                          │
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
#1  genesis   claude-sonnet-4-20250514  ·  high  [TF:6]  (Chief Engineer)
│   │         │                            │      │     └ 역할 설명
│   │         │                            │      └ Task Force: 6개 백엔드 설정됨
│   │         │                            └ Reasoning Effort
│   │         └ 현재 모델
│   └ 캐리어 이름
└ 슬롯 번호
```

**배지:**
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
| `N` | 캐리어 이름 편집 |
| `R` | 모든 캐리어 CLI를 기본값으로 초기화 |
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
| `opencode-go` | OpenCode Go CLI |
| `cursor` | Cursor Agent |

### 일괄 변경 (`C`)

2단계로 진행된다.
1. **FROM**: 변경할 CLI 타입 선택 (현재 그 CLI를 쓰는 캐리어가 모두 대상)
2. **TO**: 변경할 목표 CLI 타입 선택

저하(Degraded) 상태의 CLI가 우선 표시되므로 빠른 폴백(fallback) 전환에 유용하다.

---

## Task Force 설정 (`t`)

Task Force 서브오버레이에서 6개 CLI 백엔드 각각에 대해 독립적인 모델과 Effort를 설정한다.

```
╭── Task Force 설정: genesis ──╮
│  claude       sonnet-4  high  │
│  claude-zai   glm-4     —     │
│  codex        o4-mini   low   │
│  cursor       sonnet-4  —     │
│  ...                          │
╰───────────────────────────────╯
```

| 키 | 동작 |
|---|---|
| `↑` / `↓` | 백엔드 선택 |
| `Enter` | 선택된 백엔드 모델 편집 |
| `r` | 선택된 백엔드를 origin 기본값으로 리셋 |
| `Esc` | 닫기 |

`carrier_dispatch` 도구를 사용할 때 Task Force가 설정된 캐리어는 자동으로 다중 백엔드 실행으로 승격된다.

---

## 관련 항목

- [[wiki:guide-001-fleet-harness-overview]] — fleet-harness 전체 소개
- [[wiki:guide-003-fleet-wiki]] — fleet-wiki 사용법