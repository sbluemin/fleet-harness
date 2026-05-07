---
id: "fleet-wiki-cli-onboarding-source"
created: "2026-05-07T14:06:54.866Z"
sourceType: "inline"
title: "fleet-wiki CLI 사용법 온보딩 (cli.ts + --help 출력 + 안전장치 노트)"
tags: ["fleet-wiki-web", "cli", "onboarding", "current"]
contentHash: "5a58e05e"
---
대원수 요청으로 작성된 fleet-wiki CLI 온보딩 자료. 출처:

1) packages/fleet-wiki-web/src/cli.ts (CliMode 분기, parseCliArgs, --help 본문, --stop 경로)
2) `node packages/fleet-wiki-web/dist/cli.mjs --help` 실행 출력
3) packages/fleet-wiki-web/src/lock.ts (lock 파일 경로 규칙, FleetWikiLock 스키마)
4) packages/fleet-wiki-web/src/stale.ts (stale lock 자동 재시작, isLockTrustworthyForRestart)
5) packages/fleet-wiki-web/AGENTS.md (security headers, Origin guard, lockfile O_EXCL/0700/0600)
6) Admiral session log 2026-05-07: --stop/--help 도입 커밋 72581264 (fix(fleet-wiki-web): add --stop and --help CLI options with cwd and pid safety guards)

대상 독자: fleet-wiki 백엔드를 처음 띄우거나 종료하려는 Admiral. fleet-wiki는 fleet-wiki-web 패키지의 CLI 진입점이며, .fleet/knowledge 워크스페이스를 cwd-키 lockfile로 잠가 단일 인스턴스를 보장하는 detached HTTP 서버다.