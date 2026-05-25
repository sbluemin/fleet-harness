---
id: "prd-fleet-menu-t3-full-source"
created: "2026-05-25T05:40:19.839Z"
sourceType: "inline"
title: "PRD: Fleet Menu T3 풀 구현 (Authentication / Wiki Server / Diagnostics / About)"
tags: ["prd", "fleet-menu", "mission-control", "panel-stack", "auth", "wiki-server", "diagnostics", "about", "fleet-infra-log"]
contentHash: "783a2fe4"
---
Fleet Menu T3 풀 구현 작업 결과 종합:
- Wave 1: 공통 panel stack, breadcrumb, native input modal (text/password/numeric/confirm)
- Wave 2: Authentication panel — @dotobokuri/fleet-infra/auth 재사용, password masking, D 키 delete + confirm modal
- Wave 3: Wiki Server panel — detached subprocess spawn + stdio:"ignore" + unref, Enter toggle, P 키 port modal (1024-65535), lock-file polling actual listen port
- Wave 4: Diagnostics panel — log viewer via @dotobokuri/fleet-infra/log/reader (O_NOFOLLOW + fstat + size cap), data dir, reset preset (전체 startup preset 초기화 + confirm modal), system info. Cursor Sync 중복 노출 금지
- Wave 5: About panel — full FLEET banner + 버전/채널 + 3-count (carriers/wiki/queued) + docs placeholder + Node info. 4번째 count 발명 금지
- Wave 6: integration/tests/docs

제독 PD 결정 6건:
1. wiki port는 transient (영속 저장 대상 아님)
2. server discovery는 panel 관리 서버만 인식
3. reset preset은 전체 startup preset 초기화
4. log 기본 100 lines + multiline grouping 비활성
5. About 3-count 유지 (4번째 발명 금지)
6. docs URL placeholder 유지

아키텍처: PanelStack + welcome banner shell 합성 (panel 모드도 full banner), 2단계 navigation + breadcrumb, Esc 단계별 복귀

신규 public API: @dotobokuri/fleet-infra/log/reader — AGENTS.md I/O Gateway Contract 준수, host UI direct fs read 금지 원칙

보안: API key masking, sanitizeTerminalText (ANSI/OSC/control + LF/CR strip), log read O_NOFOLLOW + fstat, port validation, detached subprocess no-IPC spawn