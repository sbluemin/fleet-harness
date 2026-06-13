---
id: "prd-fleet-cli-native-terminal-exclusive-mode-source"
created: "2026-06-13T07:06:36.206Z"
sourceType: "inline"
title: "PRD: fleet-cli native terminal exclusive mode 및 전역 단축키/모드 폐기"
tags: ["decision-history", "fleet-cli", "native-terminal", "exclusive-mode", "keyboard", "mouse", "pty", "cognitive-debt"]
contentHash: "f2d75ca1"
---
fleet-cli `fleet --native` 터미널 독점 모드 + 글로벌 단축키/모드 폐기 작업의 결정 히스토리. Fleet Wiki 신규 엔트리(decision-history/PRD)를 patch queue로 제안.

<doc_type>wiki-create</doc_type>
<audience>contributors</audience>
<scope>
인지부채 해소용 "왜" 결정 기록(코드 grounded 문서 아님). 다음 결정 맥락을 담을 것:
- 배경: 기존 fleet-cli는 외부 터미널 위 alt-screen + xterm-headless 합성 2-pane 구조라, 마우스 드래그 선택이 구조적으로 제약됨(decision-fleet-cli-mouse-input 참조). `fleet --native`는 이 합성 레이어를 우회해 자식 Agent CLI에 실 TTY를 양도하는 독점 모드.
- 결정 1 — 별도 부팅 경로: `--native`(낶부명 nativeTerminal)는 runApp과 분리된 runNativeApp 경로. 기존 2-pane runApp 무회귀.
- 결정 2 — 이름 충돌 해소: 기존 SessionOptions.native / FLEET_NATIVE(= Fleet 시스템프롬프트/MCP 주입 스킵)와 신규 nativeTerminal(터미널 독점 부팅)은 완전 별개 기능. 물변경 보존.
- 결정 3 — 단축키/모드 전역 폐기: Ctrl+C/Q/T 호스트 인터셉트와 SIGINT 가로채기, MIRROR/DEDICATED 모드 시스템을 native/non-native 공통 폐기. Fleet 종료는 런처 Exit/자식 lifecycle에 위임(글로벌 종료 단축키 없음). raw mode라 터미널 기본 Ctrl+C는 원래 SIGINT를 안 만들고 호스트가 0x03을 잡던 구조였음.
- 결정 4 — stdio:inherit → node-pty raw passthrough 전환: 초기엔 child_process stdio:"inherit"로 구현했으나, carrier mid-session reminder를 자식 stdin에 주입할 수 없는 한계(inherit는 부모가 자식 stdin 핸들 없음) 때문에 node-pty raw passthrough로 재설계. 자식이 진짜 PTY(TTY) 소유 + fleet이 master로 양방향 중계 + reminder 주입. 단 PtyHost.write의 encodeTerminalInput은 CSI-u를 변형하므로 우회(ipty.write 직접).
- 결정 5 — 트레이드오프: stdin pipe([pipe,inherit,inherit])는 자식 stdin이 비-TTY가 되어 raw/마우스가 깨질 위험으로 기각. node-pty passthrough가 자식 TTY 보존 + 주입 가능의 최적해.
- 입력/마우스는 실 터미널 검증이 유일 판정이라는 교훈 유지. SIGKILL은 catch 불가(잔여 리스크).
관련 항목으로 [[wiki:decision-fleet-cli-mouse-input]], [[wiki:prd-tui-keyboard-protocol-architecture]] 링크. 스키마/템플릿(prd 등) 컨벤션 준수. 승인은 Admiral 게이트이므로 patch queue 제안까지만.
</scope>