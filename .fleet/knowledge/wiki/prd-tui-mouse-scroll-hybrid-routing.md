---
id: "prd-tui-mouse-scroll-hybrid-routing"
title: "PRD: Fleet TUI Mouse Scroll Hybrid Routing"
tags: ["fleet-tui", "fleet-agent", "mouse-protocol", "scroll", "architecture", "shipped"]
created: "2026-05-23T15:39:52.623Z"
updated: "2026-05-23T15:42:55.604Z"
version: 1
rawSourceRef: "raw/2026-05-23-prd-tui-mouse-scroll-hybrid-routing-source-bfe0d84c.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-23-prd-tui-mouse-scroll-hybrid-routing-source-bfe0d84c.md\",\"title\":\"PRD: Fleet TUI Mouse Scroll Hybrid Routing\",\"hash\":\"bfe0d84c\"}]"
---
## Overview

Fleet TUI dedicated-cli에 마우스 휠 입력을 통한 스크롤 탐색 기능을 추가하고, 외부 터미널의 마우스 프로토콜 제어권을 Fleet TUI가 직접 소유하는 하이브리드 라우팅 아키텍처를 확립했다. 이 결정은 사용자가 Dedicated PTY child 프로세스의 출력 이력을 마우스 휠로 탐색할 수 없었던 인지 부채를 해소하기 위해 남겨졌다.

## Problem

이전에는 다음과 같은 마찰이 지속적으로 발생했다.

마우스 입력 처리의 부재가 있었다. DECSET 마우스 시퀀스가 외부 터미널로 전송되지 않았고, SGR 파서가 존재하지 않아 마우스 이벤트 자체를 수신할 수 없었다.

스크롤 탐색이 불가능했다. 사용자는 Dedicated PTY의 shell 출력 이력을 마우스 휠로 탐색할 수 없었으며, xterm headless 기반의 scrollback을 외부 수단으로 조작할 방법이 없었다.

라우팅 정책 혼란이 우려됐다. 마우스 이벤트가 발생했을 때 Fleet이 소비해야 하는지 child 프로세스에 전달해야 하는지를 구분하는 정책이 없어, 잘못된 소비로 child 마우스 애플리케이션이 물력화되거나 잘못된 패스스루로 scrollback 탐색이 불가능한 상황이 예상되었다.

이러한 마찰의 구조적 원인은 "터미널 안의 터미널" 구조였다. Fleet TUI는 외부 터미널 위에 alt screen과 xterm headless 기반의 자체 scrollback을 운영한다. 외부 터미널이나 tmux의 기본 scrollback은 Fleet의 렌더링 출력 이력이지, Dedicated PTY child의 출력 이력이 아니다. 따라서 Fleet이 직접 마우스 프로토콜을 소유하지 않으면 xterm headless scrollback을 조작할 수 없으며, 단순히 child에 마우스 이벤트를 패스스루하면 normal buffer scrollback 탐색은 불가능해진다.

## Goals

- 사용자가 Dedicated PTY child 프로세스의 출력 이력을 마우스 휠로 직접 탐색할 수 있게 한다.
- 외부 터미널의 마우스 프로토콜 제어권을 Fleet TUI가 직접 소유하여, 중간에서의 상태 불일치와 예측 불가능한 동작을 제거한다.
- child 프로세스가 마우스 모드를 명시적으로 요청할 때는 좌표 보정 후 이벤트를 패스스루하여, vim, htop 등 기존 마우스 지원 애플리케이션의 정상 동작을 보존한다.
- tmux 내부와 외부 터미널에서 일관된 마우스 스크롤 동작을 제공한다.

## Non-Goals

- 외부 터미널 에뮬레이터나 멀티플렉서 자체의 마우스 프로토콜 표준 변경.
- Fleet PTY 영역(하단)의 마우스 스크롤 확장 — 해당 영역은 콘텐츠 양이 적어 별도의 scrollback 조작이 필요하지 않다.
- 마우스 드래그를 이용한 앱 내부 텍스트 선택 시스템 구현.
- DECSET 1007(alternateScroll)을 통한 화살표 키 변환 방식 도입.

## User Stories

- **As a** 운영자, **when** Dedicated PTY에서 shell 명령을 실행한 후 긴 출력이 발생했을 때, **then** 마우스 휠로 이전 출력 영역을 스크롤하여 확인할 수 있다.
- **As a** 운영자, **when** Dedicated PTY에서 vim이나 htop 등 마우스 지원 애플리케이션을 실행했을 때, **then** 해당 애플리케이션의 마우스 기능이 정상적으로 작동한다.
- **As a** 운영자, **when** tmux 내부에서 Fleet TUI를 사용할 때, **then** 마우스 휠 스크롤이 tmux 안팎에서 일관되게 동작한다.
- **As a** 기여자, **when** 마우스 이벤트 라우팅 로직을 이해하려 할 때, **then** Fleet 소비와 child 패스스루를 구분하는 명확한 정책이 존재한다.

## Functional Requirements

- Fleet TUI는 외부 터미널에 VT200과 SGR 마우스 프로토콜 시퀀스를 전송하여 마우스 이벤트 수신을 활성화한다.
- 마우스 이벤트는 다음 네 가지 시나리오에 따라 라우팅된다.
  1. 상단 Dedicated 영역 + child 마우스 OFF + normal buffer: Fleet이 scrollback을 직접 이동한다.
  2. 상단 Dedicated 영역 + child 마우스 OFF + alt buffer: 마우스 휠 이벤트를 화살표 키로 변환하여 child에 전달한다.
  3. 상단 Dedicated 영역 + child 마우스 ON: 좌표 보정 후 SGR 형식으로 child에 패스스루한다.
  4. 하단 Fleet PTY 영역: consume-only/no-op — scrollback 조작이 필요하지 않다.
- xterm headless의 입력 표면은 외부 터미널의 직접 입력과 분리되어 유지되며, Fleet TUI는 외부 터미널 마우스 프로토콜만 제어한다.
- fleet-tui는 generic TUI 엔진으로서 fleet-agent에 대한 런타임 의존성 없이 마우스 프로토콜 기능을 구현한다.

## Acceptance Criteria

- [ ] 외부 터미널에 VT200+SGR 마우스 프로토콜 시퀀스가 전송되는가?
- [ ] child 마우스 OFF 상태에서 normal buffer에서 휠 스크롤이 Fleet scrollback을 이동하는가?
- [ ] child 마우스 OFF 상태에서 alt buffer에서 휠 스크롤이 화살표 키로 변환되어 child에 전달되는가?
- [ ] child 마우스 ON 상태에서 SGR 이벤트가 좌표 보정 후 child에 패스스루되는가?
- [ ] tmux 내부와 외부에서 마우스 스크롤 동작이 일관되는가?
- [ ] vim, htop 등 child 마우스 애플리케이션이 정상 동작하는가?

## Decision Context

이 결정은 다음과 같은 제약과 합의 하에 남겨졌다.

세 가지 접근법이 검토되었다. 접근법 A는 Fleet이 모든 마우스 이벤트를 직접 소비하는 방식으로, 이는 vim, htop 등 child 마우스 애플리케이션을 완전히 무력화하여 거부되었다. 접근법 B는 모든 마우스 이벤트를 child에 패스스루하는 방식으로, 이는 normal buffer scrollback을 조작할 수 없어 Fleet의 핵심 가치를 포기하게 되어 거부되었다. 접근법 C(하이브리드)는 Fleet이 외부 터미널 마우스 프로토콜을 소유하되, child가 마우스 모드를 요청하면 좌표 보정 후 패스스루하는 방식으로 채택되었다.

tmux 특수 처리 시도 후 롤백이 있었다. tmux 내부에서 마우스 프로토콜을 OFF로 전환하는 옵션을 시도했으나, Fleet의 alt screen으로 인해 tmux의 copy-mode scrollback이 동작하지 않음을 확인했다. tmux가 화살표 키로 변환하더라도 child shell에서는 히스토리 탐색이 되어 스크롤 효과가 없었다. 결국 tmux 안/밖 동일하게 마우스 프로토콜 ON으로 롤백하여 일관성을 확보했다.

Claude Code 방식이 검토되었다. Claude Code는 마우스 프로토콜을 전부 ON으로 켜고 드래그(텍스트 선택)를 앱 내부에서 자체 구현하는 패턴을 사용한다. 그러나 앱 내부 텍스트 선택 시스템 구현은 대규모 작업으로 판단되어, 현재 단계에서는 Shift+드래그 타협으로 결정했다.

DECSET 1007(alternateScroll)이 검토되었다. 이는 마우스 프로토콜 없이 alt screen에서 휠을 화살표 키로 변환하는 방식으로, Ghostty와 Windows Terminal에서 기본 활성화된다. 그러나 normal buffer scrollback을 조작할 수 없어 Fleet의 핵심 가치인 shell 출력 이력 마우스 스크롤을 포기해야 하므로 기각되었다.

최종 결정은 다음과 같다. VT200+SGR 마우스 프로토콜을 상시 활성화하고, tmux 안/밖에서 동일하게 동작하도록 하며, 텍스트 선택은 Shift+드래그로 우회한다. xterm headless의 입력 표면은 외부 터미널과 분리하여 유지하고, fleet-tui는 generic TUI 엔진으로서 fleet-agent에 대한 런타임 의존성 없이 구현한다.

마우스 프로토콜 활성화로 인한 텍스트 선택 비활성화는 근본적인 제약이다. 마우스 프로토콜이 활성화되면 터미널의 모든 마우스 이벤트가 앱으로 전달되어 터미널의 기본 텍스트 선택이 비활성화된다. 이는 vim, tmux, htop 등 모든 마우스 지원 TUI에서 동일한 제약이며, Shift 키로 우회하는 것이 표준 패턴이다.

## Related

- [[wiki:prd-tui-keyboard-protocol-architecture]] — 같은 fleet-tui 입력 계층의 키보드 프로토콜 아키텍처 결정