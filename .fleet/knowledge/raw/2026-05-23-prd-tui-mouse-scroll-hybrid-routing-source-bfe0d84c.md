---
id: "prd-tui-mouse-scroll-hybrid-routing-source"
created: "2026-05-23T15:39:52.623Z"
sourceType: "inline"
title: "PRD: Fleet TUI Mouse Scroll Hybrid Routing"
tags: ["fleet-tui", "fleet-agent", "mouse-protocol", "scroll", "architecture", "shipped"]
contentHash: "bfe0d84c"
---
# Decision Record — Fleet TUI Mouse Scroll Hybrid Routing

## Previous State
Fleet TUI dedicated-cli에 마우스 입력 처리가 전혀 없었다. DECSET 마우스 시퀀스 미전송, SGR 파서 없음, 마우스 이벤트 라우팅 없음. 사용자는 Dedicated PTY의 shell 출력 이력을 마우스 휠로 탐색할 수 없었다.

## Structural Cause
Fleet TUI는 "터미널 안의 터미널" — 외부 터미널 위에 alt screen + xterm headless 기반의 자체 scrollback을 운영한다. 터미널/tmux의 기본 scrollback은 Fleet의 렌더링 출력 이력이지, Dedicated PTY child의 출력 이력이 아니다. 따라서 Fleet이 직접 마우스 프로토콜을 소유해야 xterm headless scrollback을 조작할 수 있다.

## Hybrid Routing Decision
세 가지 접근법(A: Fleet 직접 소비, B: child 패스스루, C: 하이브리드)을 평가. A는 vim/htop 등 child 마우스 앱을 무력화, B는 normal buffer scrollback 불가. C(하이브리드)가 채택됨 — Fleet이 외부 터미널 마우스 프로토콜을 소유하되, child가 마우스 모드를 요청하면 좌표 보정 후 패스스루.

## Routing Matrix
- 상단 Dedicated + child mouse OFF + normal buffer → Fleet이 scrollback 직접 이동
- 상단 Dedicated + child mouse OFF + alt buffer → 화살표 키 변환하여 child에 전달
- 상단 Dedicated + child mouse ON → 좌표 보정 후 SGR 패스스루
- 하단 Fleet PTY → consume-only/no-op (내용이 적어 스크롤 불필요)

## tmux Special Handling Attempt and Rollback
tmux 내부에서 마우스 프로토콜을 OFF로 전환하는 mouseEnabled 옵션을 구현했으나, Fleet의 alt screen으로 인해 tmux의 copy-mode scrollback이 동작하지 않음을 확인. tmux가 화살표 키로 변환하지만 child shell에서는 히스토리 탐색이 되어 스크롤 효과 없음. 결국 tmux 안/밖 동일하게 마우스 프로토콜 ON으로 롤백.

## Claude Code Pattern Review
Claude Code가 마우스 프로토콜을 전부 ON으로 켜고, 드래그(텍스트 선택)를 앱 내부에서 자체 구현하는 패턴을 조사. 앱 내부 텍스트 선택 시스템 구현은 대규모 작업으로, 현재 단계에서는 Shift+드래그 타협으로 결정.

## DECSET 1007 (alternateScroll) Review
마우스 프로토콜 없이 alt screen에서 휠을 화살표 키로 변환하는 방식. Ghostty/Windows Terminal에서 기본 활성화. 하지만 normal buffer scrollback을 조작할 수 없어 Fleet의 핵심 가치(shell 출력 이력 마우스 스크롤)를 포기해야 하므로 기각.

## Final Decision
VT200+SGR (?1000h+?1006h) 상시 활성화, tmux 안/밖 동일 동작, 텍스트 선택은 Shift+드래그로 타협. xterm headless의 disableStdin:true 유지, fleet-tui는 generic TUI 엔진으로서 fleet-agent 의존성 없이 구현.

## Fundamental Trade-off
마우스 프로토콜이 활성화되면 터미널의 모든 마우스 이벤트가 앱으로 전달되어 터미널의 기본 텍스트 선택이 비활성화된다. 이것은 vim, tmux, htop 등 모든 마우스 지원 TUI에서 동일한 제약이며, Shift 키로 우회하는 것이 표준 패턴이다.