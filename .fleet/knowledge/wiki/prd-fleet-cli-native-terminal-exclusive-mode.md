---
id: "prd-fleet-cli-native-terminal-exclusive-mode"
title: "PRD: fleet-cli native terminal exclusive mode 및 전역 단축키/모드 폐기"
tags: ["decision-history", "fleet-cli", "native-terminal", "exclusive-mode", "keyboard", "mouse", "pty", "cognitive-debt"]
created: "2026-06-13T07:06:36.206Z"
updated: "2026-06-13T07:11:05.945Z"
version: 1
rawSourceRef: "raw/2026-06-13-prd-fleet-cli-native-terminal-exclusive-mode-source-f2d75ca1.md"
template_id: "prd"
rawSourceRefs: "[{\"ref\":\"raw/2026-06-13-prd-fleet-cli-native-terminal-exclusive-mode-source-f2d75ca1.md\",\"title\":\"PRD: fleet-cli native terminal exclusive mode 및 전역 단축키/모드 폐기\",\"hash\":\"f2d75ca1\"}]"
---
## Overview

fleet-cli는 기존에 외부 터미널 위에 alt-screen과 xterm-headless를 합성한 2-pane 구조로 동작했다. 이 구조에서는 마우스 드래그 선택이 외부 터미널의 네이티브 선택 메커니즘과 충돌하여 구조적으로 제약이 있었다. 본 문서는 이 제약을 우회하기 위해 자식 Agent CLI에 실제 TTY를 양도하는 native terminal 독점 모드를 도입하고, 함께 폐기한 전역 단축키/모드 시스템의 결정 히스토리를 기록한다.

## Problem

- 기존 2-pane 합성 구조는 호스트가 외부 터미널의 마우스와 키보드 이벤트를 가로채 가공한 뒤 자식에 전달해야 했다. 이로 인해 사용자는 자식 애플리케이션의 네이티브 마우스 드래그 선택, 터미널 기본 복사/붙여넣기, 기타 터미널 에뮬레이터 기능을 사용할 수 없었다.
- 전역 단축키와 SIGINT 가로채기, MIRROR/DEDICATED 모드 시스템은 native 모드와 non-native 모드 모두에서 호스트가 터미널 이벤트를 선점하는 설계를 전제로 했다. native 모드에서는 이런 호스트 중간 계층이 오히려 자식 CLI의 기대 lifecycle과 충돌할 수 있다.
- Fleet 종료 제어가 호스트 글로벌 단축키에 의존하면, 자식 CLI의 정상 종료 시퀀스와 무관하게 강제 종료될 위험이 있다.

## Goals

- `--native` 옵션을 통해 자식 Agent CLI가 실제 TTY를 직접 소유하는 독점 모드를 제공한다.
- native 모드와 기존 2-pane 합성 모드를 별도 부팅 경로로 유지하여 기존 모드의 동작을 회귀 없이 보존한다.
- 전역 단축키, SIGINT 가로채기, MIRROR/DEDICATED 모드 시스템을 native/non-native 공통 폐기한다.
- Fleet 종료 제어는 런처의 Exit 처리와 자식 lifecycle에 위임한다.
- carrier mid-session reminder를 자식 PTY master에 programmatic write할 수 있는 I/O 구조를 확보한다.

## Non-Goals

- 기존 `--native` 플래그가 가진 Fleet 시스템 프롬프트/MCP 주입 스킵 의미를 변경하지 않는다. 이는 별개 기능으로 보존한다.
- 2-pane 합성 모드를 제거하거나 기능을 축소하지 않는다.
- 자식 CLI의 낮은 수준 PTY 프로토콜이나 신호 처리 세부사항을 변경하지 않는다.
- 일반적인 키보드/마우스 이벤트 라우팅을 위해 호스트측 인코딩/디코딩 라이브러리를 새로 도입하지 않는다.

## User Stories

- 사용자로서, 나는 Fleet을 native 모드로 실행하여 Agent CLI가 터미널의 마우스, 키보드, 복사/붙여넣기 기능을 직접 사용하도록 할 수 있다.
- 운영자로서, 나는 Fleet이 SIGINT를 가로채지 않고 자식 CLI가 자체 신호 처리를 하도록 신뢰할 수 있다.
- 기여자로서, 나는 native 모드와 합성 모드가 완전히 분리된 코드 경로임을 한눈에 파악할 수 있다.

## Functional Requirements

- `--native` 옵션이 활성화되면 Fleet은 합성 2-pane 렌더링을 초기화하지 않고 자식 Agent CLI를 실제 TTY에 붙여 실행한다.
- native 모드에서는 호스트가 글로벌 단축키를 인터셉트하지 않는다.
- native 모드와 non-native 모드 모두 MIRROR/DEDICATED 모드 시스템을 사용하지 않는다.
- Fleet은 raw mode에서 기본 터미널 제어 문자를 가로채지 않고 자식 PTY로 그대로 전달해야 한다.
- carrier reminder나 기타 중재 메시지를 자식 PTY master에 programmatic write할 수 있어야 한다.
- native 모드는 launch 전/후 Mission Control 런처를 표시하고, 하단 Fleet PTY(Mission Bridge/Job Bar)는 생성하지 않는다.
- 자식 CLI가 종료되면 Fleet은 종료되지 않고 Mission Control 런처로 복귀한다. 사용자는 런처에서 다른 CLI를 다시 실행할 수 있다. Fleet 종료는 런처의 Exit 선택 또는 프로세스 lifecycle 신호를 통해서만 이뤄지며, 별도의 글로벌 종료 단축키는 제공되지 않는다.

## Acceptance Criteria

- `--native` 옵션으로 실행했을 때 자식 CLI는 TTY를 갖는다.
- native 모드에서 Ctrl+C는 자식 CLI의 신호 처리 정책에 따라 동작한다.
- native 모드와 non-native 모드 간 전환은 재실행을 통해서만 가능하다.
- reminder 주입이 자식 PTY master에 실제로 도달한다.
- 자식 CLI 종료 후 Mission Control 런처가 다시 표시되어 다른 CLI를 재실행할 수 있다.
- 기존 2-pane 모드에서 마우스, 키보드, 모드 전환 동작이 이전과 동일하게 유지된다.

## Open Questions

- 자식 CLI가 비정상 종료되었을 때 Fleet이 재시작할지 아니면 그대로 종료할지의 정책은 별도 PRD에서 다루는가?
- raw passthrough 시 터미널 크기 변경(resize) 이벤트를 어떤 빈도로 동기화할 것인가?

## Decision Context

- 초기 구현은 child_process spawn `stdio:"inherit"`로 자식에 실 TTY를 양도했으나, inherit는 부모(fleet)가 자식 stdin 핸들을 갖지 못해 carrier mid-session reminder를 자식에 주입할 수 없는 한계가 있었다.
- 대안 stdio `["pipe","inherit","inherit"]`(stdin만 pipe)는 자식 stdin이 비-TTY가 되어 자식 CLI가 raw mode/마우스 입력을 거부할 위험이 커 기각.
- 최종 채택: node-pty raw passthrough — 자식을 PTY로 감싸 stdin/stdout 모두 진짜 TTY를 유지하면서, fleet이 PTY master로 (a) 실 터미널과 byte 양방향 중계, (b) carrier reminder 주입을 모두 수행. xterm-headless 렌더링은 미사용(순수 passthrough).
- 입력 무손실을 위해 호스트의 PtyHost.write(encodeTerminalInput, CSI-u 변환)를 우회하고 ipty.write로 직접 전달한다.

## Related

- [[wiki:decision-fleet-cli-mouse-input]] — fleet-cli 마우스 입력 아키텍처 결정 히스토리
- [[wiki:prd-tui-keyboard-protocol-architecture]] — Fleet TUI Keyboard Protocol & Keybinding Registry Architecture