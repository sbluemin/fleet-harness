---
id: "guide-007-package-structure-admiral-runtime-source"
created: "2026-06-14T12:06:45.215Z"
sourceType: "inline"
title: "Admiral directive — post-change package structure (admiral-agent-runtime consolidation)"
tags: ["guide", "fleet-harness", "architecture", "package-structure", "fleet-admiral", "fleet-console", "target"]
contentHash: "4088997b"
---
대원수 지시(2026-06-14): admiral-agent-runtime 이관 이후의 fleet-harness 패키지 구조를 Fleet Wiki에 자유 형식으로 정리(wiki-history PRD 스키마 예외, template-freestyle 신설).

결정: fleet-cli가 단독 보유하던 3개 능력 — ①Agent CLI 실행(launch spec 빌드: 프로파일 해석·바이너리 해석·args/env/cwd 구성), ②Fleet 플러그인/페르소나 렌더(~/.fleet/marketplace 및 프로젝트 .fleet), ③in-process MCP 서버 조립 + executor 세션/토큰 발급 — 을 정책 패키지 fleet-admiral로 일반화 이관(fleet-admiral 확장, 신규 패키지 아님). 목표: fleet-console이 fleet-cli를 자식 프로세스로 spawn하던 우회를 제거하고 fleet-admiral API로 직접 agent-cli를 실행하는 self-contained 호스트가 된다.

아키텍처 판정: Nimitz Task Force(claude-kimi·codex·opencode-go 수렴). PTY/프로세스 spawn/렌더 lifecycle은 각 호스트 잔류(fleet-admiral은 launch spec 빌더 경계까지만 소유). fleet-admiral은 fleet-infra를 직접 import하지 않고 auth/data-dir/lock/codex-runner/hook-exec를 create*(deps) DI로 주입. 시스템 프롬프트 빌더는 이미 fleet-admiral 소유, 주입 로직이 동반 이관. 메타포/시스템프롬프트 토글 UI는 호스트 잔류.

실행 계획 보유: .fleet/plans/admiral-agent-runtime.md. 브랜치: feat/admiral-agent-runtime(canary 기준). 상태: 결정·계획 완료, 구현 진행 중(목표 구조).